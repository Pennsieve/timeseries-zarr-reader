/**
 * Time arithmetic for the grids of a bundle: the raw samples of a channel and the bins
 * of each level.
 *
 * Entry `i` of a grid with offset `offsetUs`, rate `rateHz`, and `samplesPerBin` samples
 * per entry starts at the grid time of sample `samplesPerBin * i`. Raw samples have one
 * sample per entry.
 */

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

  // Entry `i` starts at `offsetUs + i * samplesPerBin * 1e6 / rateHz`, so a time `t`
  // lies at index `(t - offsetUs) * rateHz / (samplesPerBin * 1e6)`.
  const offset = toDyadic(offsetUs);
  const rate = toDyadic(rateHz);
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
    const time = toDyadic(timeUs);
    const shift = Math.max(time.shift, offset.shift);
    const difference =
      (time.numerator << BigInt(shift - time.shift)) -
      (offset.numerator << BigInt(shift - offset.shift));
    return clamp(
      round(
        difference * rate.numerator,
        (1n << BigInt(shift + rate.shift)) *
          BigInt(samplesPerBin) *
          MICROSECONDS_BIG,
      ),
    );
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
 * Returns the time just after the last of `sampleCount` samples that start at
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
