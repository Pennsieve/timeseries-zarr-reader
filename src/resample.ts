import type { LevelMember, Segment } from "./types.js";

/**
 * Resamples a segment to one [min, max] pair per output pixel.
 *
 * Buckets are `pixelWidthUs` wide and lie on the grid of multiples of `pixelWidthUs`
 * from `anchorUs`. Segments resampled with the same anchor and pixel width land on one
 * shared grid whatever window they cover. The result's `startUs` is the start of the
 * bucket holding the segment's first bin, at or before the segment's own start.
 *
 * Raw input is reduced to the min and max of each bucket, and envelope input merges
 * pairs (smallest min, largest max). Partial buckets at either edge are kept. Empty
 * input yields empty data.
 *
 * Non-finite values are skipped. A bucket with no finite values yields [NaN, NaN].
 *
 * The result is envelope data. `isMinMax` is true and `samplePeriodUs` becomes
 * `pixelWidthUs`. Throws RangeError when `pixelWidthUs < samplePeriodUs`.
 *
 * The result carries the statistics named in `members`, one value per bucket, and no
 * other. Raw input computes them from the finite samples of the bucket. Envelope
 * input folds the bins it covers that have a `count` above 0. The bucket's `count` is
 * their sum, its `mean` their count-weighted mean of means, and its `variance` their
 * count-weighted mean of `variance + (mean - bucketMean)^2`. A bucket that holds a
 * single such bin copies its statistics. A bucket with `count` 0 holds NaN in `mean`
 * and `variance`. Envelope input lacking the statistics a member needs yields no
 * array for it: `mean` needs `count` and `mean`, and `variance` needs `count`,
 * `mean`, and `variance`.
 *
 * @param pixelWidthUs - Time span of one output pixel column, in microseconds.
 * @param anchorUs - Origin of the bucket grid, in microseconds.
 * @param members - The statistics to carry on the result. Defaults to none.
 */
export function resampleToPixels(
  segment: Segment,
  pixelWidthUs: number,
  anchorUs: number,
  members: readonly LevelMember[] = [],
): Segment {
  const { data, samplePeriodUs, isMinMax } = segment;
  if (pixelWidthUs < samplePeriodUs) {
    throw new RangeError(
      `pixelWidthUs (${pixelWidthUs}) must be at least samplePeriodUs (${samplePeriodUs})`,
    );
  }

  const valuesPerBin = isMinMax ? 2 : 1;
  const binCount = data.length / valuesPerBin;
  // Every bin, the first included, takes its pixel from one expression, so the
  // first bin is always pixel 0.
  const firstPixel = Math.floor((segment.startUs - anchorUs) / pixelWidthUs);
  const startUs = anchorUs + firstPixel * pixelWidthUs;
  const pixelOf = (bin: number): number =>
    Math.floor(
      (segment.startUs + bin * samplePeriodUs - anchorUs) / pixelWidthUs,
    ) - firstPixel;
  const pixelCount = binCount === 0 ? 0 : pixelOf(binCount - 1) + 1;
  const out = new Float64Array(pixelCount * 2);

  const stats = createStatistics(segment, members, pixelCount);

  // pixelWidthUs >= samplePeriodUs, so bins never skip a pixel and one forward scan
  // fills the output.
  let bin = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const firstBin = bin;
    let min = Infinity;
    let max = -Infinity;
    while (bin < binCount && pixelOf(bin) === pixel) {
      const end = (bin + 1) * valuesPerBin;
      for (let i = bin * valuesPerBin; i < end; i++) {
        const value = data[i]!;
        if (Number.isFinite(value)) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      bin++;
    }
    const isGap = min === Infinity;
    out[pixel * 2] = isGap ? NaN : min;
    out[pixel * 2 + 1] = isGap ? NaN : max;
    if (stats !== undefined) {
      if (isMinMax) {
        foldBins(segment, stats, pixel, firstBin, bin);
      } else {
        foldSamples(data, stats, pixel, firstBin, bin);
      }
    }
  }

  return {
    channel: segment.channel,
    startUs,
    samplePeriodUs: pixelWidthUs,
    isMinMax: true,
    data: out,
    ...stats,
  };
}

