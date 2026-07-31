import { get, NotFoundError, open, root, slice } from "zarrita";
import type { Store, StoreOptions } from "./types.js";

/**
 * Opens the array at `path`, pinned to Zarr v3.
 *
 * `path` is resolved onto the store's root location, and zarrita ignores an options
 * `path`. A missing array rejects with an Error naming the path. Any other failure
 * propagates unchanged.
 */
async function openArray(
  store: Store,
  path: `/${string}`,
  opts?: StoreOptions,
) {
  try {
    return await open.v3(root(store).resolve(path), {
      kind: "array",
      signal: opts?.signal,
    });
  } catch (cause) {
    if (cause instanceof NotFoundError) {
      throw new Error(`no array at ${path}`, { cause });
    }
    throw cause;
  }
}

/**
 * Rejects an array whose dtype is neither float32 nor float64.
 *
 * `role` names the array's part in the message.
 */
function requireFloatDtype(
  array: Awaited<ReturnType<typeof openArray>>,
  role: string,
  path: `/${string}`,
): void {
  if (!array.is("float32") && !array.is("float64")) {
    throw new Error(
      `${role} ${path} must be float32 or float64 (got ${array.dtype})`,
    );
  }
}

/**
 * Reads a level's bins over a half-open index range.
 *
 * The range is used as given, with no clamping to the array's bounds. {@link binRange}
 * derives a clamped one. An empty range returns empty data. A rank-1 array yields raw
 * samples, a rank-2 `[n, 2]` array interleaved `[min, max, ...]` pairs. Stored float32
 * samples widen to `Float64Array`. `opts.signal` is forwarded to the store.
 *
 * Throws when no array exists at `path`, its shape is neither `[n]` nor `[n, 2]`, or
 * its dtype is neither float32 nor float64.
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
  requireFloatDtype(array, "level", path);

  const bins = slice(range.start, range.end);
  const rank = array.shape.length;
  if (rank === 1) {
    const region = await get(array, [bins], opts);
    return Float64Array.from(region.data);
  }
  if (rank === 2 && array.shape[1] === 2) {
    // get() returns the [n, 2] read already flattened to interleaved [min, max, ...].
    const region = await get(array, [bins, null], opts);
    return Float64Array.from(region.data);
  }

  throw new Error(
    `level ${path} has unsupported shape ${JSON.stringify(array.shape)} (expected [n] or [n, 2])`,
  );
}

/** A rank-1 int64 timestamp array, opened once for repeated range reads. */
export interface TimestampReader {
  /** Total timestamps in the array. */
  readonly count: number;
  /** Timestamps over a half-open index range, as microsecond numbers. */
  read(start: number, end: number): Promise<Float64Array>;
}

/** The largest int64 magnitude that converts exactly to a number. */
const MAX_SAFE_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Opens a timestamp array for reading.
 *
 * Stored int64 values are converted to numbers. The conversion is exact for
 * microsecond timestamps. A value outside the safe integer range throws a RangeError.
 *
 * Throws when no array exists at `path` or it is not rank-1 int64.
 */
export async function openTimestamps(
  store: Store,
  path: `/${string}`,
  opts?: StoreOptions,
): Promise<TimestampReader> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 1 || !array.is("int64")) {
    throw new Error(
      `timestamp array ${path} must be rank-1 int64 (got ${array.dtype} ${JSON.stringify(array.shape)})`,
    );
  }

  return {
    count: array.shape[0]!,
    read: async (start, end) => {
      if (end <= start) {
        return new Float64Array(0);
      }
      const region = await get(array, [slice(start, end)], opts);
      const values = region.data;
      const out = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        if (value > MAX_SAFE_TIMESTAMP || value < -MAX_SAFE_TIMESTAMP) {
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
 * Reads whole rows of a rank-2 array over a half-open row range.
 *
 * Rows are returned flattened row-major, `rowLength` values per row, widened to
 * `Float64Array`. An empty range returns empty data and the row length.
 *
 * Throws when no array exists at `path`, it is not rank 2, or its dtype is neither
 * float32 nor float64.
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
  requireFloatDtype(array, "row array", path);

  const rowLength = array.shape[1]!;
  if (range.end <= range.start) {
    return { data: new Float64Array(0), rowLength };
  }
  const region = await get(array, [slice(range.start, range.end), null], opts);
  return { data: Float64Array.from(region.data), rowLength };
}
