import { describe, expect, test } from "vitest";
import {
  binEdgeUs,
  binIndexRange,
  binStartUs,
  channelEndUs,
  countBinRange,
  countBinStartUs,
  levelBins,
  samplesPerBin,
  wholeSamples,
} from "./grid.js";

/** A time near the Unix epoch of 2026, in microseconds. */
const EPOCH_US = 1_790_000_000_000_000;

describe("samplesPerBin", () => {
  test("returns the whole number of samples a period spans", () => {
    expect(samplesPerBin(4000, 1000)).toBe(4);
    expect(samplesPerBin(1e6 / 30_000, 30_000)).toBe(1);
    expect(samplesPerBin((4096 * 1e6) / 30_000, 30_000)).toBe(4096);
  });

  test("returns the nearest integer to a period that carries rounding error", () => {
    expect(samplesPerBin(136_533.33333333334, 30_000)).toBe(4096);
    expect(samplesPerBin((16 * 1e6) / 24_414.0625, 24_414.0625)).toBe(16);
  });

  test("rounds a value halfway between two integers up", () => {
    expect(samplesPerBin(2500, 1000)).toBe(3);
    expect(samplesPerBin(3500, 1000)).toBe(4);
    expect(samplesPerBin(2499, 1000)).toBe(2);
  });

  test("returns 0 for a width that is not finite", () => {
    expect(samplesPerBin(Infinity, 1000)).toBe(0);
    expect(samplesPerBin(NaN, 1000)).toBe(0);
  });
});

describe("levelBins", () => {
  test("divides the sample count when it is a multiple of the width", () => {
    expect(levelBins(400, 4)).toBe(100);
  });

  test("adds a bin for a short last block", () => {
    expect(levelBins(401, 4)).toBe(101);
    expect(levelBins(3, 4)).toBe(1);
  });

  test("returns 0 for no samples", () => {
    expect(levelBins(0, 4)).toBe(0);
  });

  test("rounds up exactly for counts beyond the precision of a quotient", () => {
    const width = 2 ** 31;
    const count = 2 ** 52 + 1;
    expect(levelBins(count, width)).toBe(2 ** 21 + 1);
  });
});

