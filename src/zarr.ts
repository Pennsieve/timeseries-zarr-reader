import { get, NotFoundError, open, registry, root, slice } from "zarrita";
import type { Chunk, DataType } from "zarrita";
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

type OpenedArray = Awaited<ReturnType<typeof openArray>>;

/** The numeric dtypes the reader accepts besides int64, by Zarr v3 name. */
export type NumericDtype =
  "float32" | "float64" | "uint8" | "uint16" | "uint32";

const CONSTRUCTORS = {
  float32: Float32Array,
  float64: Float64Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
} as const;

/** The typed array zarrita returns for a {@link NumericDtype}. */
export type ArrayOf<D extends NumericDtype> = InstanceType<
  (typeof CONSTRUCTORS)[D]
>;

/**
 * Returns which of `dtypes` the array has. Throws when it has none of them, naming
 * the array's `role` in the message.
 */
function matchDtype<D extends NumericDtype>(
  array: OpenedArray,
  dtypes: readonly D[],
  role: string,
  path: `/${string}`,
): D {
  const matched = dtypes.find((dtype) => array.is(dtype));
  if (matched === undefined) {
    throw new Error(
      `${role} ${path} must be ${dtypes.join(" or ")} (got ${array.dtype})`,
    );
  }
  return matched;
}

/**
 * Flattens a rank-2 read row-major, in the typed array of `dtype`.
 *
 * Returns the read itself when it is already row-major. Otherwise returns a
 * row-major copy, as when a `transpose` codec stored the array column-major.
 */
function flattenRows<D extends NumericDtype>(
  dtype: D,
  region: Chunk<DataType>,
): ArrayOf<D> {
  const rows = region.shape[0]!;
  const cols = region.shape[1]!;
  const rowStride = region.stride[0]!;
  const colStride = region.stride[1]!;
  // dtype was matched against the array, so this is its typed array.
  const data = region.data as ArrayOf<D>;
  if (rowStride === cols && colStride === 1) {
    return data;
  }
  const out = new CONSTRUCTORS[dtype](rows * cols) as ArrayOf<D>;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out[row * cols + col] = data[row * rowStride + col * colStride]!;
    }
  }
  return out;
}

/**
 * Reads a level's bins over a half-open index range.
 *
 * The range is used as given, with no clamping to the array's bounds. {@link binIndexRange}
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
  const dtype = matchDtype(array, ["float32", "float64"], "level", path);

  const bins = slice(range.start, range.end);
  const rank = array.shape.length;
  if (rank === 1) {
    const region = await get(array, [bins], opts);
    return Float64Array.from(region.data as ArrayLike<number>);
  }
  if (rank === 2 && array.shape[1] === 2) {
    // Row-major, the [n, 2] read is interleaved [min, max, ...].
    const region = await get(array, [bins, null], opts);
    return Float64Array.from(flattenRows(dtype, region));
  }

  throw new Error(
    `level ${path} has unsupported shape ${JSON.stringify(array.shape)} (expected [n] or [n, 2])`,
  );
}

/**
 * Reads a rank-1 numeric array over a half-open index range, in the array's own
 * typed array.
 *
 * `dtypes` lists what the array may be; the result is one of their typed arrays, and
 * a caller widens it as it needs. int64 arrays are read through
 * {@link openTimestamps} instead, which converts them to numbers. An empty range
 * returns an empty array of the matched kind.
 *
 * Throws when no array exists at `path`, it is not rank 1, or its dtype is not one of
 * `dtypes`.
 */
export async function readColumn<D extends NumericDtype>(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  dtypes: readonly D[],
  opts?: StoreOptions,
): Promise<ArrayOf<D>> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 1) {
    throw new Error(
      `column ${path} must be rank 1 (got shape ${JSON.stringify(array.shape)})`,
    );
  }
  const dtype = matchDtype(array, dtypes, "column", path);
  if (range.end <= range.start) {
    return new CONSTRUCTORS[dtype](0) as ArrayOf<D>;
  }
  const region = await get(array, [slice(range.start, range.end)], opts);
  return region.data as ArrayOf<D>;
}

/**
 * Reads whole rows of a rank-2 numeric array over a half-open row range.
 *
 * Rows come back flattened row-major, `rowLength` values per row, in the array's own
 * typed array as {@link readColumn} returns it. An empty range returns empty data and
 * the row length.
 *
 * Throws when no array exists at `path`, it is not rank 2, or its dtype is not one of
 * `dtypes`.
 */
