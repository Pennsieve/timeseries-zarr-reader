# timeseries-zarr-reader

A TypeScript library that reads pyramid Zarr v3 bundles of electrophysiological
time-series data in the browser or Node.js. It produces per-channel segments sized for
canvas rendering and has no framework dependencies.

The library consumes a Zarr `Store` and yields `Segment` and `Event` async iterables.
Level selection, min/max resampling to the pixel grid, bipolar montages, Butterworth
filtering, and spike reads all run client-side; the server only needs to serve bytes
with HTTP `Range` support. The on-disk bundle format is defined in and produced by
[`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py).

## Installation

```sh
pnpm add @pennsieve/timeseries-zarr-reader
# or
npm install @pennsieve/timeseries-zarr-reader
```

## Quick start

```ts
import { StreamingClient, openBundle } from "@pennsieve/timeseries-zarr-reader";

const client = new StreamingClient({
  store: await openBundle("https://example.org/recording.zarr"),
});

// query() reads continuous channels; unit channels are read with queryUnits().
const channels = await client.channelInfo();
const continuous = channels.filter((c) => c.kind === "continuous");

// One Segment per channel: raw samples, or interleaved [min, max, ...]
// envelope pairs when the zoom level calls for decimated output.
for await (const segment of client.query({
  channels: continuous.map((c) => c.id),
  startUs: continuous[0].startUs,
  endUs: continuous[0].startUs + 60_000_000, // 60 s window
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

Takes `{ store, filterMaxBytes? }`. `store` is any object that implements the `Store`
type. `filterMaxBytes` sets the default byte cap for raw-level reads (default 15 MB).

### `channelInfo()`

Returns a `ChannelInfo` array with `id`, `name`, `unit`, `rateHz`, `startUs`, `endUs`,
and `kind` (`"continuous"` or `"unit"`) for every channel in the bundle.

### `query(params)`

Returns an async iterable of `Segment`, one per requested trace, in request order.
Required params: `channels`, `startUs`, `endUs`, and `pixelWidthUs`. Options:

- `montage`: `{ lead, secondary }` pairs. Each rendered trace is `lead - secondary`,
  sample by sample. When present, the pairs replace `channels` as the query's traces.
- `filter`: a Butterworth `FilterSpec` (`lowpass`, `highpass`, `bandpass`, or
  `bandstop`) applied to every trace.
- `minMax`: set to `false` to receive raw samples with no decimation or resampling.
- `filterMaxBytes`: byte-cap override for this query.
- `signal`: an `AbortSignal` that cancels in-flight reads.

The reader picks the coarsest pyramid level whose bins fit within one pixel. A montage,
a filter, or `minMax: false` forces a read of the raw level. If a forced-raw read would
exceed the byte cap, `query()` throws `FilterWindowTooWide` before fetching anything;
the error carries `requestedBytes` and `maxBytes`. Narrow the window or pass a larger
`filterMaxBytes` to proceed.

`query()` throws for unit channels; read those with `queryUnits()`.

### `queryUnits(params)`

Returns an async iterable of `Event`, one per requested unit channel. Each event batch
holds ascending timestamps within the window. Waveform samples (`pointsPerEvent` values
per event, row-major) are included only when the zoom level gives one waveform more
than ten pixels of width.

### `getSegmentSpans(params)`

Returns `[startUs, endUs)` spans where one continuous channel has data, clamped to the
window. Spans come from the coarsest pyramid level, so their edges are as coarse as
that level's bins. Gaps no wider than `gapThresholdUs` are bridged into one span.

### `openBundle(url)` and stores

The reader performs no network or filesystem I/O of its own; all reads go through a
`Store`. `openBundle(url)` picks a built-in store by scheme:

- `http://` and `https://` URLs get `FetchStore`, which is also exported.
- `file://` URLs and absolute paths get a filesystem store. That store is imported
  lazily and is not included in browser bundles.

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
must implement `getRange`, including the suffix form: every array in a bundle is
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

Tests are co-located as `src/<module>.test.ts`. Acceptance tests read
`test-data/sample.zarr`, a small committed bundle produced by the real writer.
`scripts/generate-test-bundle.py` documents the bundle's exact contents and regenerates
it from a [`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py) checkout.
