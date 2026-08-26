# API reference

All timestamps and durations are UTC microseconds: `startUs`, `endUs`, `pixelWidthUs`,
`samplePeriodUs`. Sample values stay in each channel's physical unit, as recorded. Time
windows are half-open, `[startUs, endUs)`.

## `new StreamingClient(options)`

Takes `{ store, maxRawBytes?, maxCacheBytes?, maxInflightFetches?,
maxConcurrentRequests? }`. `store` is any
object implementing the `Store` type. `maxRawBytes` caps forced-raw reads (a filter, a
montage, or `raw: true`), 15 MB by default, and each query can override it; a read that
selects the raw level through zoom alone is not capped. `maxCacheBytes` caps the
client's cache of store responses, 64 MiB by default. Zero removes the cache layer;
identical in-flight reads still collapse, same-microtask ranges still merge, and the
bundle root is read twice on open. `maxInflightFetches` caps level reads in
flight, 64 by default. `maxConcurrentRequests` caps the requests those reads turn into
once identical reads have collapsed and adjacent ranges have merged, also 64 by
default. Lower it for a store that throttles.

The option-bag types are exported: `StreamingClientOptions`, `QueryOptions`,
`UnitQueryOptions`, and `DataSpanOptions`.

## `channelInfo()`

Returns a `ChannelInfo` array covering every channel in the bundle, with `id`, `name`,
`unit`, `rateHz`, `startUs`, `endUs`, and `kind` (`"continuous"` or `"unit"`). `endUs`
is exclusive, one period past the last sample. A unit channel reports `endUs` equal to
`startUs`.

## `query(options)`

Returns an async iterable of `Segment`, one per requested trace, in request order.

`startUs`, `endUs`, and `pixelWidthUs` are required. Pass either `channels` or `montage`
to name the traces:

- `channels`: channel ids, one trace each.
- `montage`: `{ lead, secondary }` pairs. Each trace is `lead - secondary`, sample by
  sample. The returned segment's `channel` is the compound key
  `{leadId}_{leadName}<->{secondaryName}`. The pair must share a sample rate, and the
  two sample grids must align: equal periods, with starts a whole number of periods
  apart. The read covers the pair's shared extent.

Passing both or neither throws. The rest of the options:

- `filter`: a Butterworth `FilterSpec` (`lowpass`, `highpass`, `bandpass`, or
  `bandstop`) applied to every trace. `order` is an integer from 1 to 12. Frequencies
  must lie strictly between 0 and the channel's Nyquist frequency, and the band forms
  require `lowHz < highHz`. A spec outside those bounds rejects with `RangeError`.
- `raw`: `true` returns raw samples with no decimation or resampling. Defaults to `false`.
- `maxRawBytes`: byte-cap override for this query.
- `signal`: an `AbortSignal` that cancels in-flight reads.

