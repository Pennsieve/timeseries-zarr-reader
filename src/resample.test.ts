import { describe, expect, test } from "vitest";
import type { Segment } from "./types.js";
import { makeSegment } from "./test-utils.js";
import { resampleToPixels } from "./resample.js";

const raw = (data: number[], samplePeriodUs = 1000) =>
  makeSegment({ samplePeriodUs, data: new Float64Array(data) });

const envelope = (data: number[], samplePeriodUs = 1000) =>
  makeSegment({ samplePeriodUs, isMinMax: true, data: new Float64Array(data) });

test("reduces raw samples to one min/max pair per pixel", () => {
  const out = resampleToPixels(raw([5, 1, 2, 8]), 2000, 0);
  expect(Array.from(out.data)).toEqual([1, 5, 2, 8]);
  expect(out.isMinMax).toBe(true);
  expect(out.samplePeriodUs).toBe(2000);
  expect(out.startUs).toBe(0);
  expect(out.channel).toBe("c");
});

test("groups bins by time when the bins-per-pixel ratio is not an integer", () => {
  // 2.5 bins per pixel: bins 0-2 fall in pixel 0, bins 3-4 in pixel 1.
  const out = resampleToPixels(raw([3, 1, 4, 1, 5]), 2500, 0);
  expect(Array.from(out.data)).toEqual([1, 4, 1, 5]);
  expect(out.samplePeriodUs).toBe(2500);
});

test("merges envelope pairs by smallest min and largest max", () => {
  const out = resampleToPixels(
    envelope([10, 20, 5, 15, 30, 40, 8, 50]),
    2000,
    0,
  );
  expect(Array.from(out.data)).toEqual([5, 20, 8, 50]);
  expect(out.isMinMax).toBe(true);
});

test("emits a pair per sample when the pixel grid matches the sample period", () => {
  const out = resampleToPixels(raw([7, 9]), 1000, 0);
  expect(Array.from(out.data)).toEqual([7, 7, 9, 9]);
  expect(out.samplePeriodUs).toBe(1000);
});

test("passes envelope pairs through when the pixel grid matches the bin period", () => {
  const out = resampleToPixels(envelope([1, 2, 3, 4]), 1000, 0);
  expect(Array.from(out.data)).toEqual([1, 2, 3, 4]);
  expect(out.samplePeriodUs).toBe(1000);
});

test("keeps a trailing pixel covering less than a full pixel of time", () => {
  const out = resampleToPixels(raw([1, 2, 3, 4, 5]), 2000, 0);
  expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 5]);
});

test("skips non-finite values within a pixel", () => {
  const out = resampleToPixels(raw([NaN, 3, Infinity, 7]), 2000, 0);
  expect(Array.from(out.data)).toEqual([3, 3, 7, 7]);
});

test("skips non-finite envelope pairs when merging", () => {
  const out = resampleToPixels(envelope([NaN, NaN, 5, 15]), 2000, 0);
  expect(Array.from(out.data)).toEqual([5, 15]);
});

test("yields NaN for a pixel containing only non-finite values", () => {
  const out = resampleToPixels(raw([NaN, NaN, 2, 6]), 2000, 0);
  expect(Array.from(out.data)).toEqual([NaN, NaN, 2, 6]);
});

test("returns empty data for empty input", () => {
  const out = resampleToPixels(raw([]), 2000, 0);
  expect(out.data.length).toBe(0);
  expect(out.isMinMax).toBe(true);
  expect(out.samplePeriodUs).toBe(2000);
  expect(out.startUs).toBe(0);
});

test("throws when pixelWidthUs is narrower than the sample period", () => {
  expect(() => resampleToPixels(raw([1, 2]), 500, 0)).toThrow(RangeError);
});

test("snaps the output start down to the anchor grid", () => {
  const out = resampleToPixels(
    makeSegment({ startUs: 5000, data: new Float64Array([5, 1, 2, 8]) }),
    2000,
    0,
  );
  expect(out.startUs).toBe(4000);
  expect(Array.from(out.data)).toEqual([5, 5, 1, 2, 8, 8]);
});

test("lands windows split mid-bucket on one shared grid", () => {
  const whole = resampleToPixels(
    makeSegment({ data: new Float64Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) }),
    2500,
    0,
  );
  const left = resampleToPixels(
    makeSegment({ data: new Float64Array([0, 1, 2, 3, 4, 5]) }),
    2500,
    0,
  );
  const right = resampleToPixels(
    makeSegment({ startUs: 6000, data: new Float64Array([6, 7, 8, 9]) }),
    2500,
    0,
  );

  expect(Array.from(whole.data)).toEqual([0, 2, 3, 4, 5, 7, 8, 9]);
  expect(left.startUs).toBe(0);
  expect(Array.from(left.data)).toEqual([0, 2, 3, 4, 5, 5]);
  // The bucket straddling the split starts at 5000 in both windows. Merging its
  // two partial pairs reproduces the whole-signal bucket.
  expect(right.startUs).toBe(5000);
  expect(Array.from(right.data)).toEqual([6, 7, 8, 9]);
});

/** Count, mean, and population variance of the finite values, in binary64. */
function direct(values: readonly number[]) {
  const finite = values.filter(Number.isFinite);
  const count = finite.length;
  const mean = finite.reduce((sum, value) => sum + value, 0) / count;
  const variance =
    finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  return { count, mean, variance };
}

