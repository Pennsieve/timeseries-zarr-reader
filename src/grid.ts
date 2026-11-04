/**
 * Time arithmetic for the grids of a bundle: the raw samples of a channel and the bins
 * of each level.
 *
 * Entry `i` of a grid with offset `offsetUs`, rate `rateHz`, and `samplesPerBin` samples
 * per entry starts at the grid time of sample `samplesPerBin * i`. Raw samples have one
 * sample per entry.
 */

import type { Run } from "./types.js";

const MICROSECONDS_PER_SECOND = 1e6;
const MICROSECONDS_BIG = 1_000_000n;

/** A finite binary64 value as `numerator / 2^shift`, with `shift >= 0`. */
interface Dyadic {
  readonly numerator: bigint;
  readonly shift: number;
}

const view = new DataView(new ArrayBuffer(8));

/** Splits a finite number into its exact value `numerator / 2^shift`. */
function toDyadic(value: number): Dyadic {
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = high >>> 31 === 1;
  const biasedExponent = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent: number;
  if (biasedExponent === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = biasedExponent - 1075;
  }
  const signed = negative ? -mantissa : mantissa;
  return exponent >= 0
    ? { numerator: signed << BigInt(exponent), shift: 0 }
    : { numerator: signed, shift: -exponent };
}

/** Returns `floor(numerator / denominator)` for a positive `denominator`. */
function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator < 0n ? quotient - 1n : quotient;
}

/** Returns `ceil(numerator / denominator)` for a positive `denominator`. */
function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator > 0n ? quotient + 1n : quotient;
}

/**
 * Returns the entry index of a finite time, rounded by `round` and not clamped.
 *
 * Entry `i` starts at `originUs + i * samplesPerBin * 1e6 / rateHz`, so a time `t` lies at
 * index `(t - originUs) * rateHz / (samplesPerBin * 1e6)`. The quotient is exact.
 */
function exactIndex(
  timeUs: number,
  originUs: number,
  rateHz: number,
  samplesPerBin: number,
  round: (numerator: bigint, denominator: bigint) => bigint,
): bigint {
  const time = toDyadic(timeUs);
  const origin = toDyadic(originUs);
  const rate = toDyadic(rateHz);
  const shift = Math.max(time.shift, origin.shift);
  const difference =
    (time.numerator << BigInt(shift - time.shift)) -
    (origin.numerator << BigInt(shift - origin.shift));
  return round(
    difference * rate.numerator,
    (1n << BigInt(shift + rate.shift)) *
      BigInt(samplesPerBin) *
      MICROSECONDS_BIG,
  );
}

function requireRate(rateHz: number): void {
  if (!(rateHz > 0) || !Number.isFinite(rateHz)) {
    throw new RangeError(
      `rateHz must be a finite number greater than 0 (got ${rateHz})`,
    );
  }
}

function requireSamplesPerBin(samplesPerBin: number): void {
  if (!Number.isSafeInteger(samplesPerBin) || samplesPerBin < 1) {
    throw new RangeError(
      `samplesPerBin must be an integer of at least 1 (got ${samplesPerBin})`,
    );
  }
}

/**
 * Returns the width of a level in samples: the integer nearest to
 * `periodUs * rateHz / 1e6`, the larger of two equally near integers.
 *
 * The product and quotient are evaluated in binary64. Returns 0 when the value is not
 * finite.
 */
export function samplesPerBin(periodUs: number, rateHz: number): number {
  const width = (periodUs * rateHz) / MICROSECONDS_PER_SECOND;
  if (!Number.isFinite(width)) {
    return 0;
  }
  const floor = Math.floor(width);
  return width - floor >= 0.5 ? floor + 1 : floor;
}

/**
 * Returns the number of bins that cover `sampleCount` samples at `samplesPerBin`
 * samples per bin. The last bin may cover fewer samples.
 */
export function levelBins(sampleCount: number, samplesPerBin: number): number {
  const remainder = sampleCount % samplesPerBin;
  return (sampleCount - remainder) / samplesPerBin + (remainder > 0 ? 1 : 0);
}

/**
 * Returns the half-open index range of the entries that overlap the window
 * `[startUs, endUs)`, clamped to `[0, length]`.
 *
 * An entry that starts exactly at `endUs` is outside the range, and a window of zero
 * width gives an empty range. The range is exact: the bounds are compared with the
 * entry edges as rational numbers, so a bound on an entry edge never lands in the
 * neighboring entry through rounding. A bound may be infinite.
 *
 * Throws a RangeError when `endUs` precedes `startUs`, either bound is NaN, `rateHz`
 * is not a finite number above 0, or `samplesPerBin` is not an integer of at least 1.
 */
