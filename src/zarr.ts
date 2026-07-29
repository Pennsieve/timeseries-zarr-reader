import { get, NotFoundError, open, root, slice } from "zarrita";
import type { Store, StoreOptions } from "./types";

/**
 * Read a level's bins over a half-open index range.
 *
 * The only place the reader touches Zarr. Everything above it works in bins and microseconds
 * and never learns how a chunk is stored, compressed, or sharded.
 *
 * The range is taken as given and is not clamped: pair it with {@link binRange}, which is what
 * turns a time window into indices the level actually has. An empty range yields empty data.
 *
 * A level's layout is read from the array's own rank rather than passed in - rank 1 is raw
 * samples, rank 2 with a trailing dimension of 2 is min/max pairs - and a rank-2 read comes back
 * flattened to interleaved `[min, max, min, max, ...]`, ready to become a segment's data.
 *
 * **Samples widen to `Float64Array`.** Bundles store float32; every number above this line is a
 * float64, so the widening happens once, here, rather than at each consumer.
 *
 * `opts.signal` reaches the store, which is the layer that can abort a request in flight.
 *
 * Throws if there is no array at `path`, or if its shape is neither of the two layouts.
 */
export async function readBins(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  opts?: StoreOptions,
): Promise<Float64Array> {
  if (range.end <= range.start) {
    return new Float64Array(0);
  }

  // Two details that are easy to get wrong. `path` belongs on the location, not in the options:
  // an options `path` is ignored and the bundle root is opened instead. And the version is
  // pinned, since bundles are always Zarr v3: letting it auto-detect spends a request probing v2
  // and reports a missing array as a v2 failure, naming no path.
  const location = root(store).resolve(path);
  const array = await open
    .v3(location, { kind: "array", signal: opts?.signal })
    .catch((cause: unknown) => {
      // "Not found: v3 array or group" names no path, which is unhelpful when a query touches
      // dozens of levels. Any other failure - an abort, bad metadata - passes through untouched.
      if (cause instanceof NotFoundError) {
        throw new Error(`no level array at ${path}`, { cause });
      }
      throw cause;
    });

  const bins = slice(range.start, range.end);
  const rank = array.shape.length;
  if (rank === 1) {
    const region = await get(array, [bins], opts);
    return Float64Array.from(region.data);
  }
  if (rank === 2 && array.shape[1] === 2) {
    // A trailing axis of 2 flattens to the interleaved [min, max, ...] a segment carries.
    const region = await get(array, [bins, null], opts);
    return Float64Array.from(region.data);
  }

  throw new Error(
    `level ${path} has a shape the reader cannot read: ${JSON.stringify(array.shape)} (expected [n] or [n, 2])`,
  );
}
