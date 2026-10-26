import { MIN_WAVEFORM_PIXELS } from "./constants.js";
import type { EventArrays } from "./catalog.js";
import type {
  EventColumn,
  EventWindow,
  Mutable,
  Store,
  StoreOptions,
} from "./types.js";
import type { TimestampReader } from "./zarr.js";
import { openTimestamps, readColumn, readRows } from "./zarr.js";

/**
 * Reports whether spike waveforms should be fetched at a display resolution.
 *
 * Returns true when one waveform spans more than {@link MIN_WAVEFORM_PIXELS}
 * pixels, each `pixelWidthUs` wide.
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
    // Not `(low + high) >>> 1`, which wraps past 2^32 elements.
    const middle = low + Math.floor((high - low) / 2);
    const probe = await reader.read(middle, middle + 1);
    // middle < high <= reader.count, so the single-element read is never empty.
    if (probe[0]! < timeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Decodes `count` rows of zero-padded UTF-8, `width` bytes each, to one string per
 * row.
 *
 * A row is read up to its first zero byte, so a row of zeros is an empty string.
 * Bytes that are not valid UTF-8 decode to U+FFFD rather than failing the read: one
 * bad annotation should not take the channel down with it.
 */
export function decodeText(
  rows: Uint8Array,
  width: number,
  count: number,
): string[] {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let row = 0; row < count; row++) {
    const start = row * width;
    let end = start;
    while (end < start + width && rows[end] !== 0) {
      end++;
    }
    out.push(decoder.decode(rows.subarray(start, end)));
  }
  return out;
}

/**
 * Decodes `count` bitmask rows, `width` bytes each, to the channel keys each row
 * names, ascending.
 *
 * Bit `k mod 8` of byte `floor(k / 8)`, least significant bit first, names channel
 * key `k`. A row of zeros gives an empty list: the event applies to the whole
 * recording.
 */
export function decodeChannelKeys(
  rows: Uint8Array,
  width: number,
  count: number,
): number[][] {
  const out: number[][] = [];
  for (let row = 0; row < count; row++) {
    const keys: number[] = [];
    for (let byte = 0; byte < width; byte++) {
      const bits = rows[row * width + byte]!;
      for (let bit = 0; bit < 8; bit++) {
        if ((bits >> bit) & 1) {
          keys.push(byte * 8 + bit);
        }
      }
    }
    out.push(keys);
  }
  return out;
}

/** The window and column selection of one event read. */
export interface EventQuery {
  readonly startUs: number;
  readonly endUs: number;
  /**
   * Time one pixel column covers. Gates the waveform read: snippets are skipped when
   * one spans {@link MIN_WAVEFORM_PIXELS} pixels or fewer. Absent means no gate.
   */
  readonly pixelWidthUs?: number;
  /** The per-event columns to read. Defaults to every column the channel stores. */
  readonly columns?: readonly EventColumn[];
}

/** Keeps the entries of `data` at the `kept` indices. Returns `data` itself when `kept` is undefined. */
function keepEntries<T extends Float64Array | Uint16Array>(
  data: T,
  kept: readonly number[] | undefined,
): T {
  if (kept === undefined) {
    return data;
  }
  const out = new (data.constructor as new (length: number) => T)(kept.length);
  kept.forEach((index, i) => {
    out[i] = data[index]!;
  });
  return out;
}

/** Keeps the items of `items` at the `kept` indices. */
function keepItems<T>(items: T[], kept: readonly number[] | undefined): T[] {
  return kept === undefined ? items : kept.map((index) => items[index]!);
}

/** Keeps the rows of a flattened row-major array at the `kept` indices. */
function keepRows(
  data: Float64Array,
  rowLength: number,
  kept: readonly number[] | undefined,
): Float64Array {
  if (kept === undefined) {
    return data;
  }
  const out = new Float64Array(kept.length * rowLength);
  kept.forEach((index, i) => {
    out.set(
      data.subarray(index * rowLength, (index + 1) * rowLength),
      i * rowLength,
    );
  });
  return out;
}

/**
 * Reads one event channel's events over a time window.
 *
 * An event is in the window when it starts before `endUs` and ends at or after
 * `startUs`, so an interval that opened before the window and is still running
 * counts. A point event ends when it starts. Finding the open intervals means
 * searching back from `startUs` by the channel's duration bound, or from the first
 * event when the channel has durations but declares no bound.
 *
 * Every column read covers the same events, so index `i` of each is event `i`. The
 * `channels` column is resolved from channel keys to ids through `idByKey`; a key
 * with no channel in the bundle is returned as the key itself. Waveforms are read
 * only when the window holds events and the pixel gate admits them.
 */