export function binIndexRange(
  window: { readonly startUs: number; readonly endUs: number },
  offsetUs: number,
  rateHz: number,
  samplesPerBin: number,
  length: number,
): { start: number; end: number } {
  const { startUs, endUs } = window;
  if (Number.isNaN(startUs) || Number.isNaN(endUs) || endUs < startUs) {
    throw new RangeError(
      `endUs must not precede startUs (got ${startUs} and ${endUs})`,
    );
  }
  requireRate(rateHz);
  requireSamplesPerBin(samplesPerBin);

  const bigLength = BigInt(length);
  const clamp = (index: bigint): bigint =>
    index < 0n ? 0n : index > bigLength ? bigLength : index;

  const divide = (
    timeUs: number,
    round: (numerator: bigint, denominator: bigint) => bigint,
  ): bigint => {
    if (timeUs === Infinity) {
      return bigLength;
    }
    if (timeUs === -Infinity) {
      return 0n;
    }
    return clamp(exactIndex(timeUs, offsetUs, rateHz, samplesPerBin, round));
  };

  const start = divide(startUs, floorDivide);
  if (endUs === startUs) {
    return { start: Number(start), end: Number(start) };
  }
  const end = divide(endUs, ceilDivide);
  return { start: Number(start), end: Number(end > start ? end : start) };
}

/**
 * Returns the start time of entry `index`, in microseconds: the grid time of sample
 * `samplesPerBin * index`.
 *
 * The result is `offsetUs + ((samplesPerBin * index) * 1e6) / rateHz` evaluated in
 * binary64, one rounding per operation, as the specification defines a time.
 */
export function binStartUs(
  index: number,
  offsetUs: number,
  rateHz: number,
  samplesPerBin: number,
): number {
  return offsetUs + (samplesPerBin * index * MICROSECONDS_PER_SECOND) / rateHz;
}

/**
 * Returns the start time of entry `index` as a whole number of microseconds, rounded
 * down or up from the exact grid time.
 *
 * Passing `index` one past an entry gives that entry's end.
 */
export function binEdgeUs(
  index: number,
  offsetUs: number,
  rateHz: number,
  samplesPerBin: number,
  rounding: "floor" | "ceil",
): number {
  requireRate(rateHz);
  requireSamplesPerBin(samplesPerBin);
  const rate = toDyadic(rateHz);
  // The exact offset is an integer, so rounding the offset-free quotient is exact.
  const scaled =
    BigInt(samplesPerBin) *
    BigInt(index) *
    MICROSECONDS_BIG *
    (1n << BigInt(rate.shift));
  const divide = rounding === "floor" ? floorDivide : ceilDivide;
  return offsetUs + Number(divide(scaled, rate.numerator));
}

/**
 * Returns the end of the last of `sampleCount` samples that start at
 * `offsetUs`, rounded up to a whole microsecond.
 *
 * A window from `offsetUs` to this time holds every sample.
 */
export function channelEndUs(
  offsetUs: number,
  sampleCount: number,
  rateHz: number,
): number {
  return binEdgeUs(sampleCount, offsetUs, rateHz, 1, "ceil");
}

/**
 * Returns the number of samples that `durationUs` spans at `rateHz`, or undefined when
 * that is not a whole number. `durationUs` is a whole number of microseconds and may be
 * negative.
 */
export function wholeSamples(
  durationUs: number,
  rateHz: number,
): number | undefined {
  requireRate(rateHz);
  const rate = toDyadic(rateHz);
  const duration = toDyadic(durationUs);
  const numerator = duration.numerator * rate.numerator;
  const denominator =
    (1n << BigInt(duration.shift + rate.shift)) * MICROSECONDS_BIG;
  return numerator % denominator === 0n
    ? Number(numerator / denominator)
    : undefined;
}

/**
 * Returns the index range of the bins of a count level that overlap the window
 * `[startUs, endUs)`.
 *
 * A count level's `periodUs` is a whole number of microseconds, so the range is exact.
 * The rules and errors of {@link binIndexRange} apply.
 */
export function countBinRange(
  window: { readonly startUs: number; readonly endUs: number },
  offsetUs: number,
  periodUs: number,
  length: number,
): { start: number; end: number } {
  return binIndexRange(
    window,
    offsetUs,
    MICROSECONDS_PER_SECOND,
    periodUs,
    length,
  );
}

/** Returns the start time of bin `index` of a count level, in microseconds. */
export function countBinStartUs(
  index: number,
  offsetUs: number,
  periodUs: number,
): number {
  return offsetUs + index * periodUs;
}

/** The fields of a run that place its samples in time. */
type RunTimes = Pick<Run, "firstSample" | "sampleCount" | "startUs">;

