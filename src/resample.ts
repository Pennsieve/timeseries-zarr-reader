import type { Segment } from "./types.js";

/**
 * Resamples a segment to one [min, max] pair per output pixel.
 *
 * Buckets are `pixelWidthUs` wide, anchored at the segment's `startUs`. Raw input is
 * reduced to the min and max of each bucket, and envelope input merges pairs (smallest
 * min, largest max). A trailing partial bucket is kept. Empty input yields empty data.
 *
 * Non-finite values are skipped. A bucket with no finite values yields [NaN, NaN].
 *
 * The result is envelope data. `isMinMax` is true and `samplePeriodUs` becomes
 * `pixelWidthUs`. Throws RangeError when `pixelWidthUs < samplePeriodUs`.
 *
 * @param pixelWidthUs - Time span of one output pixel column, in microseconds.
 */
export function resampleToPixels(
  segment: Segment,
  pixelWidthUs: number,
): Segment {
  const { data, samplePeriodUs, isMinMax } = segment;
  if (pixelWidthUs < samplePeriodUs) {
    throw new RangeError(
      `pixelWidthUs (${pixelWidthUs}) must be at least samplePeriodUs (${samplePeriodUs})`,
    );
  }

  const valuesPerBin = isMinMax ? 2 : 1;
  const binCount = data.length / valuesPerBin;
  const pixelCount = Math.ceil((binCount * samplePeriodUs) / pixelWidthUs);
  const out = new Float64Array(pixelCount * 2);

  // pixelWidthUs >= samplePeriodUs, so bins never skip a pixel and one forward scan
  // fills the output.
  let bin = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let min = Infinity;
    let max = -Infinity;
    while (
      bin < binCount &&
      Math.floor((bin * samplePeriodUs) / pixelWidthUs) === pixel
    ) {
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
  }

  return {
    ...segment,
    samplePeriodUs: pixelWidthUs,
    isMinMax: true,
    data: out,
  };
}
