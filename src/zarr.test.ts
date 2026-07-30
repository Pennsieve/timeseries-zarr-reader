import { expect, test } from "vitest";
import {
  arrayMetadata,
  createMemoryStore,
  float32Chunk,
  int64Chunk,
} from "./test-utils.js";
import { openTimestamps, readBins, readRows } from "./zarr.js";

/**
 * A store holding three unsharded arrays: a raw level in two chunks, an envelope level, and one
 * with a rank the reader has no layout for.
 */
const store = createMemoryStore({
  "/raw/zarr.json": arrayMetadata([6], [3], { period_us: 1000 }),
  "/raw/c/0": float32Chunk([1, 2, 3]),
  "/raw/c/1": float32Chunk([4, 5, 6]),
  "/env/zarr.json": arrayMetadata([3, 2], [3, 2], { period_us: 4000 }),
  "/env/c/0/0": float32Chunk([10, 11, 20, 21, 30, 31]),
  "/rank3/zarr.json": arrayMetadata([2, 2, 2]),
  "/rank3/c/0/0/0": float32Chunk([1, 2, 3, 4, 5, 6, 7, 8]),
  "/malformed/zarr.json": "{not json",
  "/times/zarr.json": arrayMetadata([5], [5], {}, "int64"),
  "/times/c/0": int64Chunk([1000, 5000, 5500, 9000, 1_704_067_200_000_000]),
  "/huge/zarr.json": arrayMetadata([1], [1], {}, "int64"),
  "/huge/c/0": int64Chunk([1n << 60n]),
  "/waveforms/zarr.json": arrayMetadata([4, 3]),
  "/waveforms/c/0/0": float32Chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
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

test("passes a failure other than a missing array straight through", async () => {
  // The missing-array case is rewrapped to name the path; nothing else should be.
  await expect(
    readBins(store, "/malformed", { start: 0, end: 1 }),
  ).rejects.toThrow(/JSON/);
});

test("rejects a level whose shape is neither raw nor min/max", async () => {
  await expect(readBins(store, "/rank3", { start: 0, end: 1 })).rejects.toThrow(
    /shape/,
  );
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

test("rejects a missing timestamp array, naming the path", async () => {
  await expect(openTimestamps(store, "/nowhere")).rejects.toThrow(/nowhere/);
});

test("reads whole waveform rows, flattened row-major", async () => {
  const { data, rowLength } = await readRows(store, "/waveforms", {
    start: 1,
    end: 3,
  });
  expect(data).toBeInstanceOf(Float64Array);
  expect(rowLength).toBe(3);
  expect(Array.from(data)).toEqual([4, 5, 6, 7, 8, 9]);
});

test("returns empty rows for an empty range, keeping the row length", async () => {
  const { data, rowLength } = await readRows(store, "/waveforms", {
    start: 2,
    end: 2,
  });
  expect(data.length).toBe(0);
  expect(rowLength).toBe(3);
});

test("rejects a row array that is not rank 2", async () => {
  await expect(readRows(store, "/raw", { start: 0, end: 1 })).rejects.toThrow(
    /rank 2/,
  );
});
