import type { Segment, Store } from "./types";

/**
 * A `Store` backed by an object literal, for tests that need bundle bytes without a
 * filesystem or a network.
 *
 * String values are encoded as UTF-8, bundle metadata being JSON. Reads return a copy, so a
 * test that mutates what it read cannot corrupt the fixture. The stored arrays themselves are
 * held as given, not copied on the way in.
 *
 * An absent key resolves to `undefined` rather than throwing, matching the `Store` contract,
 * and an empty file stays distinct from an absent one.
 */
export function createMemoryStore(
  files: Record<`/${string}`, string | Uint8Array>,
): Store {
  const encoder = new TextEncoder();
  const bytes = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(files)) {
    bytes.set(key, typeof value === "string" ? encoder.encode(value) : value);
  }

  return {
    get: (key) => Promise.resolve(bytes.get(key)?.slice()),
  };
}

/**
 * A `Segment` for tests, defaulting to an empty raw segment on channel "c" starting at 0 with
 * a 1000 us period.
 */
export function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    channel: "c",
    startUs: 0,
    samplePeriodUs: 1000,
    isMinMax: false,
    data: new Float64Array(0),
    ...overrides,
  };
}
