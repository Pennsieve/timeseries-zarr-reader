# timeseries-zarr-reader

A TypeScript library that reads pyramid Zarr v3 bundles of electrophysiology
time series in the browser or Node, and produces per-channel segments sized for
canvas rendering. Provided with no JavaScript framework dependencies.

The library takes a Zarr `Store` and yields `Segment` and `EventBatch` async iterables.
Level selection, min/max resampling to the pixel grid, bipolar montages, Butterworth
filtering, and spike reads all run client-side. A server only has to serve bytes with HTTP
`Range` support.

The bundle format is written and specified by
[`timeseries-zarr-py`](https://github.com/Pennsieve/timeseries-zarr-py/blob/main/docs/bundle-format.md).

## Installation

```sh
pnpm add @pennsieve/timeseries-zarr-reader
```

ESM only, Node 20 or later. In the browser, use any bundler that resolves the `exports`
map.

## Quick start

```ts
import { StreamingClient, openBundle } from "@pennsieve/timeseries-zarr-reader";

const client = new StreamingClient({
  store: await openBundle("https://example.org/recording.zarr"),
});

const channels = await client.channelInfo();
const continuous = channels.filter((c) => c.kind === "continuous");
const [first] = continuous;
if (!first) throw new Error("bundle has no continuous channels");

// One Segment per channel: raw samples at fine pixel widths, interleaved
// [min, max, ...] envelope pairs at coarse ones.
for await (const segment of client.query({
  channels: continuous.map((c) => c.id),
  startUs: first.startUs,
  endUs: first.startUs + 60_000_000,
  pixelWidthUs: 50_000, // 60 s across 1200 pixels
})) {
  draw(segment);
}
```

## What a caller needs to know

- All times are UTC microseconds. Sample values stay in each channel's recorded physical
  unit.
- The reader picks the coarsest pyramid level that fits the requested pixel width. A
  montage, a filter, or `raw: true` forces a raw read instead.
- Forced-raw reads are capped at 15 MB and reject with `RawReadTooLargeError` before
  fetching. A read that lands on the raw level through zoom alone is not capped.
- Segments are delivered on bin boundaries, so one can start before `startUs` and run
  past `endUs`.
- Filters carry state across consecutive windows, so a trace read window by window
  matches the same trace read whole.
- `query()` reads continuous channels. Unit channels are read with `queryUnits()`.

The full reference is in [docs/api.md](./docs/api.md), including custom stores for
authentication and caching.

## Development

pnpm, Vitest with v8 coverage, TypeScript strict with ESM and `nodenext` resolution,
ESLint and Prettier.

```sh
pnpm check         # the gate: eslint + prettier --check + tsc --noEmit + vitest + build
pnpm test          # vitest only
pnpm build         # tsc -p tsconfig.build.json -> dist/
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint --fix + prettier --write (rewrites files)
pnpm format:check  # prettier --check (read-only)
```

`src/index.ts` re-exports the public API and `src/client.ts` holds `StreamingClient`.
Tests sit beside the module they cover, as `src/<module>.test.ts`. The acceptance tests
read `test-data/sample.zarr`, a small bundle committed to the repository;
`scripts/generate-test-bundle.py` documents its contents and rewrites it from a
`timeseries-zarr-py` checkout.

## License

Apache-2.0. See [LICENSE](LICENSE).
