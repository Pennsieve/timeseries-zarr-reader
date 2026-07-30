import { SEND_SPIKE_THRESHOLD } from "./constants.js";
import type { UnitArrays } from "./catalog.js";
import type { Event, Store, StoreOptions } from "./types.js";
import type { TimestampReader } from "./zarr.js";
import { openTimestamps, readRows } from "./zarr.js";

/**
 * Decide whether spike waveforms are worth fetching for a display resolution.
 *
 * A waveform earns its bytes only when it is wide enough on screen to be seen as a shape
 * rather than a tick: when the waveform's duration spans more than `SEND_SPIKE_THRESHOLD`
 * pixels. Zoomed out, events render as marks and the waveform data would be invisible.
 */
export function shouldFetchWaveforms(
  pixelWidthUs: number,
  pointsPerEvent: number,
  periodUs: number,
): boolean {
  return pixelWidthUs * SEND_SPIKE_THRESHOLD < pointsPerEvent * periodUs;
}

/**
 * Index of the first timestamp at or after `timeUs`, by binary search.
 *
 * Reads one element per probe, so a window is located in log2(n) small reads rather than by
 * scanning the array. Returns `reader.count` when every timestamp is earlier. With the window's
 * end it yields the half-open event range: `endUs` exclusive means an event exactly at the end
 * falls outside.
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
    if ((probe[0] as number) < timeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Read one unit channel's events over a time window.
 *
 * Two binary searches locate the window in the events array, one slice reads the timestamps,
 * and waveforms are fetched only when {@link shouldFetchWaveforms} says the zoom level makes
 * them visible. `pointsPerEvent` is 0 whenever waveforms were not fetched, including when the
 * window holds no events at all.
 *
 * `channel` on the result is the channel id; `samplePeriodUs` is the waveform sample period
 * whether or not waveforms were fetched. Waveforms are never resampled, so `isResampled` is
 * always false.
 */
export async function queryUnitChannel(
  store: Store,
  channelId: string,
  unit: UnitArrays,
  window: { startUs: number; endUs: number; pixelWidthUs: number },
  opts?: StoreOptions,
): Promise<Event> {
  const events = await openTimestamps(store, unit.events.path, opts);
  const start = await firstIndexAtOrAfter(events, window.startUs);
  const end = await firstIndexAtOrAfter(events, window.endUs);
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
