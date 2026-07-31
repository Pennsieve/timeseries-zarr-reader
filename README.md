# timeseries-zarr-reader

A TypeScript library that reads pyramid Zarr v3 bundles of electrophysiological
time-series data in the browser or Node.js. It produces per-channel segments sized for
canvas rendering and has no framework dependencies.

The library consumes a Zarr `Store` and yields `Segment` and `EventBatch` async
iterables. Level selection, min/max resampling to the pixel grid, bipolar montages,
Butterworth filtering, and spike reads all run client-side. The server only needs to
serve bytes with HTTP `Range` support. The bundle format is specified and written by
[`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py).

## Installation

The package is not published yet. Once it is, install it with:

```sh
pnpm add @pennsieve/timeseries-zarr-reader
# or
npm install @pennsieve/timeseries-zarr-reader
```

Until then, consume it from a local checkout (`pnpm build`, then a `link:` or `file:`
dependency).

## Quick start

```ts
import { StreamingClient, openBundle } from "@pennsieve/timeseries-zarr-reader";

const client = new StreamingClient({
  store: await openBundle("https://example.org/recording.zarr"),
});

// query() reads continuous channels; unit channels are read with queryUnits().
const channels = await client.channelInfo();
const continuous = channels.filter((c) => c.kind === "continuous");
const [firstChannel] = continuous;
if (!firstChannel) throw new Error("bundle has no continuous channels");

// One Segment per channel: raw samples at fine pixel widths, interleaved
// [min, max, ...] envelope pairs at coarse ones.
for await (const segment of client.query({
  channels: continuous.map((c) => c.id),
  startUs: firstChannel.startUs,
  endUs: firstChannel.startUs + 60_000_000, // 60 s window
  pixelWidthUs: 50_000, // 60 s across 1200 pixels
})) {
  draw(segment);
}
```

## Times and units

All timestamps and durations (`startUs`, `endUs`, `pixelWidthUs`, `samplePeriodUs`) are
UTC microseconds. Sample values stay in each channel's physical unit, as recorded.

## API

### `new StreamingClient(options)`

Takes `{ store, maxRawBytes? }`. `store` is any object that implements the `Store` type.
`maxRawBytes` caps raw-level reads (15 MB by default). Each query can override it.

### `channelInfo()`

Returns a `ChannelInfo` array with `id`, `name`, `unit`, `rateHz`, `startUs`, `endUs`,
and `kind` (`"continuous"` or `"unit"`) for every channel in the bundle.

### `query(options)`

Returns an async iterable of `Segment`, one per requested trace, in request order.
Required options: `startUs`, `endUs`, and `pixelWidthUs`. Pass either `channels` or
`montage` to name the traces, not both:

- `channels`: channel ids to read, one trace each.
- `montage`: `{ lead, secondary }` pairs. Each rendered trace is `lead - secondary`,
  sample by sample.

Supplying both, or neither, throws. The remaining options are:

- `filter`: a Butterworth `FilterSpec` (`lowpass`, `highpass`, `bandpass`, or
  `bandstop`) applied to every trace.
- `raw`: set to `true` to receive raw samples with no decimation or resampling
  (default `false`).
- `maxRawBytes`: byte-cap override for this query.
- `signal`: an `AbortSignal` that cancels in-flight reads.

The reader picks the coarsest pyramid level whose bins fit within one pixel. A montage, a
filter, or `raw: true` forces a read of the raw level. Raw reads are capped by
`maxRawBytes`, counted as the uncompressed size of the samples requested and summed across
traces (both sides of a montage pair count). If a raw read would exceed the cap, the query
rejects with `RawReadTooLargeError` before fetching anything. The error carries
`requestedBytes` and `maxBytes`. Narrow the window or pass a larger `maxRawBytes` to
proceed.

`query()` is an async generator. It validates on the first iteration, not on the call.
Wrap the `for await` loop in `try`/`catch`, not the call.

Segments are delivered on bin boundaries. A segment's `startUs` is the start of the first
bin that overlaps the window, and its data can run up to one bin past `endUs`. A window
that overlaps no data yields a segment with empty `data`.

`query()` rejects for unit channels. Read those with `queryUnits()`.

### Filter state

A filter is stateful. The client holds that state for its lifetime, one filter per
(channel, filter spec, sample rate). Consecutive windows filter as one continuous signal.
A trace read window by window matches the same trace read whole. A jump backwards, or a
gap wider than a hundred samples, restarts the filter for that channel.

A continuation is the one case where a segment does not start on a bin boundary. Reads
snap outward to bin boundaries, so two windows meeting between samples both cover the
sample at the seam. A filtered continuation drops that repeated sample and starts one
sample later. A continuation narrower than one sample returns empty data. `channelInfo()`
reports each channel's sample rate, for windows that land on sample boundaries.

### `queryUnits(options)`

Returns an async iterable of `EventBatch`, one per requested unit channel. Takes
`channels`, `startUs`, `endUs`, `pixelWidthUs`, and an optional `signal`. Each batch
holds ascending timestamps within the window. Waveform samples (`pointsPerEvent` values
per event, row-major) are included only when one waveform spans more than ten pixels.
Otherwise `pointsPerEvent` is 0 and `data` is empty.

### `dataSpans(options)`

Returns a promise for the `[startUs, endUs)` spans where one continuous channel has data,
clamped to the window. Takes `channel`, `startUs`, `endUs`, an optional
`gapThresholdUs`, and an optional `signal`. Spans come from the coarsest pyramid level,
so their edges align to that level's bins. Gaps no wider than `gapThresholdUs` are bridged
into one span. The default of 0 splits on every gap.

### `openBundle(url)` and stores

The reader performs no network or filesystem I/O of its own. All reads go through a
`Store`. `openBundle(url)` picks a built-in store by scheme or path form:

- `http://` and `https://` URLs get `FetchStore`, which is also exported.
- `file://` URLs and absolute paths, POSIX (`/bundle.zarr`) or Windows drive-letter
  (`C:\bundle.zarr`), get the filesystem store. It is imported lazily and is not included
  in browser bundles.
- Relative paths and any other scheme throw.

`FileStore` is also exported on its own, from the `./node` subpath:

```ts
import { StreamingClient } from "@pennsieve/timeseries-zarr-reader";
import { FileStore } from "@pennsieve/timeseries-zarr-reader/node";

const client = new StreamingClient({
  store: new FileStore("/data/recording.zarr"),
});
```

### Custom stores

To add authentication, request signing, or caching, pass your own store to
`new StreamingClient({ store })`. The `Store`, `StoreOptions`, and `ByteRange` types
are exported:

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
`{ offset, length }` or `{ suffixLength }` for the last bytes of a key. A custom store
must implement `getRange`, including the suffix form. Every array in a bundle is
sharded and read with ranged requests. Both methods resolve to `undefined` for a
missing key.

## Development

- pnpm (package manager)
- Vitest (test runner, v8 coverage)
- TypeScript strict, ESM, `nodenext` resolution
- ESLint + Prettier

```
pnpm check         # eslint + prettier --check + tsc --noEmit + vitest + build
pnpm test          # vitest only
pnpm build         # tsc -p tsconfig.build.json -> dist/
pnpm typecheck     # tsc --noEmit (strict)
pnpm lint          # eslint --fix + prettier --write (rewrites files)
pnpm format:check  # prettier --check (read-only)
```

`src/index.ts` re-exports the public API. `src/client.ts` holds `StreamingClient`. Tests
sit beside the module they cover, as `src/<module>.test.ts`. The acceptance tests read
`test-data/sample.zarr`, a small bundle committed to the repository.
`scripts/generate-test-bundle.py` lists its contents and rewrites it from a `ts-zarr-py`
checkout.
