import type { Segment } from "./types.js";

/**
 * Trim a fetched segment to a query window.
 * Drops whole bins that fall entirely outside the window. Any bin that overlaps the
 * window is kept, including one that only partially overlaps at an edge.
 *
 * The fetched slice is already bin-aligned, so this only removes a few leading/trailing
 * bins. The result keeps the same channel, samplePeriodUs, and isMinMax; its data is
 * sliced to the kept bins and its startUs advances to the first kept bin. For a min/max
 * segment (isMinMax) each bin is a [min, max] pair, so bins are dropped two values at a
 * time.
 *
 * `startUs` and `endUs` are the query bounds in microseconds, with `endUs` exclusive: a
 * bin starting exactly at `endUs` is dropped. If no bin overlaps the window the result has
 * empty data and startUs is left unchanged.
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
  // The first kept bin is the one holding startUs, the last is the one holding the final
  // instant before endUs, each clamped to the bins the segment actually has.
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
    // A view, not a copy: trimming only shaves edge bins off a freshly fetched window.
    data: data.subarray(firstBin * valuesPerBin, (lastBin + 1) * valuesPerBin),
  };
}
