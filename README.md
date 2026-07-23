# timeseries-zarr-reader

A framework-agnostic TypeScript library that reads pyramid Zarr v3
bundles of electrophysiological time series data directly in the browser (or Node.js)
and produces per-channel time series segments for canvas rendering.

It takes a Zarr `Store` and yields generic `Segment`/`Event` async iterables.

The on-disk bundle format is defined in and produced by [`ts-zarr-py`](https://github.com/Pennsieve/ts-zarr-py).

## Tooling

- **pnpm** (package manager)
- **Vitest** (test runner, v8 coverage)
- **TypeScript** strict (`tsc --noEmit` type gate)
- **ESLint + Prettier** (lint/format)

### Common Commands

```
pnpm check         # the gate: eslint + prettier --check + tsc --noEmit + vitest
pnpm test          # vitest only
pnpm typecheck     # tsc --noEmit (strict)
pnpm lint          # eslint --fix + prettier --write (mutating; dev convenience)
pnpm format:check  # prettier --check (read-only)
```