/** The per-pixel statistics under construction. A field is absent when not produced. */
interface Statistics {
  count?: Float64Array;
  mean?: Float64Array;
  variance?: Float64Array;
}

/**
 * Allocates the arrays of the requested statistics the input can supply, or returns
 * undefined when there are none.
 */
function createStatistics(
  segment: Segment,
  members: readonly LevelMember[],
  pixelCount: number,
): Statistics | undefined {
  const { count, mean, variance } = segment;
  const raw = !segment.isMinMax;
  const stats: Statistics = {};
  if (members.includes("count") && (raw || count !== undefined)) {
    stats.count = new Float64Array(pixelCount);
  }
  const hasMean = raw || (count !== undefined && mean !== undefined);
  if (members.includes("mean") && hasMean) {
    stats.mean = new Float64Array(pixelCount);
  }
  if (members.includes("var") && hasMean && (raw || variance !== undefined)) {
    stats.variance = new Float64Array(pixelCount);
  }
  return Object.keys(stats).length === 0 ? undefined : stats;
}

/** Computes the statistics of the finite samples `data[first, stop)` into `pixel`. */
function foldSamples(
  data: Float64Array,
  stats: Statistics,
  pixel: number,
  first: number,
  stop: number,
): void {
  let count = 0;
  let sum = 0;
  for (let i = first; i < stop; i++) {
    const value = data[i]!;
    if (Number.isFinite(value)) {
      count++;
      sum += value;
    }
  }
  const mean = count === 0 ? NaN : sum / count;
  if (stats.count !== undefined) stats.count[pixel] = count;
  if (stats.mean !== undefined) stats.mean[pixel] = mean;
  if (stats.variance !== undefined) {
    let squares = 0;
    for (let i = first; i < stop; i++) {
      const value = data[i]!;
      if (Number.isFinite(value)) {
        squares += (value - mean) ** 2;
      }
    }
    stats.variance[pixel] = count === 0 ? NaN : squares / count;
  }
}

/** Folds the statistics of bins `[first, stop)` of an envelope segment into `pixel`. */
function foldBins(
  segment: Segment,
  stats: Statistics,
  pixel: number,
  first: number,
  stop: number,
): void {
  const { count, mean, variance } = segment;
  let total = 0;
  let populated = 0;
  let only = first;
  if (count !== undefined) {
    for (let b = first; b < stop; b++) {
      if (count[b]! > 0) {
        total += count[b]!;
        populated++;
        only = b;
      }
    }
  }
  if (stats.count !== undefined) stats.count[pixel] = total;

  if (stats.mean === undefined && stats.variance === undefined) {
    return;
  }
  if (populated === 0) {
    if (stats.mean !== undefined) stats.mean[pixel] = NaN;
    if (stats.variance !== undefined) stats.variance[pixel] = NaN;
    return;
  }
  // A lone child is the bucket, and its stored values carry no rounding from a
  // weighted sum.
  if (populated === 1) {
    if (stats.mean !== undefined) stats.mean[pixel] = mean![only]!;
    if (stats.variance !== undefined) {
      stats.variance[pixel] = variance![only]!;
    }
    return;
  }
  let weighted = 0;
  for (let b = first; b < stop; b++) {
    if (count![b]! > 0) weighted += count![b]! * mean![b]!;
  }
  const bucketMean = weighted / total;
  if (stats.mean !== undefined) stats.mean[pixel] = bucketMean;
  if (stats.variance !== undefined) {
    let spread = 0;
    for (let b = first; b < stop; b++) {
      if (count![b]! > 0) {
        spread += count![b]! * (variance![b]! + (mean![b]! - bucketMean) ** 2);
      }
    }
    stats.variance[pixel] = spread / total;
  }
}
