# API reference

All timestamps and durations are UTC microseconds: `startUs`, `endUs`, `pixelWidthUs`,
`samplePeriodUs`. Sample values stay in each channel's physical unit, as recorded. Time
windows are half-open, `[startUs, endUs)`.

## `new StreamingClient(options)`

Takes `{ store, maxRawBytes? }`. `store` is any object implementing the `Store` type.
`maxRawBytes` caps raw-level reads, 15 MB by default, and each query can override it.

## `channelInfo()`

Returns a `ChannelInfo` array covering every channel in the bundle, with `id`, `name`,
`unit`, `rateHz`, `startUs`, `endUs`, and `kind` (`"continuous"` or `"unit"`).

## `query(options)`

Returns an async iterable of `Segment`, one per requested trace, in request order.

`startUs`, `endUs`, and `pixelWidthUs` are required. Pass either `channels` or `montage`
to name the traces:

- `channels`: channel ids, one trace each.
- `montage`: `{ lead, secondary }` pairs. Each trace is `lead - secondary`, sample by
  sample.

Passing both or neither throws. The rest of the options:

- `filter`: a Butterworth `FilterSpec` (`lowpass`, `highpass`, `bandpass`, or
  `bandstop`) applied to every trace.
- `raw`: `true` returns raw samples with no decimation or resampling. Defaults to `false`.
- `maxRawBytes`: byte-cap override for this query.
- `signal`: an `AbortSignal` that cancels in-flight reads.

`query()` rejects unit channels. Read those with [`queryUnits()`](#queryunitsoptions).

### Level selection

The reader picks the coarsest pyramid level whose bins fit within one pixel. Segments from
a coarse level carry interleaved `[min, max, ...]` envelope pairs and set `isMinMax`;
segments from the raw level carry samples.

A montage, a filter, or `raw: true` forces a read of the raw level. Coarse levels are
already decimated, so they cannot be filtered or differenced exactly.

A segment is resampled onto the pixel grid only when one pixel spans more than 3 source
bins. Below that ratio the segment comes back as fetched, at the level's own resolution, so
read `samplePeriodUs` off the segment rather than assuming it equals `pixelWidthUs`.

### The raw-read byte cap

`maxRawBytes` bounds every forced-raw read. The figure counted is the uncompressed size of
the samples requested, summed across traces, and both sides of a montage pair count.

A read over the cap rejects with `RawReadTooLargeError` before fetching anything. The
error carries `requestedBytes` and `maxBytes`. Narrow the window or raise `maxRawBytes`.

### Delivery boundaries

Segments are delivered on bin boundaries. A segment's `startUs` is the start of the first
bin overlapping the window, and its data can run up to one bin past `endUs`. A window
overlapping no data yields a segment with empty `data`.

`query()` is an async generator. Validation happens on the first iteration, not on the
call, so wrap the `for await` loop in `try`/`catch` rather than the call itself.

### Filter state

A filter is stateful. The client holds that state for its lifetime, one filter per
(channel, filter spec, sample rate). Consecutive windows filter as one continuous signal,
so a trace read window by window matches the same trace read whole. A jump backwards, or a
gap wider than 100 samples, restarts the filter for that channel.

A continuation is the one case where a segment does not start on a bin boundary. Reads
snap outward to bin boundaries, so two windows meeting between samples both cover the
sample at the seam. A filtered continuation drops that repeated sample and starts one
sample later. A continuation narrower than one sample returns empty data.
`channelInfo()` reports each channel's sample rate, for callers that want windows landing
on sample boundaries.

## `queryUnits(options)`

Returns an async iterable of `EventBatch`, one per requested unit channel. Takes
`channels`, `startUs`, `endUs`, `pixelWidthUs`, and an optional `signal`.

Each batch holds ascending timestamps within the window. Waveform samples
(`pointsPerEvent` values per event, row-major) are included only when one waveform spans
more than 10 pixels. Otherwise `pointsPerEvent` is 0 and `data` is empty.

## `dataSpans(options)`

Returns a promise for the `[startUs, endUs)` spans where one continuous channel has data,
clamped to the window. Takes `channel`, `startUs`, `endUs`, an optional `gapThresholdUs`,
and an optional `signal`.

Spans come from the coarsest pyramid level, so their edges align to that level's bins.
Gaps no wider than `gapThresholdUs` are bridged into one span. The default of 0 splits on
every gap.

## `openBundle(url)`

Picks a built-in store by scheme or path form:

- `http://` and `https://` URLs get `FetchStore`, which is also exported.
- `file://` URLs and absolute paths, POSIX (`/bundle.zarr`) or Windows drive-letter
  (`C:\bundle.zarr`), get the filesystem store. It is imported lazily and stays out of
  browser bundles.
- Relative paths and any other scheme throw.

`FileStore` is also exported on its own, from the `./node` subpath:

```ts
import { StreamingClient } from "@pennsieve/timeseries-zarr-reader";
import { FileStore } from "@pennsieve/timeseries-zarr-reader/node";

const client = new StreamingClient({
  store: new FileStore("/data/recording.zarr"),
});
```

## Custom stores

Every read goes through a `Store`. The reader performs no network or filesystem I/O of its
own, so authentication, request signing, and caching all belong in a store you supply to
`new StreamingClient({ store })`. The `Store`, `StoreOptions`, and `ByteRange` types are
exported:

```ts
type Store = {
  get(key: `/${string}`, opts?: StoreOptions): Promise<Uint8Array | undefined>;
  getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined>;
};
```

`StoreOptions` carries an optional `AbortSignal`. `ByteRange` is either
`{ offset, length }` or `{ suffixLength }` for the last bytes of a key. Both methods
resolve to `undefined` for a missing key.

A custom store must implement `getRange`, including the suffix form. Every array in a
bundle is sharded, and reading a shard starts by reading its index from the end of the
object.