describe("binIndexRange", () => {
  /** Ten 1000 us entries anchored away from time zero. */
  const START_US = 1_000_000;
  const at = (entry: number) => START_US + entry * 1000;
  const range = (startUs: number, endUs: number, length = 10) =>
    binIndexRange({ startUs, endUs }, START_US, 1000, 1, length);

  test("returns the entries a window overlaps", () => {
    expect(range(at(2), at(5))).toEqual({ start: 2, end: 5 });
  });

  test("includes an entry that overlaps the window only in part", () => {
    expect(range(at(1) + 500, at(3) + 500)).toEqual({ start: 1, end: 4 });
  });

  test("excludes an entry starting exactly at endUs", () => {
    expect(range(at(0), at(3))).toEqual({ start: 0, end: 3 });
  });

  test("clamps a window that overruns the grid at both ends", () => {
    expect(range(0, at(50))).toEqual({ start: 0, end: 10 });
  });

  test("returns an empty range for a window outside the grid", () => {
    expect(range(0, 500_000)).toEqual({ start: 0, end: 0 });
    expect(range(at(20), at(30))).toEqual({ start: 10, end: 10 });
  });

  test("returns the single entry holding a window narrower than one entry", () => {
    expect(range(at(4) + 100, at(4) + 200)).toEqual({ start: 4, end: 5 });
  });

  test("returns an empty range for a window of zero width", () => {
    expect(range(at(3), at(3))).toEqual({ start: 3, end: 3 });
    expect(range(at(3) + 500, at(3) + 500)).toEqual({ start: 3, end: 3 });
  });

  test("returns an empty range for a grid with no entries", () => {
    expect(range(at(0), at(5), 0)).toEqual({ start: 0, end: 0 });
  });

  test("handles a grid and a window below zero", () => {
    const early = (startUs: number, endUs: number) =>
      binIndexRange({ startUs, endUs }, -5000, 1000, 1, 10);
    expect(early(-3000, -1000)).toEqual({ start: 2, end: 4 });
    expect(early(-3500, 500)).toEqual({ start: 1, end: 6 });
  });

  test("accepts infinite bounds", () => {
    expect(range(-Infinity, Infinity)).toEqual({ start: 0, end: 10 });
    expect(range(Infinity, Infinity)).toEqual({ start: 10, end: 10 });
  });

  test("accepts a bound that is not a whole number of microseconds", () => {
    expect(range(at(2) + 0.5, at(5) - 0.5)).toEqual({ start: 2, end: 5 });
    expect(range(at(2) - 0.5, at(5) + 0.5)).toEqual({ start: 1, end: 6 });
  });

  test("groups samples into entries of samplesPerBin samples", () => {
    // Entries of 4 samples at 1000 Hz span 4000 us.
    const bins = (startUs: number, endUs: number) =>
      binIndexRange({ startUs, endUs }, START_US, 1000, 4, 100);
    expect(bins(START_US + 8000, START_US + 20_000)).toEqual({
      start: 2,
      end: 5,
    });
    expect(bins(START_US + 8001, START_US + 19_999)).toEqual({
      start: 2,
      end: 5,
    });
  });

  test("rejects a window whose end precedes its start", () => {
    expect(() => range(at(5), at(2))).toThrow(RangeError);
  });

  test("rejects a bound that is NaN", () => {
    expect(() => range(NaN, at(2))).toThrow(RangeError);
    expect(() => range(at(2), NaN)).toThrow(RangeError);
  });

  test("rejects a rate that is not a finite number above zero", () => {
    for (const rateHz of [0, -1, NaN, Infinity]) {
      expect(() =>
        binIndexRange({ startUs: 0, endUs: 10 }, 0, rateHz, 1, 10),
      ).toThrow(RangeError);
    }
  });

  test("rejects a width that is not an integer of at least 1", () => {
    for (const width of [0, -2, 1.5, NaN]) {
      expect(() =>
        binIndexRange({ startUs: 0, endUs: 10 }, 0, 1000, width, 10),
      ).toThrow(RangeError);
    }
  });

  test("anchors entries to an offset that is not a multiple of the period", () => {
    const offset = 1_000_123;
    const grid = (startUs: number, endUs: number) =>
      binIndexRange({ startUs, endUs }, offset, 1000, 1, 10);
    expect(grid(1_002_123, 1_005_123)).toEqual({ start: 2, end: 5 });
    expect(grid(1_002_000, 1_005_000)).toEqual({ start: 1, end: 5 });
    expect(grid(998_000, 1_000_500)).toEqual({ start: 0, end: 1 });
    expect(grid(1_004_500, 1_004_600)).toEqual({ start: 4, end: 5 });
  });

  describe("at 30000 Hz from an epoch-scale offset", () => {
    const RATE_HZ = 30_000;
    // Entry i starts at EPOCH_US + i * 100 / 3 us: a multiple of 100 us every third
    // entry, so most entry edges are not whole microseconds.
    const grid = (startUs: number, endUs: number, length = 1_000_000) =>
      binIndexRange({ startUs, endUs }, EPOCH_US, RATE_HZ, 1, length);

    test("keeps a window bound on an entry edge on that edge", () => {
      for (const index of [3, 30, 3000, 29_997, 3_000_000 - 3]) {
        const edgeUs = EPOCH_US + (index * 100) / 3;
        expect(Number.isInteger(edgeUs)).toBe(true);
        expect(grid(edgeUs, edgeUs + 100, 4_000_000)).toEqual({
          start: index,
          end: index + 3,
        });
      }
    });

    test("includes the entry that starts just before a whole-microsecond bound", () => {
      // Sample 1 starts at 33.33 us, so a window from 34 us holds it.
      expect(grid(EPOCH_US + 34, EPOCH_US + 67)).toEqual({ start: 1, end: 3 });
      expect(grid(EPOCH_US + 33, EPOCH_US + 34)).toEqual({ start: 0, end: 2 });
    });

    test("separates a bound one microsecond either side of an edge", () => {
      const edgeUs = EPOCH_US + 100;
      expect(grid(edgeUs - 1, edgeUs + 1)).toEqual({ start: 2, end: 4 });
      expect(grid(edgeUs, edgeUs + 1)).toEqual({ start: 3, end: 4 });
      expect(grid(edgeUs - 1, edgeUs)).toEqual({ start: 2, end: 3 });
    });

    test("maps a level of 4096 samples to whole levels of 4096 samples", () => {
      const bins = binIndexRange(
        { startUs: EPOCH_US, endUs: EPOCH_US + 1_000_000 },
        EPOCH_US,
        RATE_HZ,
        4096,
        1000,
      );
      expect(bins).toEqual({ start: 0, end: 8 });
    });
  });

  describe("at 24414.0625 Hz from an epoch-scale offset", () => {
    const RATE_HZ = 24_414.0625;
    // The sample period is exactly 40.96 us.
    const grid = (startUs: number, endUs: number) =>
      binIndexRange({ startUs, endUs }, EPOCH_US, RATE_HZ, 1, 10_000_000);

    test("keeps a window bound on an entry edge on that edge", () => {
      // Entry 1000 starts at 40960 us.
      const edgeUs = EPOCH_US + 40_960;
      expect(grid(edgeUs, edgeUs + 41)).toEqual({ start: 1000, end: 1002 });
      expect(grid(edgeUs - 1, edgeUs)).toEqual({ start: 999, end: 1000 });
    });

    test("maps a window of one second to the samples it overlaps", () => {
      const { start, end } = grid(EPOCH_US, EPOCH_US + 1_000_000);
      expect(start).toBe(0);
      expect(end).toBe(24_415);
    });
  });
});

