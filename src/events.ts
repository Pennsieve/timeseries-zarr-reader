import type { EventChannelEntry } from "./catalog.js";
import type { EventRecord, EventWindow, Store, StoreOptions } from "./types.js";
import { firstIndexAtOrAfter } from "./unit.js";
import { openTimestamps, readBytes, readIntegers } from "./zarr.js";

/** What a query reads beyond the window itself. */
export interface EventReadOptions {
  /** Read each event's body. A viewer drawing marks needs none of them. */
  readonly bodies: boolean;
  /** At most this many events starting inside the window. */
  readonly limit?: number;
}

/**
 * Reads one event channel's events that overlap a time window.
 *
 * The window is half-open. A point event overlaps when `startUs <= time < endUs`, an
 * interval `[time, time + duration)` when it intersects the window at all. The search
 * starts `maxDurationUs` before the window, so an interval that began earlier and is
 * still running is found.
 *
 * A limit stops the read early. The returned window's `endUs` then moves back to the
 * start of the first event left out, so the events returned are every event in the
 * window they name, and the next read can start there.
 *
 * Every per-event array is optional except `events`: a channel without `durations` has
 * only points, without `labels` has no labels, and so on. `idByIndex` turns the numbered
 * channel groups in `channel_refs` into channel ids.
 */
export async function queryEventChannel(
  store: Store,
  entry: EventChannelEntry,
  idByIndex: ReadonlyMap<number, string>,
  window: { startUs: number; endUs: number },
  read: EventReadOptions,
  opts?: StoreOptions,
): Promise<EventWindow> {
  const { id, labelNames, maxDurationUs } = entry.info;

  // 1. Find the candidates by binary search over the sorted start times.
  const times = await openTimestamps(store, `${entry.path}/events`, opts);
  const [start, inWindow, windowEnd] = await Promise.all([
    firstIndexAtOrAfter(times, window.startUs - maxDurationUs),
    maxDurationUs > 0
      ? firstIndexAtOrAfter(times, window.startUs)
      : Promise.resolve(-1),
    firstIndexAtOrAfter(times, window.endUs),
  ]);

  // 2. Apply the limit to events starting inside the window, not to the earlier ones
  // the search widened back to. The window ends where the first event left out starts.
  let end = windowEnd;
  let endUs = window.endUs;
  const firstInWindow = inWindow < 0 ? start : inWindow;
  if (read.limit !== undefined && end - firstInWindow > read.limit) {
    end = firstInWindow + read.limit;
    endUs = (await times.read(end, end + 1))[0]!;
  }
  const empty = { channel: id, startUs: window.startUs, endUs, events: [] };
  if (end <= start) {
    return empty;
  }
  const range = { start, end };

  // 3. Read every per-event column the channel has over the candidate range.
  const has = (name: string) => entry.arrays.has(name);
  const [starts, durations, labels, bodies, refs] = await Promise.all([
    times.read(start, end),
    has("durations")
      ? readIntegers(store, `${entry.path}/durations`, range, opts)
      : undefined,
    has("labels")
      ? readIntegers(store, `${entry.path}/labels`, range, opts)
      : undefined,
    read.bodies && has("bodies") && has("body_offsets")
      ? readBodies(store, entry.path, range, opts)
      : undefined,
    has("channel_refs") && has("channel_ref_offsets")
      ? readChannelRefs(store, entry.path, range, idByIndex, opts)
      : undefined,
  ]);

  // 4. Keep the candidates that overlap the window. The search widened it backwards,
  // and a limit can land among events sharing a start time: those belong to the next read.
  const events: EventRecord[] = [];
  for (let i = 0; i < starts.length; i++) {
    const timeUs = starts[i]!;
    const durationUs = durations?.[i] ?? 0;
    const overlaps =
      durationUs > 0
        ? timeUs + durationUs > window.startUs
        : timeUs >= window.startUs;
    if (!overlaps || timeUs >= endUs) {
      continue;
    }
    const label = labels?.[i];
    events.push({
      index: start + i,
      timeUs,
      durationUs,
      label:
        label === undefined ? undefined : (labelNames[label] ?? String(label)),
      body: bodies?.[i],
      channels: refs?.[i] ?? [],
    });
  }

  return { ...empty, events };
}

/**
 * Reads one event's body, or undefined when the channel stores none.
 *
 * For a caller that drew marks without bodies and now needs the text of one.
 */
export async function readEventBody(
  store: Store,
  entry: EventChannelEntry,
  index: number,
  opts?: StoreOptions,
): Promise<string | undefined> {
  if (!entry.arrays.has("bodies") || !entry.arrays.has("body_offsets")) {
    return undefined;
  }
  const [body] = await readBodies(
    store,
    entry.path,
    { start: index, end: index + 1 },
    opts,
  );
  return body;
}

/**
 * Reads the bodies of a run of events and splits them at their offsets.
 *
 * `body_offsets` holds n + 1 byte offsets into `bodies`, so a run of events needs one
 * more offset than it has events. Each body ends in a newline, which is removed.
 */
async function readBodies(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  opts?: StoreOptions,
): Promise<string[]> {
  const offsets = await readIntegers(
    store,
    `${path}/body_offsets`,
    { start: range.start, end: range.end + 1 },
    opts,
  );
  const first = offsets[0]!;
  const bytes = await readBytes(
    store,
    `${path}/bodies`,
    { start: first, end: offsets[offsets.length - 1]! },
    opts,
  );

  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    const text = decoder.decode(
      bytes.subarray(offsets[i]! - first, offsets[i + 1]! - first),
    );
    out.push(text.endsWith("\n") ? text.slice(0, -1) : text);
  }
  return out;
}

/**
 * Reads which channels each event in a run applies to, as channel ids.
 *
 * Laid out like bodies: `channel_ref_offsets` holds n + 1 offsets into `channel_refs`,
 * whose values are numbered channel groups. An empty span means the whole recording. A
 * number with no channel group is kept as its own string rather than dropped.
 */
async function readChannelRefs(
  store: Store,
  path: `/${string}`,
  range: { start: number; end: number },
  idByIndex: ReadonlyMap<number, string>,
  opts?: StoreOptions,
): Promise<string[][]> {
  const offsets = await readIntegers(
    store,
    `${path}/channel_ref_offsets`,
    { start: range.start, end: range.end + 1 },
    opts,
  );
  const first = offsets[0]!;
  const refs = await readIntegers(
    store,
    `${path}/channel_refs`,
    { start: first, end: offsets[offsets.length - 1]! },
    opts,
  );

  const out: string[][] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    out.push(
      refs
        .slice(offsets[i]! - first, offsets[i + 1]! - first)
        .map((ref) => idByIndex.get(ref) ?? String(ref)),
    );
  }
  return out;
}