export async function readRows<D extends NumericDtype>(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  dtypes: readonly D[],
  opts?: StoreOptions,
): Promise<{ data: ArrayOf<D>; rowLength: number }> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 2) {
    throw new Error(
      `row array ${path} must be rank 2 (got shape ${JSON.stringify(array.shape)})`,
    );
  }
  const dtype = matchDtype(array, dtypes, "row array", path);

  const rowLength = array.shape[1]!;
  if (range.end <= range.start) {
    return { data: new CONSTRUCTORS[dtype](0) as ArrayOf<D>, rowLength };
  }
  const region = await get(array, [slice(range.start, range.end), null], opts);
  return { data: flattenRows(dtype, region), rowLength };
}

/** A rank-1 int64 timestamp array, opened once for repeated range reads. */
export interface TimestampReader {
  /** Total timestamps in the array. */
  readonly count: number;
  /**
   * Timestamps over a half-open index range, as microsecond numbers. `opts`
   * replaces the options the reader was opened with.
   */
  read(start: number, end: number, opts?: StoreOptions): Promise<Float64Array>;
}

/** The largest int64 magnitude that converts exactly to a number. */
const MAX_SAFE_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER);

/** Converts a stored int64 to a number. Throws a RangeError past the safe range. */
function toSafeNumber(value: bigint, path: `/${string}`): number {
  if (value > MAX_SAFE_TIMESTAMP || value < -MAX_SAFE_TIMESTAMP) {
    throw new RangeError(
      `timestamp ${value} in ${path} does not fit a safe integer`,
    );
  }
  return Number(value);
}

/**
 * Reads whole rows of a rank-2 int64 array over a half-open row range, flattened
 * row-major as numbers.
 *
 * Every value must fit a safe integer, as the format requires of its times, or the
 * read throws a RangeError. An empty range returns empty data and the row length.
 *
 * Throws when no array exists at `path` or it is not rank-2 int64.
 */
export async function readInt64Rows(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  opts?: StoreOptions,
): Promise<{ data: Float64Array; rowLength: number }> {
  const array = await openArray(store, path, opts);
  if (array.shape.length !== 2 || !array.is("int64")) {
    throw new Error(
      `row array ${path} must be rank-2 int64 (got ${array.dtype} ${JSON.stringify(array.shape)})`,
    );
  }
  const rowLength = array.shape[1]!;
  if (range.end <= range.start) {
    return { data: new Float64Array(0), rowLength };
  }
  const region = await get(array, [slice(range.start, range.end), null], opts);
  const rows = region.shape[0]!;
  const [rowStride, colStride] = region.stride as [number, number];
  const out = new Float64Array(rows * rowLength);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < rowLength; col++) {
      out[row * rowLength + col] = toSafeNumber(
        region.data[row * rowStride + col * colStride]!,
        path,
      );
    }
  }
  return { data: out, rowLength };
}

/**
 * Opens a timestamp array for reading.
 *
 * Stored int64 values are converted to numbers. The conversion is exact for
 * microsecond timestamps. A value outside the safe integer range throws a RangeError.
 * Durations are read the same way.
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
    read: async (start, end, readOpts = opts) => {
      if (end <= start) {
        return new Float64Array(0);
      }
      const region = await get(array, [slice(start, end)], readOpts);
      const values = region.data;
      const out = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        out[i] = toSafeNumber(values[i]!, path);
      }
      return out;
    },
  };
}

/**
 * Loads and instantiates the zstd codec that decompresses bundle chunks.
 *
 * The codec module carries its WebAssembly binary inline and loads on first use, so
 * the first chunk read otherwise waits for that download. Encoding an empty buffer
 * finishes the instantiation.
 *
 * Never rejects. Resolves false when the registry holds no zstd entry and when the
 * load fails; the read that needs the codec reports the failure.
 *
 * `codecs` defaults to zarrita's codec registry.
 *
 * @returns whether the codec is ready to decode.
 */
export async function warmZstdCodec(
  codecs: typeof registry = registry,
): Promise<boolean> {
  try {
    const load = codecs.get("zstd");
    if (!load) {
      return false;
    }
    const entry = await load();
    // The codec reads the level from its config and ignores the chunk metadata, which
    // the registry's signature requires.
    const codec = entry.fromConfig(
      { level: 1 },
      { dataType: "float32", shape: [1], codecs: [], fillValue: null },
    );
    await codec.encode(new Uint8Array(0));
    return true;
  } catch {
    return false;
  }
}