describe("binStartUs", () => {
  test("evaluates the grid time of sample samplesPerBin * index in binary64 order", () => {
    expect(binStartUs(0, EPOCH_US, 30_000, 1)).toBe(EPOCH_US);
    expect(binStartUs(3, EPOCH_US, 30_000, 1)).toBe(EPOCH_US + 100);
    expect(binStartUs(5, EPOCH_US, 30_000, 4096)).toBe(
      EPOCH_US + (4096 * 5 * 1e6) / 30_000,
    );
  });

  test("supports a negative offset", () => {
    expect(binStartUs(2, -5000, 1000, 1)).toBe(-3000);
  });
});

describe("binEdgeUs", () => {
  test("returns an edge that is a whole microsecond unchanged", () => {
    expect(binEdgeUs(3, EPOCH_US, 30_000, 1, "floor")).toBe(EPOCH_US + 100);
    expect(binEdgeUs(3, EPOCH_US, 30_000, 1, "ceil")).toBe(EPOCH_US + 100);
  });

  test("rounds an edge between two microseconds in the requested direction", () => {
    // Sample 1 is at 33.33 us.
    expect(binEdgeUs(1, EPOCH_US, 30_000, 1, "floor")).toBe(EPOCH_US + 33);
    expect(binEdgeUs(1, EPOCH_US, 30_000, 1, "ceil")).toBe(EPOCH_US + 34);
    expect(binEdgeUs(2, EPOCH_US, 30_000, 1, "floor")).toBe(EPOCH_US + 66);
    expect(binEdgeUs(2, EPOCH_US, 30_000, 1, "ceil")).toBe(EPOCH_US + 67);
  });

  test("rounds a level edge at 24414.0625 Hz exactly", () => {
    // 16 samples span 655360 / 1000 = 655.36 us.
    expect(binEdgeUs(1, EPOCH_US, 24_414.0625, 16, "floor")).toBe(
      EPOCH_US + 655,
    );
    expect(binEdgeUs(1, EPOCH_US, 24_414.0625, 16, "ceil")).toBe(
      EPOCH_US + 656,
    );
  });

  test("rounds toward the requested side for a negative offset", () => {
    expect(binEdgeUs(1, -1000, 30_000, 1, "floor")).toBe(-1000 + 33);
    expect(binEdgeUs(1, -1000, 30_000, 1, "ceil")).toBe(-1000 + 34);
  });
});

