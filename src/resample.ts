import type { Segment } from "./types";

/**
 * Reduce a segment to one [min, max] pair per output pixel.
 *
 * This is the last pass over a segment before it is handed to the consumer, applied once
 * per (channel, chunk) after the window has been trimmed and any montage or filter
 * applied. Level selection fetches the coarsest pyramid level that is still finer than the
 * pixel grid, so the data in hand is several times denser than the display can show; this
 * pass lands it exactly on the grid. Drawing more points than there are pixels costs time
 * and changes nothing on screen, and reducing by per-pixel extremes is what keeps a brief
 * spike visible instead of aliasing it away.
 *
 * Bins are grouped by time into buckets `pixelWidthUs` wide, anchored at the segment's own
 * startUs rather than a query-wide grid, so no output pixel straddles the segment's start.
 * Raw input reduces the samples in each bucket. Envelope input (isMinMax) merges pairs
 * instead - smallest min, largest max - the same reduction the pyramid uses between its own
 * levels, so resampling a level agrees with reading a coarser one.
 *
 * The result is always envelope data: isMinMax is true, samplePeriodUs becomes
 * `pixelWidthUs`, and channel and startUs carry over. A trailing bucket covering less than
 * a full pixel of time is kept rather than dropped, so no data is lost at the tail. Empty
 * input yields empty data.
 *
 * Non-finite values are skipped while reducing a bucket, so a gap sitting next to real
 * samples does not erase them. A bucket holding nothing but non-finite values yields
 * [NaN, NaN], which preserves the gap.
 *
 * `pixelWidthUs` must be at least `samplePeriodUs` - level selection guarantees it - and
 * that is what makes every output pixel cover at least one source bin. A narrower
 * `pixelWidthUs` throws a RangeError rather than emitting pixels with no data behind them.
 *
 * @param pixelWidthUs - how much time one horizontal pixel of the plot covers: the time
 * window being drawn divided by its width in pixels. Drawing 60 s across 1200 pixels gives
 * 50_000. It is the caller's display resolution restated in the reader's own unit, which is
 * what lets it be compared directly against a pyramid level's period to choose a level, and
 * used here as the output bin width - one output bin is one pixel column. Smaller means
 * more zoomed in. The reader never learns the canvas width or the pixel count, and "pixel"
 * means a column the caller intends to draw, not a device pixel: a caller wanting full
 * crispness on a scaled display passes its backing-store width and gets a finer level.
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

  // Bins are in time order and, because pixelWidthUs is at least samplePeriodUs, never skip
  // a pixel, so one forward scan fills the output. Both values of an envelope bin fold into
  // both accumulators: a bin's min can only lower the pixel's min and its max only raise
  // the pixel's max, so merging envelopes and reducing raw samples share one loop.
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
        const value = data[i] as number;
        if (Number.isFinite(value)) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      bin++;
    }
    // Nothing finite landed in this pixel, so report the gap rather than the sentinels.
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
