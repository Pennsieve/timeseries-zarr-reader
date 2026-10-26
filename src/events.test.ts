import { describe, expect, test } from "vitest";
import type { EventArrays } from "./catalog.js";
import { readCatalog } from "./catalog.js";
import type { FixtureEvent } from "./test-utils.js";
import { bundleFiles, createMemoryStore } from "./test-utils.js";
import type { Store } from "./types.js";
import type { TimestampReader } from "./zarr.js";
import {
  decodeChannelKeys,
  decodeText,
  firstIndexAtOrAfter,
  queryEventChannel,
  shouldFetchWaveforms,
} from "./events.js";

/** A timestamp reader over an in-memory array. */
const readerOf = (times: number[]): TimestampReader => ({
  count: times.length,
  read: (start, end) =>
    Promise.resolve(Float64Array.from(times.slice(start, end))),
});

test("fetches waveforms only when one waveform spans more than 10 pixels", () => {
  // 32 points at 40 us = a 1280 us waveform.
  expect(shouldFetchWaveforms(100, 32, 40)).toBe(true);
  expect(shouldFetchWaveforms(128, 32, 40)).toBe(false);
  expect(shouldFetchWaveforms(1000, 32, 40)).toBe(false);
});

test("finds the first timestamp at or after a time", async () => {
  const reader = readerOf([1000, 5000, 5500, 9000]);
  expect(await firstIndexAtOrAfter(reader, 0)).toBe(0);
  expect(await firstIndexAtOrAfter(reader, 1000)).toBe(0);
  expect(await firstIndexAtOrAfter(reader, 1001)).toBe(1);
  expect(await firstIndexAtOrAfter(reader, 5500)).toBe(2);
  expect(await firstIndexAtOrAfter(reader, 9001)).toBe(4);
});

test("returns 0 for an empty timestamp array", async () => {
  expect(await firstIndexAtOrAfter(readerOf([]), 5000)).toBe(0);
});

test("returns the first index of a run of duplicate timestamps", async () => {
  // Simultaneous events share a timestamp.
  const reader = readerOf([1000, 5000, 5000, 5000, 9000]);
  expect(await firstIndexAtOrAfter(reader, 5000)).toBe(1);
  expect(await firstIndexAtOrAfter(readerOf([5000, 5000, 5000]), 5000)).toBe(0);
});

test("searches past 2^32 timestamps without wrapping the midpoint", async () => {
  // Timestamp i is i. The reads are computed, so nothing this long is allocated.
  const reader: TimestampReader = {
    count: 2 ** 32 + 10,
    read: (start, end) => {
      const out = new Float64Array(end - start);
      for (let i = 0; i < out.length; i++) {
        out[i] = start + i;
      }
      return Promise.resolve(out);
    },
  };
  expect(await firstIndexAtOrAfter(reader, 3_000_000_000)).toBe(3_000_000_000);
});

describe("decodeText", () => {
  const bytes = (text: string, width: number): number[] => {
    const encoded = [...new TextEncoder().encode(text)];
    return encoded.concat(new Array<number>(width - encoded.length).fill(0));
  };

  test("decodes each row up to its first zero byte", () => {
    const rows = Uint8Array.from([
      ...bytes("ab", 4),
      ...bytes("", 4),
      ...bytes("wxyz", 4),
    ]);
    expect(decodeText(rows, 4, 3)).toEqual(["ab", "", "wxyz"]);
  });

  test("decodes multi-byte UTF-8", () => {
    const rows = Uint8Array.from(bytes("µV ok", 8));
    expect(decodeText(rows, 8, 1)).toEqual(["µV ok"]);
  });

  test("replaces invalid UTF-8 rather than throwing", () => {
    const rows = Uint8Array.from([0xff, 0x61, 0, 0]);
    expect(decodeText(rows, 4, 1)).toEqual(["�a"]);
  });

  test("returns no rows for a count of zero", () => {
    expect(decodeText(new Uint8Array(0), 4, 0)).toEqual([]);
  });
});

