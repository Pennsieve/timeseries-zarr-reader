import type { Segment } from "./types.js";

/**
 * Trims a segment to the query window `[startUs, endUs)`.
 *
 * Drops bins entirely outside the window. A bin that partially overlaps an edge is
 * kept; a bin starting exactly at `endUs` is dropped. A min/max segment drops bins two
 * values at a time. When no bin overlaps the window, the result has empty data and an
 * unchanged `startUs`.
 *
 * The returned data is a view of the input buffer, not a copy.
 */
export function trimToBounds(
  segment: Segment,
  startUs: number,
  endUs: number,
): Segment {
  const { data, samplePeriodUs, isMinMax } = segment;
  const valuesPerBin = isMinMax ? 2 : 1;
  const binCount = data.length / valuesPerBin;

  // Bin i covers [segment.startUs + i * period, segment.startUs + (i + 1) * period).
  const firstBin = Math.max(
    0,
    Math.floor((startUs - segment.startUs) / samplePeriodUs),
  );
  const lastBin = Math.min(
    binCount - 1,
    Math.ceil((endUs - segment.startUs) / samplePeriodUs) - 1,
  );

  if (firstBin > lastBin) {
    return { ...segment, data: new Float64Array(0) };
  }

  return {
    ...segment,
    startUs: segment.startUs + firstBin * samplePeriodUs,
    data: data.subarray(firstBin * valuesPerBin, (lastBin + 1) * valuesPerBin),
  };
}