/** Returns the number of runs that satisfy `before`, which holds for a prefix of them. */
function countWhile(
  runs: readonly RunTimes[],
  before: (run: RunTimes) => boolean,
): number {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (before(runs[middle]!)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Returns the half-open index range of the raw samples that overlap the window
 * `[startUs, endUs)`, for a channel with a runs table.
 *
 * A sample inside a run starts at the exact time the table gives. A sample between two
 * runs starts at its grid time. An entry that starts exactly at `endUs` is outside the
 * range, and a window of zero width or outside the channel gives an empty range. The
 * range is exact, as in {@link binIndexRange}, and may be infinite at either end.
 *
 * Throws a RangeError when `endUs` precedes `startUs`, either bound is NaN, or `rateHz`
 * is not a finite number above 0.
 */
export function runIndexRange(
  window: { readonly startUs: number; readonly endUs: number },
  runs: readonly RunTimes[],
  offsetUs: number,
  rateHz: number,
  length: number,
): { start: number; end: number } {
  const { startUs, endUs } = window;
  if (Number.isNaN(startUs) || Number.isNaN(endUs) || endUs < startUs) {
    throw new RangeError(
      `endUs must not precede startUs (got ${startUs} and ${endUs})`,
    );
  }
  requireRate(rateHz);

  const bigLength = BigInt(length);
  // The index of the sample that a time falls in, from the run `row` or the grid. A
  // time past the end of its run lands on the grid, between that run and the next.
  const locate = (
    timeUs: number,
    row: number,
    round: (numerator: bigint, denominator: bigint) => bigint,
  ): number => {
    const run = runs[row]!;
    const runEnd = BigInt(run.firstSample + run.sampleCount);
    const following = BigInt(runs[row + 1]?.firstSample ?? length);
    let index =
      BigInt(run.firstSample) +
      exactIndex(timeUs, run.startUs, rateHz, 1, round);
    if (index >= runEnd) {
      const grid = exactIndex(timeUs, offsetUs, rateHz, 1, round);
      const low = grid > runEnd ? grid : runEnd;
      index = low < following ? low : following;
    }
    return Number(index < bigLength ? index : bigLength);
  };

  let first = 0;
  if (startUs === Infinity) {
    first = length;
  } else if (startUs > -Infinity) {
    const row = countWhile(runs, (run) => run.startUs <= startUs) - 1;
    if (row >= 0) {
      first = locate(startUs, row, floorDivide);
    }
  }
  if (endUs === startUs) {
    return { start: first, end: first };
  }

  let stop = length;
  if (endUs === -Infinity) {
    stop = 0;
  } else if (endUs < Infinity) {
    const row = countWhile(runs, (run) => run.startUs < endUs) - 1;
    stop = row >= 0 ? locate(endUs, row, ceilDivide) : 0;
  }
  return { start: first, end: Math.max(stop, first) };
}

/**
 * Returns the start time of raw sample `index`, in microseconds.
 *
 * A sample inside a run is at the run's `startUs` plus its distance from the run's first
 * sample, and any other sample is at its grid time. Both are evaluated in binary64 in the
 * order of {@link binStartUs}. Pass no `runs` for a channel without a runs table.
 */
export function entryTimeUs(
  index: number,
  offsetUs: number,
  rateHz: number,
  runs?: readonly RunTimes[],
): number {
  if (runs !== undefined) {
    const row = countWhile(runs, (run) => run.firstSample <= index) - 1;
    const run = runs[row];
    if (run !== undefined && index < run.firstSample + run.sampleCount) {
      return binStartUs(index - run.firstSample, run.startUs, rateHz, 1);
    }
  }
  return binStartUs(index, offsetUs, rateHz, 1);
}

/**
 * Returns the start or the end of raw sample `index` as a whole number of microseconds,
 * rounded down for a start and up for an end.
 *
 * The time is exact where {@link entryTimeUs} is binary64. A sample ends one sample
 * period after it starts.
 */
export function entryEdgeUs(
  index: number,
  offsetUs: number,
  rateHz: number,
  runs: readonly RunTimes[] | undefined,
  side: "start" | "end",
): number {
  const rounding = side === "start" ? "floor" : "ceil";
  const past = side === "start" ? 0 : 1;
  if (runs !== undefined) {
    const row = countWhile(runs, (run) => run.firstSample <= index) - 1;
    const run = runs[row];
    if (run !== undefined && index < run.firstSample + run.sampleCount) {
      return binEdgeUs(
        index - run.firstSample + past,
        run.startUs,
        rateHz,
        1,
        rounding,
      );
    }
  }
  return binEdgeUs(index + past, offsetUs, rateHz, 1, rounding);
}