describe("decodeChannelKeys", () => {
  test("names the keys whose bits are set, least significant bit first", () => {
    // Row 0: keys 0 and 2. Row 1: nothing. Row 2: keys 7 and 8, across a byte boundary.
    const rows = Uint8Array.from([0b101, 0, 0, 0, 0b1000_0000, 0b1]);
    expect(decodeChannelKeys(rows, 2, 3)).toEqual([[0, 2], [], [7, 8]]);
  });

  test("returns no rows for a count of zero", () => {
    expect(decodeChannelKeys(new Uint8Array(0), 1, 0)).toEqual([]);
  });
});

/** Opens a fixture bundle and returns the store plus the catalog's view of channel `id`. */
async function openEvents(
  channels: FixtureEvent[],
  id: string,
): Promise<{
  store: Store;
  arrays: EventArrays;
  idByKey: Map<string, string>;
}> {
  const store = createMemoryStore(bundleFiles(channels));
  const catalog = await readCatalog(store);
  const entry = catalog.byId.get(id);
  if (entry?.kind !== "event") {
    throw new Error(`fixture has no event channel ${id}`);
  }
  return { store, arrays: entry.arrays, idByKey: catalog.idByKey };
}

const SPIKES: FixtureEvent = {
  key: "5",
  tsz: { kind: "event", name: "Unit 1", id: "u", label_names: ["a", "b"] },
  events: [2000, 5000, 5500, 9000],
  labels: [0, 1, 1, 0],
  waveforms: {
    periodUs: 100,
    pointsPerEvent: 3,
    samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    eventSample: 1,
  },
};

describe("queryEventChannel: point events", () => {
  test("reads the events inside a window, end exclusive, with their labels", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 3000,
      endUs: 9000,
      pixelWidthUs: 1000,
    });

    expect(window.channel).toBe("u");
    expect(window.startUs).toBe(3000);
    expect(window.endUs).toBe(9000);
    expect(Array.from(window.times)).toEqual([5000, 5500]);
    expect(Array.from(window.labels!)).toEqual([1, 1]);
    expect(window.durations).toBeUndefined();
    expect(window.text).toBeUndefined();
    // A 300 us snippet across 1000 us pixels is under the gate.
    expect(window.waveforms).toBeUndefined();
  });

  test("includes an event exactly at the window start", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 5000,
      endUs: 9000,
    });
    expect(Array.from(window.times)).toEqual([5000, 5500]);
  });

  test("fetches the matching waveform rows when the snippet spans more than 10 pixels", async () => {
    // One snippet is 3 x 100 us = 300 us. A 20 us pixel puts it across 15 pixels.
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 3000,
      endUs: 9000,
      pixelWidthUs: 20,
    });

    expect(window.waveforms).toEqual({
      pointsPerEvent: 3,
      periodUs: 100,
      eventSample: 1,
      data: Float64Array.from([4, 5, 6, 7, 8, 9]),
    });
  });

  test("fetches waveforms with no pixel gate when pixelWidthUs is omitted", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 0,
      endUs: 10_000,
    });
    expect(window.waveforms?.data.length).toBe(12);
  });

  test("reads only the requested columns", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 0,
      endUs: 10_000,
      columns: [],
    });
    expect(window.times.length).toBe(4);
    expect(window.labels).toBeUndefined();
    expect(window.waveforms).toBeUndefined();
  });

  test("searches for both window bounds concurrently", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const eventsChunk = "/5/events/c/0";
    let inFlight = 0;
    let peakInFlight = 0;
    const tracked: Store = {
      ...store,
      get: async (key, opts) => {
        if (key !== eventsChunk) {
          return store.get(key, opts);
        }
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          return await store.get(key, opts);
        } finally {
          inFlight--;
        }
      },
    };

    const window = await queryEventChannel(tracked, "u", arrays, idByKey, {
      startUs: 3000,
      endUs: 9000,
    });

    // Two timestamp reads in flight at once can only come from overlapping searches.
    expect(peakInFlight).toBe(2);
    expect(Array.from(window.times)).toEqual([5000, 5500]);
  });

  test("returns no events and no columns for an empty window", async () => {
    const { store, arrays, idByKey } = await openEvents([SPIKES], "u");
    const window = await queryEventChannel(store, "u", arrays, idByKey, {
      startUs: 20_000,
      endUs: 21_000,
      pixelWidthUs: 20,
    });

    expect(window.times.length).toBe(0);
    expect(window.labels!.length).toBe(0);
    expect(window.waveforms).toBeUndefined();
  });
});

