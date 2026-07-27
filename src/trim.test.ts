import { expect, test } from "vitest";
import { makeSegment } from "./test-utils";
import { trimToBounds } from "./trim";

const raw = (data: number[]) => makeSegment({ data: new Float64Array(data) });

test("returns the segment unchanged when the window covers every bin", () => {
  const out = trimToBounds(raw([10, 20, 30, 40, 50]), 0, 5000);
  expect(Array.from(out.data)).toEqual([10, 20, 30, 40, 50]);
  expect(out.startUs).toBe(0);
  expect(out.channel).toBe("c");
  expect(out.isMinMax).toBe(false);
});

test("drops leading bins entirely before the window and advances startUs", () => {
  const out = trimToBounds(raw([10, 20, 30, 40, 50]), 2000, 5000);
  expect(Array.from(out.data)).toEqual([30, 40, 50]);
  expect(out.startUs).toBe(2000);
});

test("drops trailing bins at or after endUs (exclusive) and keeps startUs", () => {
  const out = trimToBounds(raw([10, 20, 30, 40, 50]), 0, 3000);
  expect(Array.from(out.data)).toEqual([10, 20, 30]);
  expect(out.startUs).toBe(0);
});

test("keeps edge bins that only partially overlap the window", () => {
  const out = trimToBounds(raw([10, 20, 30, 40, 50]), 1500, 3500);
  expect(Array.from(out.data)).toEqual([20, 30, 40]);
  expect(out.startUs).toBe(1000);
});

test("drops min/max bins two values at a time", () => {
  const seg = makeSegment({
    isMinMax: true,
    data: new Float64Array([10, 11, 20, 21, 30, 31, 40, 41]),
  });
  const out = trimToBounds(seg, 1000, 3000);
  expect(Array.from(out.data)).toEqual([20, 21, 30, 31]);
  expect(out.startUs).toBe(1000);
  expect(out.isMinMax).toBe(true);
});

test("returns empty data when no bin overlaps the window", () => {
  const out = trimToBounds(raw([10, 20, 30, 40, 50]), 10000, 20000);
  expect(out.data.length).toBe(0);
});

test("returns empty data for empty input", () => {
  const out = trimToBounds(raw([]), 0, 5000);
  expect(out.data.length).toBe(0);
});