describe("channelEndUs", () => {
  test("adds the exact duration of the samples, rounded up", () => {
    expect(channelEndUs(EPOCH_US, 30_000, 30_000)).toBe(EPOCH_US + 1_000_000);
    expect(channelEndUs(EPOCH_US, 1, 30_000)).toBe(EPOCH_US + 34);
    expect(channelEndUs(EPOCH_US, 100_001, 30_000)).toBe(EPOCH_US + 3_333_367);
  });

  test("returns the offset for a channel with no samples", () => {
    expect(channelEndUs(EPOCH_US, 0, 30_000)).toBe(EPOCH_US);
  });

  test("rounds up the duration at 24414.0625 Hz", () => {
    expect(channelEndUs(0, 1953125, 24_414.0625)).toBe(80_000_000);
    expect(channelEndUs(0, 1, 24_414.0625)).toBe(41);
  });
});

describe("wholeSamples", () => {
  test("returns the sample count of an offset that is a whole number of samples", () => {
    expect(wholeSamples(100, 30_000)).toBe(3);
    expect(wholeSamples(-100_000, 30_000)).toBe(-3000);
    expect(wholeSamples(0, 30_000)).toBe(0);
    expect(wholeSamples(4000, 1000)).toBe(4);
  });

  test("returns undefined for an offset that is not", () => {
    expect(wholeSamples(33, 30_000)).toBeUndefined();
    expect(wholeSamples(34, 30_000)).toBeUndefined();
    expect(wholeSamples(1500, 1000)).toBeUndefined();
  });

  test("is exact at 24414.0625 Hz", () => {
    expect(wholeSamples(40_960, 24_414.0625)).toBe(1000);
    expect(wholeSamples(40_961, 24_414.0625)).toBeUndefined();
  });

  test("rejects a rate that is not a finite number above zero", () => {
    expect(() => wholeSamples(100, 0)).toThrow(RangeError);
  });
});

describe("count levels", () => {
  test("maps a window to the bins it overlaps", () => {
    expect(
      countBinRange({ startUs: 1_500, endUs: 3_500 }, 1000, 1000, 10),
    ).toEqual({ start: 0, end: 3 });
    expect(
      countBinRange({ startUs: 0, endUs: 100_000 }, 1000, 1000, 10),
    ).toEqual({ start: 0, end: 10 });
  });

  test("is exact for a period and offset beyond float precision of their product", () => {
    const periodUs = 1_000_003;
    const offsetUs = EPOCH_US - (EPOCH_US % periodUs);
    const edgeUs = offsetUs + 5 * periodUs;
    expect(
      countBinRange(
        { startUs: edgeUs, endUs: edgeUs + 1 },
        offsetUs,
        periodUs,
        9,
      ),
    ).toEqual({ start: 5, end: 6 });
    expect(
      countBinRange(
        { startUs: edgeUs - 1, endUs: edgeUs },
        offsetUs,
        periodUs,
        9,
      ),
    ).toEqual({ start: 4, end: 5 });
  });

  test("starts a bin at the offset plus whole periods", () => {
    expect(countBinStartUs(0, 1000, 4000)).toBe(1000);
    expect(countBinStartUs(3, 1000, 4000)).toBe(13_000);
  });
});
