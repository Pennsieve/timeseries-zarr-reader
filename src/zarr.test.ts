import { expect, test } from "vitest";
import {
  arrayMetadata,
  createMemoryStore,
  encodeChunk,
  float32Chunk,
  float64Chunk,
  int64Chunk,
} from "./test-utils.js";
import {
  openTimestamps,
  readBins,
  readColumn,
  readRows,
  warmZstdCodec,
} from "./zarr.js";

/** Stores a rank-2 array column-major by putting a transpose codec first. */
function transposed(metadata: string): string {
  const node = JSON.parse(metadata) as { codecs: unknown[] };
  node.codecs.unshift({ name: "transpose", configuration: { order: [1, 0] } });
  return JSON.stringify(node);
}

/** Unsharded fixture arrays for readBins, openTimestamps, and readRows. */
const store = createMemoryStore({
  "/raw/zarr.json": arrayMetadata([6], [3], { period_us: 1000 }),
  "/raw/c/0": float32Chunk([1, 2, 3]),
  "/raw/c/1": float32Chunk([4, 5, 6]),
  "/rawint/zarr.json": arrayMetadata([3], [3], { period_us: 1000 }, "int64"),
  "/rawint/c/0": int64Chunk([1, 2, 3]),
  "/env/zarr.json": arrayMetadata([3, 2], [3, 2], { period_us: 4000 }),
  "/env/c/0/0": float32Chunk([10, 11, 20, 21, 30, 31]),
  "/envT/zarr.json": transposed(
    arrayMetadata([3, 2], [3, 2], { period_us: 4000 }),
  ),
  "/envT/c/0/0": float32Chunk([10, 20, 30, 11, 21, 31]),
  "/rank3/zarr.json": arrayMetadata([2, 2, 2]),
  "/rank3/c/0/0/0": float32Chunk([1, 2, 3, 4, 5, 6, 7, 8]),
  "/malformed/zarr.json": "{not json",
  "/times/zarr.json": arrayMetadata([5], [5], {}, "int64"),
  "/times/c/0": int64Chunk([1000, 5000, 5500, 9000, 1_704_067_200_000_000]),
  "/huge/zarr.json": arrayMetadata([1], [1], {}, "int64"),
  "/huge/c/0": int64Chunk([1n << 60n]),
  "/waveforms/zarr.json": arrayMetadata([4, 3]),
  "/waveforms/c/0/0": float32Chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  "/rows64/zarr.json": arrayMetadata([2, 3], [2, 3], {}, "float64"),
  "/rows64/c/0/0": float64Chunk([1.5, 2.5, 3.5, 4.5, 5.5, 6.5]),
  "/rowsint/zarr.json": arrayMetadata([2, 3], [2, 3], {}, "int64"),
  "/rowsint/c/0/0": int64Chunk([1, 2, 3, 4, 5, 6]),
  "/labels/zarr.json": arrayMetadata([4], [4], {}, "uint16"),
  "/labels/c/0": encodeChunk([0, 1, 1, 65535], "uint16"),
  "/counts/zarr.json": arrayMetadata([3, 2], [3, 2], {}, "uint32"),
  "/counts/c/0/0": encodeChunk([1, 0, 2, 3, 0, 0], "uint32"),
  "/countsT/zarr.json": transposed(arrayMetadata([3, 2], [3, 2], {}, "uint32")),
  "/countsT/c/0/0": encodeChunk([1, 2, 0, 0, 3, 0], "uint32"),
  "/text/zarr.json": arrayMetadata([2, 3], [2, 3], {}, "uint8"),
  "/text/c/0/0": encodeChunk([97, 98, 0, 99, 0, 0], "uint8"),
  "/sparse/zarr.json": arrayMetadata([4], [2]),
  "/sparse/c/0": float32Chunk([1, 2]),
});

test("reads a raw level's samples as float64, crossing chunk boundaries", async () => {
  const data = await readBins(store, "/raw", { start: 1, end: 5 });
  expect(data).toBeInstanceOf(Float64Array);
  expect(Array.from(data)).toEqual([2, 3, 4, 5]);
});

test("reads an envelope level as interleaved min/max pairs", async () => {
  const data = await readBins(store, "/env", { start: 1, end: 3 });
  expect(Array.from(data)).toEqual([20, 21, 30, 31]);
});