const MARKS: FixtureEvent = {
  key: "3",
  tsz: {
    kind: "event",
    name: "marks",
    id: "m",
    unit: "score",
    label_names: ["seizure", "spike", "note"],
    max_duration_us: 60_000,
  },
  // A 60 ms seizure from 100 ms, a point spike at 150 ms, a 10 ms note at 190 ms, and
  // a point spike at 400 ms.
  events: [100_000, 150_000, 190_000, 400_000],
  durations: [60_000, 0, 10_000, 0],
  labels: [0, 1, 2, 1],
  values: [0.5, 0.25, 0.75, 1],
  text: ["sz onset", "", "note: µV", '{"k":1}'],
  channels: [[0], [], [0, 1], [7]],
};

const CONTINUOUS = {
  key: "0",
  tsz: { kind: "continuous", name: "A", id: "a", unit: "uV", rate_hz: 1000 },
  raw: [0, 0, 0, 0],
};

describe("queryEventChannel: intervals and text", () => {
  test("includes an interval that starts before the window and is still open", async () => {
    const { store, arrays, idByKey } = await openEvents([MARKS], "m");
    const window = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 155_000,
      endUs: 200_000,
    });

    // The seizure (100..160 ms) overlaps; the spike at 150 ms does not; the note at
    // 190 ms does.
    expect(Array.from(window.times)).toEqual([100_000, 190_000]);
    expect(Array.from(window.durations!)).toEqual([60_000, 10_000]);
    expect(Array.from(window.labels!)).toEqual([0, 2]);
    expect(Array.from(window.values!)).toEqual([0.5, 0.75]);
    expect(window.text).toEqual(["sz onset", "note: µV"]);
  });

  test("keeps an interval that ends exactly at the window start and drops one that ended before", async () => {
    const { store, arrays, idByKey } = await openEvents([MARKS], "m");
    const atEnd = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 160_000,
      endUs: 170_000,
    });
    expect(Array.from(atEnd.times)).toEqual([100_000]);

    const pastEnd = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 160_001,
      endUs: 170_000,
    });
    expect(pastEnd.times.length).toBe(0);
    expect(pastEnd.text).toEqual([]);
  });

  test("searches from the first event when durations have no bound", async () => {
    const tsz = { ...MARKS.tsz };
    delete tsz.max_duration_us;
    const { store, arrays, idByKey } = await openEvents(
      [{ ...MARKS, tsz }],
      "m",
    );
    expect(arrays.durations?.maxDurationUs).toBeUndefined();

    const window = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 155_000,
      endUs: 200_000,
    });
    expect(Array.from(window.times)).toEqual([100_000, 190_000]);
  });

  test("resolves the channels column to channel ids, keeping an unknown key as is", async () => {
    const store = createMemoryStore(bundleFiles([CONTINUOUS, MARKS]));
    const catalog = await readCatalog(store);
    const entry = catalog.byId.get("m")!;
    if (entry.kind !== "event") throw new Error("unreachable");

    const window = await queryEventChannel(
      store,
      "m",
      entry.arrays,
      catalog.idByKey,
      {
        startUs: 0,
        endUs: 500_000,
      },
    );
    // Key 0 is channel "a". Keys 1 and 7 name no channel in this bundle.
    expect(window.channels).toEqual([["a"], [], ["a", "1"], ["7"]]);
  });

  test("decodes JSON text as the string it is", async () => {
    const { store, arrays, idByKey } = await openEvents([MARKS], "m");
    const window = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 400_000,
      endUs: 400_001,
      columns: ["text"],
    });
    expect(window.text).toEqual(['{"k":1}']);
    expect(window.labels).toBeUndefined();
  });

  test("applies the interval filter to waveform rows too", async () => {
    const withSnippets: FixtureEvent = {
      ...MARKS,
      waveforms: {
        periodUs: 1000,
        pointsPerEvent: 2,
        samples: [1, 1, 2, 2, 3, 3, 4, 4],
      },
    };
    const { store, arrays, idByKey } = await openEvents([withSnippets], "m");
    const window = await queryEventChannel(store, "m", arrays, idByKey, {
      startUs: 155_000,
      endUs: 200_000,
    });
    expect(Array.from(window.waveforms!.data)).toEqual([1, 1, 3, 3]);
  });
});