export async function queryEventChannel(
  store: Store,
  channelId: string,
  arrays: EventArrays,
  idByKey: ReadonlyMap<string, string>,
  query: EventQuery,
  opts?: StoreOptions,
): Promise<EventWindow> {
  const events = await openTimestamps(store, arrays.events.path, opts);
  const wanted = new Set<EventColumn>(query.columns ?? storedColumns(arrays));

  // 1. Find the index span. A channel with durations searches back by its bound.
  const lookbackUs =
    arrays.durations === undefined
      ? 0
      : (arrays.durations.maxDurationUs ?? Infinity);
  const [searchStart, end] = await Promise.all([
    lookbackUs === Infinity
      ? 0
      : firstIndexAtOrAfter(events, query.startUs - lookbackUs),
    firstIndexAtOrAfter(events, query.endUs),
  ]);
  const start = Math.min(searchStart, end);
  const span = { start, end };
  const spanLength = end - start;

  // 2. Read times and durations, and drop the look-back events that ended before the
  //    window. `kept` stays undefined when nothing was dropped.
  const [times, durations] = await Promise.all([
    events.read(start, end),
    arrays.durations === undefined
      ? undefined
      : openTimestamps(store, arrays.durations.path, opts).then((reader) =>
          reader.read(start, end),
        ),
  ]);
  let kept: number[] | undefined;
  if (durations !== undefined) {
    kept = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i]! + durations[i]! >= query.startUs) {
        kept.push(i);
      }
    }
    if (kept.length === times.length) {
      kept = undefined;
    }
  }

  // 3. Read the other columns over the same span, together.
  const want = (column: EventColumn): boolean => wanted.has(column);
  const snippets = arrays.waveforms;
  const fetchWaveforms =
    snippets !== undefined &&
    want("waveforms") &&
    (kept?.length ?? times.length) > 0 &&
    (query.pixelWidthUs === undefined ||
      shouldFetchWaveforms(
        query.pixelWidthUs,
        snippets.pointsPerEvent,
        snippets.periodUs,
      ));
  const [labels, values, textRows, channelRows, waveformRows] =
    await Promise.all([
      arrays.labels !== undefined && want("labels")
        ? readColumn(store, arrays.labels.path, span, ["uint16"], opts)
        : undefined,
      arrays.values !== undefined && want("values")
        ? readColumn(
            store,
            arrays.values.path,
            span,
            ["float32", "float64"],
            opts,
          )
        : undefined,
      arrays.text !== undefined && want("text")
        ? readRows(store, arrays.text.path, span, ["uint8"], opts)
        : undefined,
      arrays.channels !== undefined && want("channels")
        ? readRows(store, arrays.channels.path, span, ["uint8"], opts)
        : undefined,
      fetchWaveforms
        ? readRows(store, snippets.path, span, ["float32", "float64"], opts)
        : undefined,
    ]);

  // 4. Assemble the window, keeping only the events that overlap it.
  const window: Mutable<EventWindow> = {
    channel: channelId,
    startUs: query.startUs,
    endUs: query.endUs,
    times: keepEntries(times, kept),
  };
  if (durations !== undefined && want("durations")) {
    window.durations = keepEntries(durations, kept);
  }
  if (labels !== undefined) {
    window.labels = keepEntries(Uint16Array.from(labels), kept);
  }
  if (values !== undefined) {
    window.values = keepEntries(Float64Array.from(values), kept);
  }
  if (textRows !== undefined && arrays.text !== undefined) {
    window.text = keepItems(
      decodeText(textRows.data, arrays.text.width, spanLength),
      kept,
    );
  }
  if (channelRows !== undefined && arrays.channels !== undefined) {
    const keyRows = decodeChannelKeys(
      channelRows.data,
      arrays.channels.width,
      spanLength,
    );
    window.channels = keepItems(
      keyRows.map((keys) =>
        keys.map((key) => idByKey.get(String(key)) ?? String(key)),
      ),
      kept,
    );
  }
  if (waveformRows !== undefined && snippets !== undefined) {
    window.waveforms = {
      pointsPerEvent: snippets.pointsPerEvent,
      periodUs: snippets.periodUs,
      eventSample: snippets.eventSample,
      data: keepRows(
        Float64Array.from(waveformRows.data),
        snippets.pointsPerEvent,
        kept,
      ),
    };
  }
  return window;
}

/** The per-event columns a channel stores, in the format's order. */
function storedColumns(arrays: EventArrays): EventColumn[] {
  const columns: EventColumn[] = [];
  if (arrays.durations) columns.push("durations");
  if (arrays.labels) columns.push("labels");
  if (arrays.values) columns.push("values");
  if (arrays.text) columns.push("text");
  if (arrays.channels) columns.push("channels");
  if (arrays.waveforms) columns.push("waveforms");
  return columns;
}
