import { expect, test } from "vitest";
import { makeSegment } from "./test-utils";
import { resampleToPixels } from "./resample";

const raw = (data: number[], samplePeriodUs = 1000) =>
  makeSegment({ samplePeriodUs, data: new Float64Array(data) });

const envelope = (data: number[], samplePeriodUs = 1000) =>
  makeSegment({ samplePeriodUs, isMinMax: true, data: new Float64Array(data) });

test("reduces raw samples to one min/max pair per pixel", () => {
  const out = resampleToPixels(raw([5, 1, 2, 8]), 2000);
  expect(Array.from(out.data)).toEqual([1, 5, 2, 8]);
  expect(out.isMinMax).toBe(true);
  expect(out.samplePeriodUs).toBe(2000);
  expect(out.startUs).toBe(0);
  expect(out.channel).toBe("c");
});

test("groups bins by time when the bins-per-pixel ratio is not an integer", () => {
  // 2.5 bins per pixel: bins 0-2 land in pixel 0, bins 3-4 in pixel 1.
  const out = resampleToPixels(raw([3, 1, 4, 1, 5]), 2500);
  expect(Array.from(out.data)).toEqual([1, 4, 1, 5]);
  expect(out.samplePeriodUs).toBe(2500);
});

test("merges envelope pairs by smallest min and largest max", () => {
  const out = resampleToPixels(envelope([10, 20, 5, 15, 30, 40, 8, 50]), 2000);
  expect(Array.from(out.data)).toEqual([5, 20, 8, 50]);
  expect(out.isMinMax).toBe(true);
});

test("emits a pair per sample when the pixel grid matches the sample period", () => {
  const out = resampleToPixels(raw([7, 9]), 1000);
  expect(Array.from(out.data)).toEqual([7, 7, 9, 9]);
  expect(out.samplePeriodUs).toBe(1000);
});

test("passes envelope pairs through when the pixel grid matches the bin period", () => {
  const out = resampleToPixels(envelope([1, 2, 3, 4]), 1000);
  expect(Array.from(out.data)).toEqual([1, 2, 3, 4]);
  expect(out.samplePeriodUs).toBe(1000);
});

test("keeps a trailing pixel covering less than a full pixel of time", () => {
  const out = resampleToPixels(raw([1, 2, 3, 4, 5]), 2000);
  expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 5]);
});

test("skips non-finite values within a pixel", () => {
  const out = resampleToPixels(raw([NaN, 3, Infinity, 7]), 2000);
  expect(Array.from(out.data)).toEqual([3, 3, 7, 7]);
});

test("skips non-finite envelope pairs when merging", () => {
  const out = resampleToPixels(envelope([NaN, NaN, 5, 15]), 2000);
  expect(Array.from(out.data)).toEqual([5, 15]);
});

test("yields NaN for a pixel holding nothing but non-finite values", () => {
  const out = resampleToPixels(raw([NaN, NaN, 2, 6]), 2000);
  expect(Array.from(out.data)).toEqual([NaN, NaN, 2, 6]);
});

test("returns empty data for empty input", () => {
  const out = resampleToPixels(raw([]), 2000);
  expect(out.data.length).toBe(0);
  expect(out.isMinMax).toBe(true);
  expect(out.samplePeriodUs).toBe(2000);
  expect(out.startUs).toBe(0);
});

test("throws when pixelWidthUs is narrower than the sample period", () => {
  expect(() => resampleToPixels(raw([1, 2]), 500)).toThrow(RangeError);
});
