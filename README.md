# timeseries-zarr-reader

A framework-agnostic TypeScript library that reads TS-Zarr bundles, Zarr v3 hierarchies
of electrophysiology time series with precomputed statistics at several resolutions, in
the browser or Node, and produces per-channel segments sized for canvas rendering.

The library takes a Zarr `Store` and yields `Segment` and `EventWindow` async iterables.
Level selection, min/max resampling to the pixel grid, bipolar montages, Butterworth
filtering, and event reads all run client-side. A server only has to serve bytes with
HTTP `Range` support.

The bundle format is the
[TS-Zarr 1.0 specification](https://github.com/Pennsieve/timeseries-zarr-paper/blob/main/bundle-format.md),
published in `timeseries-zarr-paper`. The reference producer is
[`timeseries-zarr-py`](https://github.com/Pennsieve/timeseries-zarr-py). This reader
implements specification version 1.x and rejects a bundle of any other major version,
including the unversioned layout written before 1.0.

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

// Annotations, detector output, and sorted spikes are event channels.
for await (const events of client.queryEvents({
  channels: channels.filter((c) => c.kind === "event").map((c) => c.id),
  startUs: first.startUs,
  endUs: first.startUs + 60_000_000,
})) {
  mark(events);
}
```

## What a caller needs to know

- All times are microseconds from the bundle's origin, its time zero. `recording()`
  returns the origin's wall-clock time when the bundle records one; add it to a bundle
  time to label an axis. Sample values stay in each channel's recorded physical unit.
- `channelInfo()` lists continuous and event channels together. Narrow on `kind`.
- The reader picks the coarsest pyramid level that fits the requested pixel width. A
  montage, a filter, or `raw: true` forces a raw read instead.
- Reads of the raw level are capped at 15 MB per query and reject with
  `RawReadTooLargeError` before fetching, whether a filter, a montage, or `raw: true`
  forced the raw level or the pixel width selected it.
- Segments are delivered on bin boundaries, so a segment can start before `startUs`
  and run past `endUs`.
- Filters carry state across consecutive windows, so a trace read window by window
  matches the same trace read whole.
- `query()` reads continuous channels. Event channels are read with `queryEvents()`,
  and a dense one's per-bin counts with `eventCounts()`.

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
`scripts/generate-test-bundle.py` documents its contents and rewrites it with
`timeseries-zarr-py`. `src/reference-bundle.test.ts` also reads the specification's
reference bundle from a `timeseries-zarr-paper` checkout beside this one, or from
`TSZ_REFERENCE_BUNDLE`, and is skipped when neither exists.

## License

Apache-2.0. See [LICENSE](LICENSE).
