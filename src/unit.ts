import { MIN_WAVEFORM_PIXELS } from "./constants.js";
import type { UnitArrays } from "./catalog.js";
import type { EventBatch, Store, StoreOptions } from "./types.js";
import type { TimestampReader } from "./zarr.js";
import { openTimestamps, readRows } from "./zarr.js";

/**
 * Reports whether spike waveforms should be fetched at a display resolution.
 *
 * Returns true when one waveform's duration spans more than
 * {@link MIN_WAVEFORM_PIXELS} pixels of `pixelWidthUs` each.
 */
export function shouldFetchWaveforms(
  pixelWidthUs: number,
  pointsPerEvent: number,
  periodUs: number,
): boolean {
  return pixelWidthUs * MIN_WAVEFORM_PIXELS < pointsPerEvent * periodUs;
}

/**
 * Returns the index of the first timestamp at or after `timeUs`, by binary
 * search over single-element reads. Returns `reader.count` when every
 * timestamp is earlier.
 */
export async function firstIndexAtOrAfter(
  reader: TimestampReader,
  timeUs: number,
): Promise<number> {
  let low = 0;
  let high = reader.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const probe = await reader.read(middle, middle + 1);
    // middle < high <= reader.count; the single-element read is never empty.
    if (probe[0]! < timeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Reads one unit channel's events over a time window.
 *
 * The window is half-open: an event exactly at `endUs` is excluded. Waveforms
 * are fetched only when the window holds events and
 * {@link shouldFetchWaveforms} returns true for `pixelWidthUs`; otherwise
 * `pointsPerEvent` is 0 and `data` is empty. `samplePeriodUs` is the waveform
 * sample period whether or not waveforms were fetched. `isResampled` is always
 * false.
 */
export async function queryUnitChannel(
  store: Store,
  channelId: string,
  unit: UnitArrays,
  window: { startUs: number; endUs: number; pixelWidthUs: number },
  opts?: StoreOptions,
): Promise<EventBatch> {
  const events = await openTimestamps(store, unit.events.path, opts);
  // The two bounds are independent, and each search costs log2(n) round trips.
  const [start, end] = await Promise.all([
    firstIndexAtOrAfter(events, window.startUs),
    firstIndexAtOrAfter(events, window.endUs),
  ]);
  const times = await events.read(start, end);

  const { pointsPerEvent, periodUs } = unit.waveforms;
  const wanted =
    times.length > 0 &&
    shouldFetchWaveforms(window.pixelWidthUs, pointsPerEvent, periodUs);
  const data = wanted
    ? (await readRows(store, unit.waveforms.path, { start, end }, opts)).data
    : new Float64Array(0);

  return {
    channel: channelId,
    startUs: window.startUs,
    endUs: window.endUs,
    samplePeriodUs: periodUs,
    pointsPerEvent: wanted ? pointsPerEvent : 0,
    isResampled: false,
    times,
    data,
  };
}
