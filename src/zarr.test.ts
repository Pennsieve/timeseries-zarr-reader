import { expect, test } from "vitest";
import { arrayMetadata, createMemoryStore, float32Chunk } from "./test-utils";
import { readBins } from "./zarr";

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
