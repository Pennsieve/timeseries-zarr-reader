import { get, NotFoundError, open, root, slice } from "zarrita";
import type { Store, StoreOptions } from "./types.js";

/**
 * Open the array at `path`, pinning Zarr v3 and naming the path on a miss.
 *
 * Two details that are easy to get wrong. `path` belongs on the location, not in the options:
 * an options `path` is ignored and the bundle root is opened instead. And the version is
 * pinned, since bundles are always Zarr v3: letting it auto-detect spends a request probing v2
 * and reports a missing array as a v2 failure, naming no path. Even the v3 miss names no path -
 * unhelpful when a query touches dozens of arrays - so it is rewrapped; any other failure, an
 * abort or bad metadata, passes through untouched.
 */
const openArray = (store: Store, path: `/${string}`, opts?: StoreOptions) =>
  open
    .v3(root(store).resolve(path), { kind: "array", signal: opts?.signal })
    .catch((cause: unknown) => {
      if (cause instanceof NotFoundError) {
        throw new Error(`no array at ${path}`, { cause });
      }
      throw cause;
    });

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

  const array = await openArray(store, path, opts);
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

/**
 * A handle over one rank-1 int64 timestamp array, opened once and read many times.
 *
 * A binary search reads one element per probe; a handle keeps those probes from re-fetching the
 * array's metadata every time.
 */
export type TimestampReader = {
  /** Total timestamps in the array. */
  count: number;
  /** Timestamps over a half-open index range, as microsecond numbers. */
  read(start: number, end: number): Promise<Float64Array>;
};

/**
 * Open a timestamp array for reading.
 *
 * Values are stored as int64 and converted to numbers. Microsecond timestamps sit far below
 * 2^53, so the conversion is exact; a value outside the safe integer range throws rather than
 * rounding silently.
 *
 * Throws if there is no array at `path`, or if it is not a rank-1 int64 array.
 */
export async function openTimestamps(
  store: Store,
  path: `/${string}`,
  opts?: StoreOptions,
): Promise<TimestampReader> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 1 || array.dtype !== "int64") {
    throw new Error(
      `timestamp array ${path} must be rank-1 int64 (got ${array.dtype} ${JSON.stringify(array.shape)})`,
    );
  }

  return {
    count: array.shape[0] as number,
    read: async (start, end) => {
      if (end <= start) {
        return new Float64Array(0);
      }
      const region = await get(array, [slice(start, end)], opts);
      const values = region.data as BigInt64Array;
      const out = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const value = values[i] as bigint;
        if (value > 9007199254740991n || value < -9007199254740991n) {
          throw new RangeError(
            `timestamp ${value} in ${path} does not fit a safe integer`,
          );
        }
        out[i] = Number(value);
      }
      return out;
    },
  };
}

/**
 * Read whole rows of a rank-2 array over a half-open row range.
 *
 * This is the waveform read: each row is one spike's samples. Rows come back flattened
 * row-major, `rowLength` values per row, widened to `Float64Array` like every other read.
 *
 * Throws if there is no array at `path`, or if it is not rank 2.
 */
export async function readRows(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  opts?: StoreOptions,
): Promise<{ data: Float64Array; rowLength: number }> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 2) {
    throw new Error(
      `row array ${path} must be rank 2 (got shape ${JSON.stringify(array.shape)})`,
    );
  }

  const rowLength = array.shape[1] as number;
  if (range.end <= range.start) {
    return { data: new Float64Array(0), rowLength };
  }
  const region = await get(array, [slice(range.start, range.end), null], opts);
  return { data: Float64Array.from(region.data as Float32Array), rowLength };
}
