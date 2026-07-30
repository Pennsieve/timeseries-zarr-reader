# timeseries-zarr-reader

A framework-agnostic TypeScript library that reads pyramid Zarr v3
bundles of electrophysiological time series data directly in the browser (or Node.js)
and produces per-channel time series segments for canvas rendering.

It takes a Zarr `Store` and yields generic `Segment`/`Event` async iterables. Level
selection, min/max resampling to the pixel grid, bipolar montages, Butterworth
filtering, and spike/unit reads all happen client-side; the server only has to serve
bytes with HTTP `Range` support.

The on-disk bundle format is defined in and produced by [`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py).

## Usage

```ts
import { StreamingClient, openBundle } from "@pennsieve/timeseries-zarr-reader";

const client = new StreamingClient({
  store: await openBundle("https://example.org/recording.zarr"),
});

const channels = await client.channelInfo();

// One Segment per channel: raw samples, or interleaved [min, max, ...] envelope
// pairs when the zoom level calls for decimated output.
for await (const segment of client.query({
  channels: channels.map((c) => c.id),
  startUs: channels[0].startUs,
  endUs: channels[0].startUs + 60_000_000, // 60 s window
  pixelWidthUs: 50_000, // 60 s across 1200 pixels
})) {
  draw(segment);
}
```

Times are UTC microseconds throughout; sample values stay in physical units.

- **Montage / filter:** pass `montage: [{ lead, secondary }]` pairs or a Butterworth
  `filter` spec to `query()`. Both force a raw-level read, which is refused with
  `FilterWindowTooWide` past a byte cap (default ~15 MB) rather than silently spending
  bandwidth; re-issue with `filterMaxBytes` raised to override per query.
- **Spikes:** `queryUnits()` yields `Event` batches; waveforms are fetched only when
  zoomed in far enough for one waveform to span more than ten pixels.
- **Scrubber:** `getSegmentSpans()` reports data availability from the coarsest
  pyramid level.

## Stores

The reader never touches the network or filesystem directly - it consumes a `Store`:

```ts
type Store = {
  get(
    key: `/${string}`,
    opts?: { signal?: AbortSignal },
  ): Promise<Uint8Array | undefined>;
  getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: { signal?: AbortSignal },
  ): Promise<Uint8Array | undefined>;
};
```

`openBundle(url)` picks a built-in store by scheme: `http(s)://` gets the exported
`FetchStore`, and `file://` or an absolute path gets a filesystem store loaded on
demand so `node:fs` never enters a browser bundle. A custom store (authentication,
signing, caching) plugs into `new StreamingClient({ store })` directly - and **must
implement `getRange`**, including the suffix form, because every array in a bundle is
sharded and is read by ranged requests.

## Development

- **pnpm** (package manager)
- **Vitest** (test runner, v8 coverage)
- **TypeScript** strict, ESM, `nodenext` resolution
- **ESLint + Prettier** (lint/format)

```
pnpm check         # the gate: eslint + prettier --check + tsc --noEmit + vitest + build
pnpm test          # vitest only
pnpm build         # tsc -p tsconfig.build.json -> dist/
pnpm typecheck     # tsc --noEmit (strict)
pnpm lint          # eslint --fix + prettier --write (mutating; dev convenience)
pnpm format:check  # prettier --check (read-only)
```

Tests are co-located as `src/<module>.test.ts`. Acceptance tests read
`test-data/sample.zarr`, a small committed bundle produced by the real writer;
`scripts/generate-test-bundle.py` documents its exact contents and regenerates it
from a [`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py) checkout.