test("reads an envelope level stored column-major in row order", async () => {
  // A transpose codec stores the level column-major; zarrita hands the read back in
  // that order with strides, and each bin's min must still pair with its own max.
  const data = await readBins(store, "/envT", { start: 1, end: 3 });
  expect(Array.from(data)).toEqual([20, 21, 30, 31]);
});

test("reads a whole level when the range spans it", async () => {
  const data = await readBins(store, "/raw", { start: 0, end: 6 });
  expect(Array.from(data)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("returns empty data for an empty range", async () => {
  const data = await readBins(store, "/raw", { start: 3, end: 3 });
  expect(data).toBeInstanceOf(Float64Array);
  expect(data.length).toBe(0);
});

test("rejects when there is no array at the path", async () => {
  await expect(
    readBins(store, "/absent", { start: 0, end: 1 }),
  ).rejects.toThrow(/absent/);
});

test("propagates a failure other than a missing array unchanged", async () => {
  // Malformed metadata throws a JSON parse error, not a NotFoundError.
  await expect(
    readBins(store, "/malformed", { start: 0, end: 1 }),
  ).rejects.toThrow(/JSON/);
});

test("rejects a level whose shape is neither raw nor min/max", async () => {
  await expect(readBins(store, "/rank3", { start: 0, end: 1 })).rejects.toThrow(
    /shape/,
  );
});

test("rejects a level whose dtype is not float32 or float64", async () => {
  await expect(
    readBins(store, "/rawint", { start: 0, end: 3 }),
  ).rejects.toThrow(/level \/rawint must be float32 or float64 \(got int64\)/);
});

test("reads int64 timestamps as microsecond numbers", async () => {
  const reader = await openTimestamps(store, "/times");
  expect(reader.count).toBe(5);
  expect(Array.from(await reader.read(1, 4))).toEqual([5000, 5500, 9000]);
  expect(Array.from(await reader.read(4, 5))).toEqual([1_704_067_200_000_000]);
});

test("returns empty timestamps for an empty range", async () => {
  const reader = await openTimestamps(store, "/times");
  expect((await reader.read(2, 2)).length).toBe(0);
});

test("rejects a timestamp array that is not rank-1 int64", async () => {
  await expect(openTimestamps(store, "/raw")).rejects.toThrow(/int64/);
  await expect(openTimestamps(store, "/waveforms")).rejects.toThrow(/int64/);
});

test("rejects a timestamp that does not fit a safe integer", async () => {
  const reader = await openTimestamps(store, "/huge");
  await expect(reader.read(0, 1)).rejects.toThrow(RangeError);
});

test("rejects a missing timestamp array", async () => {
  await expect(openTimestamps(store, "/nowhere")).rejects.toThrow(/nowhere/);
});

test("reads whole waveform rows, flattened row-major", async () => {
  const { data, rowLength } = await readRows(
    store,
    "/waveforms",
    { start: 1, end: 3 },
    ["float32", "float64"],
  );
  expect(data).toBeInstanceOf(Float32Array);
  expect(rowLength).toBe(3);
  expect(Array.from(data)).toEqual([4, 5, 6, 7, 8, 9]);
});

test("returns empty rows and the row length for an empty range", async () => {
  const { data, rowLength } = await readRows(
    store,
    "/waveforms",
    { start: 2, end: 2 },
    ["float32", "float64"],
  );
  expect(data.length).toBe(0);
  expect(data).toBeInstanceOf(Float32Array);
  expect(rowLength).toBe(3);
});

test("reads float64 rows without conversion loss", async () => {
  const { data, rowLength } = await readRows(
    store,
    "/rows64",
    { start: 0, end: 2 },
    ["float32", "float64"],
  );
  expect(rowLength).toBe(3);
  expect(Array.from(data)).toEqual([1.5, 2.5, 3.5, 4.5, 5.5, 6.5]);
});

test("rejects a row array that is not rank 2", async () => {
  await expect(
    readRows(store, "/raw", { start: 0, end: 1 }, ["float32"]),
  ).rejects.toThrow(/rank 2/);
});

test("rejects a row array whose dtype is not one asked for", async () => {
  await expect(
    readRows(store, "/rowsint", { start: 0, end: 1 }, ["float32", "float64"]),
  ).rejects.toThrow(/must be float32 or float64 \(got int64\)/);
  await expect(
    readRows(store, "/counts", { start: 0, end: 1 }, ["uint8"]),
  ).rejects.toThrow(/must be uint8 \(got uint32\)/);
});

test("reads integer rows in their own typed array", async () => {
  const counts = await readRows(store, "/counts", { start: 1, end: 3 }, [
    "uint32",
  ]);
  expect(counts.data).toBeInstanceOf(Uint32Array);
  expect(counts.rowLength).toBe(2);
  expect(Array.from(counts.data)).toEqual([2, 3, 0, 0]);

  const text = await readRows(store, "/text", { start: 0, end: 2 }, ["uint8"]);
  expect(text.data).toBeInstanceOf(Uint8Array);
  expect(Array.from(text.data)).toEqual([97, 98, 0, 99, 0, 0]);
});

test("reads rows stored column-major in row order", async () => {
  const whole = await readRows(store, "/countsT", { start: 0, end: 3 }, [
    "uint32",
  ]);
  expect(whole.data).toBeInstanceOf(Uint32Array);
  expect(Array.from(whole.data)).toEqual([1, 0, 2, 3, 0, 0]);

  const tail = await readRows(store, "/countsT", { start: 1, end: 3 }, [
    "uint32",
  ]);
  expect(tail.rowLength).toBe(2);
  expect(Array.from(tail.data)).toEqual([2, 3, 0, 0]);
});

test("reads a rank-1 column in its own typed array", async () => {
  const labels = await readColumn(store, "/labels", { start: 1, end: 4 }, [
    "uint16",
  ]);
  expect(labels).toBeInstanceOf(Uint16Array);
  expect(Array.from(labels)).toEqual([1, 1, 65535]);

  const values = await readColumn(store, "/raw", { start: 0, end: 2 }, [
    "float32",
    "float64",
  ]);
  expect(values).toBeInstanceOf(Float32Array);
  expect(Array.from(values)).toEqual([1, 2]);
});

test("returns an empty typed array of the matched kind for an empty column range", async () => {
  const labels = await readColumn(store, "/labels", { start: 2, end: 2 }, [
    "uint16",
  ]);
  expect(labels).toBeInstanceOf(Uint16Array);
  expect(labels.length).toBe(0);
});

test("rejects a column that is not rank 1, has the wrong dtype, or is missing", async () => {
  await expect(
    readColumn(store, "/counts", { start: 0, end: 1 }, ["uint32"]),
  ).rejects.toThrow(/rank 1/);
  await expect(
    readColumn(store, "/labels", { start: 0, end: 1 }, ["uint32"]),
  ).rejects.toThrow(/must be uint32 \(got uint16\)/);
  await expect(
    readColumn(store, "/absent", { start: 0, end: 1 }, ["uint32"]),
  ).rejects.toThrow(/absent/);
});

test("reads a chunk the producer omitted as the NaN fill", async () => {
  // The format lets a producer skip an all-fill chunk; the reader sees a gap.
  const data = await readBins(store, "/sparse", { start: 0, end: 4 });
  expect(Array.from(data)).toEqual([1, 2, NaN, NaN]);
});

test("warms the zstd codec by encoding through its registry entry", async () => {
  const encoded: Uint8Array[] = [];
  const warmed = await warmZstdCodec(
    new Map([
      [
        "zstd",
        () =>
          Promise.resolve({
            fromConfig: () => ({
              kind: "bytes_to_bytes",
              encode: (data: Uint8Array) => {
                encoded.push(data);
                return Promise.resolve(data);
              },
              decode: (data: Uint8Array) => Promise.resolve(data),
            }),
          }),
      ],
    ]),
  );
  expect(warmed).toBe(true);
  expect(encoded).toEqual([new Uint8Array(0)]);
});

test("reports no warmup when the registry carries no zstd entry", async () => {
  await expect(warmZstdCodec(new Map())).resolves.toBe(false);
});

test("reports no warmup when the codec fails to load", async () => {
  const codecs = new Map([
    ["zstd", () => Promise.reject(new Error("chunk load failed"))],
  ]);
  await expect(warmZstdCodec(codecs)).resolves.toBe(false);
});

test("warms the codec the default registry carries", async () => {
  await expect(warmZstdCodec()).resolves.toBe(true);
});
