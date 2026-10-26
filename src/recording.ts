import type { Mutable, RecordingInfo, Store, StoreOptions } from "./types.js";

/**
 * An RFC 3339 timestamp in four parts: date, time, optional fraction, UTC offset.
 * "2024-03-14T09:15:00.000250-05:00" captures "2024-03-14", "09:15:00", "000250",
 * "-05:00". The separator may be T, t, or a space, which RFC 3339 allows. The offset
 * is required: the format requires one, and without it `Date` would read the time in
 * the machine's local zone. The fraction is captured on its own because `Date` keeps
 * milliseconds and the bundle's times are microseconds.
 */
const RFC3339 =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Parses an RFC 3339 timestamp to microseconds since the Unix epoch.
 *
 * Keeps the fractional second to the microsecond, which `Date` would round to a
 * millisecond. Throws a RangeError for anything that is not a complete RFC 3339
 * timestamp with a UTC offset.
 */
export function parseRfc3339Us(text: string): number {
  const match = RFC3339.exec(text);
  if (match === null) {
    throw new RangeError(
      `${JSON.stringify(text)} is not an RFC 3339 timestamp with a UTC offset`,
    );
  }
  const fraction = match[3] ?? "";
  const ms = Date.parse(`${match[1]}T${match[2]}${match[4]!.toUpperCase()}`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${JSON.stringify(text)} is not a valid timestamp`);
  }
  // The fraction may run past six digits; the microsecond is the first six.
  const micros = Number(fraction.padEnd(6, "0").slice(0, 6));
  return ms * 1000 + micros;
}

/** Narrows parsed JSON to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the bundle's `recording.json`, or resolves undefined when it has none.
 *
 * The origin's wall-clock time is the `start` key. `reference_time`, the name
 * timeseries-zarr-py writes for the same instant, is accepted too. Throws when the
 * file is not a JSON object, a field has the wrong type, or the timestamp does not
 * parse.
 */
export async function readRecording(
  store: Store,
  opts?: StoreOptions,
): Promise<RecordingInfo | undefined> {
  const bytes = await store.get("/recording.json", opts);
  if (bytes === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new Error("/recording.json is not valid JSON", { cause });
  }
  const doc = asRecord(parsed);
  if (doc === undefined) {
    throw new Error("/recording.json must hold an object");
  }

  const info: Mutable<RecordingInfo> = {};
  const start = doc.start ?? doc.reference_time;
  if (start !== undefined) {
    if (typeof start !== "string") {
      throw new TypeError(
        `/recording.json start must be a string (got ${JSON.stringify(start)})`,
      );
    }
    info.start = start;
    info.startUs = parseRfc3339Us(start);
  }
  for (const key of ["subject", "session", "source"] as const) {
    if (doc[key] === undefined) {
      continue;
    }
    const value = asRecord(doc[key]);
    if (value === undefined) {
      throw new TypeError(
        `/recording.json ${key} must be an object (got ${JSON.stringify(doc[key])})`,
      );
    }
    info[key] = value;
  }
  return info;
}
