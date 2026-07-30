import { expect, test } from "vitest";
import type { ChannelInfo } from "./types.js";
import { montageChannelKey, subtract } from "./montage.js";

const channel = (
  id: string,
  name: string,
): Pick<ChannelInfo, "id" | "name"> => ({ id, name });

test("subtracts the secondary channel from the lead sample by sample", () => {
  const out = subtract(
    new Float64Array([10, 20, 30]),
    new Float64Array([1, 2, 3]),
  );
  expect(Array.from(out)).toEqual([9, 18, 27]);
});

test("preserves negative differences", () => {
  const out = subtract(new Float64Array([1, 2]), new Float64Array([5, 10]));
  expect(Array.from(out)).toEqual([-4, -8]);
});

test("propagates a gap in either channel", () => {
  const out = subtract(
    new Float64Array([NaN, 5, 7]),
    new Float64Array([1, NaN, 2]),
  );
  expect(Array.from(out)).toEqual([NaN, NaN, 5]);
});

test("returns an empty result for empty inputs", () => {
  const out = subtract(new Float64Array([]), new Float64Array([]));
  expect(out.length).toBe(0);
});

test("throws when the two channels differ in length", () => {
  expect(() =>
    subtract(new Float64Array([1, 2, 3]), new Float64Array([1, 2])),
  ).toThrow(RangeError);
  expect(() =>
    subtract(new Float64Array([1, 2]), new Float64Array([1, 2, 3])),
  ).toThrow(RangeError);
});

test("leaves both inputs untouched and returns a distinct array", () => {
  const lead = new Float64Array([10, 20]);
  const secondary = new Float64Array([1, 2]);
  const out = subtract(lead, secondary);
  expect(Array.from(lead)).toEqual([10, 20]);
  expect(Array.from(secondary)).toEqual([1, 2]);
  expect(out).not.toBe(lead);
  expect(out).not.toBe(secondary);
});

test("builds a key from the lead id, the lead name, and the secondary name", () => {
  expect(
    montageChannelKey(channel("ch1", "LFP1"), channel("ch2", "LFP2")),
  ).toBe("ch1_LFP1<->LFP2");
});

test("ignores the secondary channel's id", () => {
  const lead = channel("ch1", "LFP1");
  expect(montageChannelKey(lead, channel("ch2", "LFP2"))).toBe(
    montageChannelKey(lead, channel("ch9", "LFP2")),
  );
});

test("yields a different key when lead and secondary are swapped", () => {
  expect(
    montageChannelKey(channel("ch2", "LFP2"), channel("ch1", "LFP1")),
  ).toBe("ch2_LFP2<->LFP1");
});

test("copies names verbatim, including spaces and punctuation", () => {
  expect(
    montageChannelKey(channel("chan-7", "Fp1-Ref"), channel("x", "A1 (ref)")),
  ).toBe("chan-7_Fp1-Ref<->A1 (ref)");
});

test("keeps the delimiters when a name is empty", () => {
  expect(montageChannelKey(channel("ch1", "LFP1"), channel("ch2", ""))).toBe(
    "ch1_LFP1<->",
  );
});