/** Deterministic samples with NaN holes, including one bin of four holes. */
const SAMPLES = Array.from({ length: 40 }, (_, i) =>
  (i >= 16 && i < 20) || i === 3 ? NaN : Math.sin(i * 1.7) * 50 + (i % 5) * 9,
);

/** An envelope segment of 4-sample bins that carries its bins' statistics. */
function statisticsSegment(): { segment: Segment; bins: number[][] } {
  const bins = Array.from({ length: 10 }, (_, bin) =>
    SAMPLES.slice(bin * 4, bin * 4 + 4),
  );
  const stats = bins.map(direct);
  const pairs = bins.flatMap((bin) => {
    const finite = bin.filter(Number.isFinite);
    return finite.length === 0
      ? [NaN, NaN]
      : [Math.min(...finite), Math.max(...finite)];
  });
  return {
    bins,
    segment: makeSegment({
      samplePeriodUs: 4000,
      isMinMax: true,
      data: new Float64Array(pairs),
      count: Float64Array.from(stats.map((s) => s.count)),
      mean: Float64Array.from(stats.map((s) => s.mean)),
      variance: Float64Array.from(stats.map((s) => s.variance)),
    }),
  };
}

describe("statistics", () => {
  const all = ["mean", "var", "count"] as const;

  test("folds envelope statistics to match a direct computation", () => {
    const { segment, bins } = statisticsSegment();
    // 12 ms pixels over 4 ms bins: bins 0-2, 3-5, 6-8, and 9.
    const out = resampleToPixels(segment, 12_000, 0, all);

    const groups = [bins.slice(0, 3), bins.slice(3, 6), bins.slice(6, 9)];
    const expected = [
      ...groups.map((group) => direct(group.flat())),
      direct(bins[9]!),
    ];
    expect(Array.from(out.count!)).toEqual(expected.map((s) => s.count));
    out.mean!.forEach((value, pixel) => {
      expect(value).toBeCloseTo(expected[pixel]!.mean, 12);
    });
    out.variance!.forEach((value, pixel) => {
      expect(value).toBeCloseTo(expected[pixel]!.variance, 9);
    });
  });

  test("skips bins with a count of 0 when folding", () => {
    // Bin 4 holds no finite sample. Bins 3-5 fold from bins 3 and 5 alone.
    const { segment, bins } = statisticsSegment();
    const out = resampleToPixels(segment, 12_000, 0, all);

    const expected = direct([...bins[3]!, ...bins[5]!]);
    expect(out.count![1]).toBe(expected.count);
    expect(out.mean![1]).toBeCloseTo(expected.mean, 12);
    expect(out.variance![1]).toBeCloseTo(expected.variance, 9);
  });

  test("yields NaN mean and variance and a count of 0 for an empty pixel", () => {
    const { segment } = statisticsSegment();
    // 4 ms pixels with 4 ms bins pass each bin through; bin 4 is empty.
    const out = resampleToPixels(segment, 4000, 0, all);

    expect(out.count![4]).toBe(0);
    expect(out.mean![4]).toBeNaN();
    expect(out.variance![4]).toBeNaN();
  });

  test("copies the statistics of a pixel that holds one bin", () => {
    const { segment } = statisticsSegment();
    const out = resampleToPixels(segment, 4000, 0, all);

    expect(Array.from(out.mean!)).toEqual(Array.from(segment.mean!));
    expect(Array.from(out.variance!)).toEqual(Array.from(segment.variance!));
    expect(Array.from(out.count!)).toEqual(Array.from(segment.count!));
  });

  test("computes the statistics of raw input from its finite samples", () => {
    const out = resampleToPixels(raw(SAMPLES, 1000), 6000, 0, all);

    const expected = Array.from({ length: 7 }, (_, pixel) =>
      direct(SAMPLES.slice(pixel * 6, pixel * 6 + 6)),
    );
    expect(Array.from(out.count!)).toEqual(expected.map((s) => s.count));
    expect(Array.from(out.mean!)).toEqual(expected.map((s) => s.mean));
    expect(Array.from(out.variance!)).toEqual(expected.map((s) => s.variance));
  });

  test("carries only the statistics named in members", () => {
    const { segment } = statisticsSegment();
    const out = resampleToPixels(segment, 12_000, 0, ["count"]);

    expect(out.count).toBeDefined();
    expect(out.mean).toBeUndefined();
    expect(out.variance).toBeUndefined();
  });

  test("drops the input's statistics when members is empty", () => {
    const { segment } = statisticsSegment();
    const out = resampleToPixels(segment, 12_000, 0);

    expect(out.count).toBeUndefined();
    expect(out.mean).toBeUndefined();
    expect(out.variance).toBeUndefined();
  });

  test("leaves out a statistic whose inputs the segment lacks", () => {
    const { segment } = statisticsSegment();
    const bare = makeSegment({
      samplePeriodUs: segment.samplePeriodUs,
      isMinMax: true,
      data: segment.data,
      mean: segment.mean!,
    });
    const out = resampleToPixels(bare, 12_000, 0, all);

    expect(out.count).toBeUndefined();
    expect(out.mean).toBeUndefined();
    expect(out.variance).toBeUndefined();
  });

  test("returns empty statistics for empty input", () => {
    const out = resampleToPixels(raw([]), 2000, 0, all);

    expect(out.count?.length).toBe(0);
    expect(out.mean?.length).toBe(0);
  });
});