`query()` rejects unit channels. Read those with [`queryUnits()`](#queryunitsoptions).

### Level selection

The reader picks the coarsest pyramid level whose bins fit within one pixel, falling
back to the finest level when none fits. Segments from a coarse level carry interleaved
`[min, max, ...]` envelope pairs and set `isMinMax`; segments from the raw level carry
samples.

A montage, a filter, or `raw: true` forces a read of the raw level. Coarse levels are
already decimated, so they cannot be filtered or differenced exactly.

A segment is resampled onto the pixel grid only when one pixel spans more than 3 source
bins. Below that ratio the segment comes back as fetched, at the level's own resolution, so
read `samplePeriodUs` off the segment rather than assuming it equals `pixelWidthUs`. The
pixel grid is anchored at the channel start (the lead channel's start for a montage), so
every window over a channel resamples onto the same buckets and adjacent windows tile one
bucket apart.

### The raw-read byte cap

`maxRawBytes` bounds every forced-raw read. The figure counted is the uncompressed size of
the samples requested, summed across traces, and both sides of a montage pair count.

A read over the cap rejects with `RawReadTooLargeError` before fetching anything. The
error carries `requestedBytes` and `maxBytes`. Narrow the window or raise `maxRawBytes`.

### The response cache

A client caches the store responses it reads, bounded by `maxCacheBytes` and evicted
least recently used first. Bundles are immutable, so a hit is never revalidated.

An inner chunk covers more time than one query window, so windows that pan or page
across a bundle read the same chunks. The cache is what keeps those reads off the
network. Sizing it below one window's working set makes every window evict the one
before it, so raise it rather than leave it thrashing.

Array metadata does not go through the cache at all. The client reads the root
`zarr.json` once and serves every array's metadata out of its consolidated block, so a
query fetches chunk bytes and nothing else.

Callers that ask for the same bytes while a read is already in flight share that read
rather than issuing their own, so concurrent queries over overlapping windows fetch
each chunk once. One caller aborting rejects that caller promptly and leaves the
read running for the rest. The request itself is cancelled once every caller waiting on
it has aborted, so a discarded viewport stops consuming the connection. A caller that
passes no signal cannot abort, and holds the read to completion for everyone.

### Round trips per query

A query reads one level per trace, and each read costs at least one round trip. Reads run
under `maxInflightFetches`, so a query serializes into `ceil(traces / maxInflightFetches)`
rounds. Against a store with 200 ms of latency, 64 traces at a cap of 8 spend 1.6 seconds
in round trips alone, whatever the bytes involved. Keep the cap at or above the number of
traces a view puts on screen.

Reads are admitted highest priority first. A query takes `priority`, one of `viewport`,
`prefetch` or `background`, defaulting to `viewport`; `dataSpans` defaults to
`background`. That union is exported as `ReadPriority`. A lower priority holds only part
of the pool, so a survey submitted before the first viewport read cannot take every slot,
and a priority with nothing running is admitted ahead of the order, so none waits
forever. Order within one priority is the order of submission.

Ranged reads of one key issued together are merged into one read, so a trace spanning
several inner chunks of a shard costs one request rather than one per chunk. Merging is
decided before the request cap applies, so waiting for a slot delays a request without
splitting a batch.

### Delivery boundaries

Segments are delivered on bin boundaries. A segment's `startUs` is the start of the first
bin overlapping the window, and its data can run up to one bin past `endUs`. A window
overlapping no data yields a segment with empty `data` and a `startUs` clamped to the
nearest channel edge.

A gap inside the window arrives as NaN values inside the one segment; `query()` never
splits a trace into several segments. A resampled pixel bucket with no finite value
comes back as a `[NaN, NaN]` pair, so gaps stay visible at every zoom.

`query()` is an async generator. Validation happens on the first iteration, not on the
call, so wrap the `for await` loop in `try`/`catch` rather than the call itself. A
non-positive `pixelWidthUs`, a window with `endUs < startUs`, and an already-aborted
`signal` all reject there.

### Filter state

A filter is stateful. The client holds that state for its lifetime, one filter per
(channel, filter spec, sample rate). A montaged trace keys its state by the compound
montage key, separate from either constituent channel. Consecutive windows filter as one
continuous signal, so a trace read window by window matches the same trace read whole. A
backward jump of more than one sample, or a gap wider than 100 samples, restarts the
filter for that channel.

A continuation is the one case where a segment does not start on a bin boundary. Reads
snap outward to bin boundaries, so two windows meeting between samples both cover the
sample at the seam. A filtered continuation drops that repeated sample and starts one
sample later. A continuation narrower than one sample returns empty data.
`channelInfo()` reports each channel's sample rate, for callers that want windows landing
on sample boundaries.

## `queryUnits(options)`

Returns an async iterable of `EventBatch`, one per requested unit channel. Takes
`channels`, `startUs`, `endUs`, `pixelWidthUs`, an optional `priority` (defaulting to
`"viewport"`), and an optional `signal`.

Each batch holds ascending timestamps within the window. Waveform samples
(`pointsPerEvent` values per event, row-major) are included only when the window holds
events and one waveform spans more than 10 pixels. Otherwise `pointsPerEvent` is 0 and
`data` is empty.

## `dataSpans(options)`

Returns a promise for the `[startUs, endUs)` spans where one continuous channel has data,
clamped to the window. Takes `channel`, `startUs`, `endUs`, an optional `gapThresholdUs`,
an optional `priority` (defaulting to `"background"`), and an optional `signal`.

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
