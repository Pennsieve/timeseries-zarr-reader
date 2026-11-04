import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createFilter } from "./filter.js";
import type { FixtureChannel } from "./test-utils.js";
import {
  bundleFiles,
  collect,
  createCountingStore,
  createMemoryStore,
} from "./test-utils.js";
import type {
  ChannelInfo,
  ContinuousChannelInfo,
  EventChannelInfo,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";
import { openBundle, RawReadTooLargeError, StreamingClient } from "./index.js";

/** Collects an async iterable and asserts it yielded exactly one item. */
async function collectOne<T>(iterable: AsyncIterable<T>): Promise<T> {
  const items = await collect(iterable);
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** Interleaved [min, max] per disjoint block, matching the pyramid level encoding. */
function pairsOf(samples: number[], block: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += block) {
    const values = samples.slice(i, i + block);
    out.push(Math.min(...values), Math.max(...values));
  }
  return out;
}

function continuousById(
  infos: readonly ChannelInfo[],
  id: string,
): ContinuousChannelInfo {
  const info = infos.find((candidate) => candidate.id === id);
  if (info?.kind !== "continuous") {
    throw new Error(`bundle has no continuous channel ${id}`);
  }
  return info;
}

function eventById(
  infos: readonly ChannelInfo[],
  id: string,
): EventChannelInfo {
  const info = infos.find((candidate) => candidate.id === id);
  if (info?.kind !== "event") {
    throw new Error(`bundle has no event channel ${id}`);
  }
  return info;
}

/** Wraps a store so every read of `key` rejects, standing in for a transport failure. */
function withFailingKey(store: Store, key: `/${string}`): Store {
  const fail = () => Promise.reject(new Error(`read of ${key} failed`));
  return {
    get: (path, opts) => (path === key ? fail() : store.get(path, opts)),
    getRange: (path, range, opts) =>
      path === key ? fail() : store.getRange(path, range, opts),
  };
}

/**
 * Wraps a store so reads of the `held` keys never settle, recording the signal each
 * arrived with, so a test can see which reads the client cancelled.
 */
function withHeldKeys(
  store: Store,
  held: ReadonlySet<string>,
): { store: Store; signals: Map<string, AbortSignal | undefined> } {
  const signals = new Map<string, AbortSignal | undefined>();
  const hold = (key: string, opts?: StoreOptions): Promise<never> => {
    signals.set(key, opts?.signal);
    return new Promise<never>(() => {});
  };
  return {
    signals,
    store: {
      get: (key, opts) =>
        held.has(key) ? hold(key, opts) : store.get(key, opts),
      getRange: (key, range, opts) =>
        held.has(key) ? hold(key, opts) : store.getRange(key, range, opts),
    },
  };
}

/**
 * The `tsz` object of a continuous channel. Starts at 1 s unless `offsetUs` says
 * otherwise.
 */
const tsz = (
  id: string,
  name: string,
  rateHz: number,
  offsetUs = 1_000_000,
) => ({
  kind: "continuous",
  id,
  name,
  unit: "uV",
  rate_hz: rateHz,
  offset_us: offsetUs,
});

const RAW_A = Array.from({ length: 32 }, (_, i) => i);
const RAW_B = RAW_A.map((value) => value + 100);
/**
 * A sine at 512 Hz, for the channel whose sample period is not a whole microsecond.
 * Pre-rounded to float32 to match bundle storage and read output.
 */
const FRACTIONAL = Array.from(
  Float32Array.from(
    Array.from({ length: 256 }, (_, i) =>
      Math.sin((2 * Math.PI * 20 * i) / 512),
    ),
  ),
);

const CHANNELS: FixtureChannel[] = [
  {
    index: 0,
    tsz: tsz("a", "A", 1000),
    raw: RAW_A,
    levels: [{ periodUs: 4000, pairs: pairsOf(RAW_A, 4) }],
  },
  {
    index: 1,
    tsz: tsz("b", "B", 1000),
    raw: RAW_B,
    levels: [{ periodUs: 4000, pairs: pairsOf(RAW_B, 4) }],
  },
  {
    index: 2,
    tsz: tsz("c", "C", 500),
    raw: new Array<number>(16).fill(0),
  },
  {
    index: 3,
    tsz: tsz("r", "R", 1000),
    raw: [0, 10, 2, 8, 5, 5, 5, 5],
  },
  {
    index: 4,
    tsz: tsz("g", "G", 1000),
    raw: new Array<number>(32).fill(0),
    levels: [
      {
        periodUs: 4000,
        pairs: [1, 2, NaN, NaN, 3, 4, 5, 6, NaN, NaN, NaN, NaN, 7, 8, 9, 10],
      },
    ],
  },
  {
    index: 5,
    tsz: { kind: "event", id: "u", name: "U", label_names: ["x", "y"] },
    events: [1_002_000, 1_005_000, 1_005_500, 1_009_000],
    labels: [0, 1, 1, 0],
    waveforms: {
      periodUs: 100,
      pointsPerEvent: 3,
      samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
    waveformMean: {
      periodUs: 100,
      pointsPerEvent: 3,
      samples: [1, 2, 3, 4, 5, 6],
    },
    // 4 ms bins from 1 s: events land in bins 0, 1, 1, 2.
    countLevels: [
      {
        periodUs: 4000,
        offsetUs: 1_000_000,
        labelCount: 2,
        counts: [1, 0, 0, 2, 1, 0],
      },
      { periodUs: 16_000, offsetUs: 1_000_000, labelCount: 2, counts: [2, 2] },
    ],
  },
  {
    // Same rate and grid as "a", but starting two samples later.
    index: 6,
    tsz: tsz("d", "D", 1000, 1_002_000),
    raw: Array.from({ length: 30 }, (_, i) => i + 200),
  },
  {
    // Same rate as "a", offset half a period: no shared grid exists.
    index: 7,
    tsz: tsz("m", "M", 1000, 1_000_500),
    raw: [0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    // 512 Hz from a large offset: period_us is 1953.125, and startUs arithmetic
    // rounds. No drift lands on an exact period.
    index: 8,
    tsz: tsz("f", "F", 512, 1_704_067_200_000_000),
    raw: FRACTIONAL,
  },
  {
    // The coarsest level has a count member: one bin is NaN but partly recorded,
    // one is NaN and empty.
    index: 9,
    tsz: tsz("h", "H", 1000),
    raw: new Array<number>(32).fill(0),
    levels: [
      {
        periodUs: 4000,
        pairs: [1, 2, NaN, NaN, NaN, NaN, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        count: [4, 3, 0, 4, 4, 4, 4, 4],
      },
    ],
  },
  {
    // Marks: one 10 ms interval and two points, with text and channel scope.
    index: 10,
    tsz: {
      kind: "event",
      id: "k",
      name: "K",
      max_duration_us: 10_000,
      label_names: ["long", "short"],
    },
    events: [1_000_000, 1_004_000, 1_020_000],
    durations: [10_000, 0, 0],
    labels: [0, 1, 1],
    text: ["first", "", "last"],
    channels: [[0], [], [0, 1]],
  },
];

const RECORDING = {
  reference_time: "2024-01-01T00:00:00Z",
  subject: { id: "sub-01" },
};

const makeClient = (maxRawBytes?: number) =>
  new StreamingClient({
    store: createMemoryStore(bundleFiles(CHANNELS, { recording: RECORDING })),
    ...(maxRawBytes === undefined ? {} : { maxRawBytes }),
  });

const FULL = { startUs: 1_000_000, endUs: 1_032_000 };
const LOWPASS = { type: "lowpass", order: 4, cutoffHz: 100 } as const;
const LOWPASS_512 = { type: "lowpass", order: 4, cutoffHz: 50 } as const;

describe("catalog", () => {
  test("reads nothing from the store on construction", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );

    new StreamingClient({ store: counting.store });
    await Promise.resolve();

    expect(counting.total()).toBe(0);
  });

  test("channelInfo lists every channel from a single root read", async () => {
    let rootReads = 0;
    const inner = createMemoryStore(bundleFiles(CHANNELS));
    const store: Store = {
      get: (key, opts) => {
        if (key === "/zarr.json") {
          rootReads += 1;
        }
        return inner.get(key, opts);
      },
      getRange: (key, range, opts) => inner.getRange(key, range, opts),
    };
    const client = new StreamingClient({ store });

    const infos = await client.channelInfo();
    await client.channelInfo();

    expect(infos.map((info) => info.id)).toEqual([
      "a",
      "b",
      "c",
      "r",
      "g",
      "u",
      "d",
      "m",
      "f",
      "h",
      "k",
    ]);
    expect(rootReads).toBe(1);
  });

  test("channelInfo describes continuous and event channels by kind", async () => {
    const client = makeClient();
    const infos = await client.channelInfo();

    expect(continuousById(infos, "a")).toEqual({
      kind: "continuous",
      index: 0,
      id: "a",
      name: "A",
      unit: "uV",
      rateHz: 1000,
      startUs: 1_000_000,
      endUs: 1_032_000,
      runs: 1,
    });
    expect(eventById(infos, "u")).toEqual({
      kind: "event",
      index: 5,
      id: "u",
      name: "U",
      eventCount: 4,
      columns: ["labels", "waveforms"],
      labelNames: ["x", "y"],
      hasWaveformMean: true,
      countLevels: 2,
    });
  });

  test("retries the read after a transient failure", async () => {
    const inner = createMemoryStore(bundleFiles(CHANNELS));
    let failures = 1;
    const store: Store = {
      get: (key, opts) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("transient outage"));
        }
        return inner.get(key, opts);
      },
      getRange: (key, range, opts) => inner.getRange(key, range, opts),
    };
    const client = new StreamingClient({ store });

    await expect(client.channelInfo()).rejects.toThrow(/transient outage/);
    expect((await client.channelInfo()).length).toBe(11);
  });

  test("channelInfo returns a fresh copy per call", async () => {
    const client = makeClient();
    const first = continuousById(await client.channelInfo(), "a");
    const second = continuousById(await client.channelInfo(), "a");
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe("recording", () => {
  test("reads recording.json once and caches it", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS, { recording: RECORDING })),
    );
    const client = new StreamingClient({ store: counting.store });

    const recording = await client.recording();
    await client.recording();

    expect(recording).toEqual({
      referenceTime: "2024-01-01T00:00:00Z",
      referenceTimeUs: 1_704_067_200_000_000,
      subject: { id: "sub-01" },
    });
    expect(counting.reads.get("/recording.json")).toBe(1);
  });

  test("resolves undefined for a bundle with no recording.json", async () => {
    const client = new StreamingClient({
      store: createMemoryStore(bundleFiles(CHANNELS)),
    });
    await expect(client.recording()).resolves.toBeUndefined();
  });

  test("retries after a failed read", async () => {
    const inner = createMemoryStore(
      bundleFiles(CHANNELS, { recording: RECORDING }),
    );
    let failures = 1;
    const store: Store = {
      get: (key, opts) => {
        if (key === "/recording.json" && failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("transient outage"));
        }
        return inner.get(key, opts);
      },
      getRange: (key, range, opts) => inner.getRange(key, range, opts),
    };
    const client = new StreamingClient({ store });

    await expect(client.recording()).rejects.toThrow(/transient outage/);
    expect((await client.recording())?.referenceTimeUs).toBe(
      1_704_067_200_000_000,
    );
  });
});

describe("query", () => {
  test("reads raw samples exactly as stored at raw zoom", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
    );

    expect(segment.channel).toBe("a");
    expect(segment.startUs).toBe(1_000_000);
    expect(segment.samplePeriodUs).toBe(1000);
    expect(segment.isMinMax).toBe(false);
    expect(Array.from(segment.data)).toEqual(RAW_A);
  });

  test("trims the read to the window at bin granularity", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        startUs: 1_005_500,
        endUs: 1_008_500,
        pixelWidthUs: 1000,
      }),
    );

    expect(segment.startUs).toBe(1_005_000);
    expect(Array.from(segment.data)).toEqual([5, 6, 7, 8]);
  });

  test("selects a pyramid level and resamples it onto the pixel grid", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 16_000 }),
    );

    expect(segment.isMinMax).toBe(true);
    expect(segment.samplePeriodUs).toBe(16_000);
    expect(Array.from(segment.data)).toEqual([0, 15, 16, 31]);
  });

  test("does not resample a level already at pixel resolution", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 4000 }),
    );

    expect(segment.isMinMax).toBe(true);
    expect(segment.samplePeriodUs).toBe(4000);
    expect(Array.from(segment.data)).toEqual(pairsOf(RAW_A, 4));
  });

  test("does not resample when one pixel spans exactly the threshold ratio", async () => {
    // 12000 us pixels over 4000 us bins: exactly 3 bins per pixel.
    const client = makeClient();
    const segment = await collectOne(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 12_000 }),
    );

    expect(segment.samplePeriodUs).toBe(4000);
    expect(Array.from(segment.data)).toEqual(pairsOf(RAW_A, 4));
  });

  test("keeps samples raw at a coarse pixel width when raw is set", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 8000,
        raw: true,
      }),
    );

    expect(segment.isMinMax).toBe(false);
    expect(segment.samplePeriodUs).toBe(1000);
    expect(Array.from(segment.data)).toEqual(RAW_A);
  });

  test("resamples raw data when no coarser level exists", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["r"],
        startUs: 1_000_000,
        endUs: 1_008_000,
        pixelWidthUs: 4000,
      }),
    );

    expect(segment.isMinMax).toBe(true);
    expect(Array.from(segment.data)).toEqual([0, 10, 5, 5]);
  });

  test("yields one segment per channel in request order", async () => {
    const client = makeClient();
    const segments = await collect(
      client.query({ channels: ["b", "a"], ...FULL, pixelWidthUs: 1000 }),
    );
    expect(segments.map((segment) => segment.channel)).toEqual(["b", "a"]);
  });

  test("yields empty data for a window past the channel's end", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        startUs: 2_000_000,
        endUs: 2_032_000,
        pixelWidthUs: 1000,
      }),
    );
    expect(segment.data.length).toBe(0);
    // An empty segment's startUs is the nearest channel edge.
    expect(segment.startUs).toBe(1_032_000);
  });

  test("clamps an empty segment's start to the channel's start", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        startUs: 900_000,
        endUs: 950_000,
        pixelWidthUs: 1000,
      }),
    );
    expect(segment.data.length).toBe(0);
    expect(segment.startUs).toBe(1_000_000);
  });

  test("rejects a window that ends before it starts", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          channels: ["a"],
          startUs: 1_010_000,
          endUs: 1_005_000,
          pixelWidthUs: 1000,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  test("rejects a reversed window on the montage path", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          montage: [{ lead: "a", secondary: "b" }],
          startUs: 1_010_000,
          endUs: 1_005_000,
          pixelWidthUs: 1000,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  test("rejects an unknown channel id", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({ channels: ["nope"], ...FULL, pixelWidthUs: 1000 }),
      ),
    ).rejects.toThrow(/no channel with id nope/);
  });

  describe("channels that share an id", () => {
    const twin = (index: number, base: number): FixtureChannel => ({
      index,
      tsz: tsz("same", `Twin ${index}`, 1000),
      raw: Array.from({ length: 8 }, (_, i) => base + i),
    });
    const makeTwinClient = () =>
      new StreamingClient({
        store: createMemoryStore(bundleFiles([twin(0, 0), twin(1, 100)])),
      });

    test("lists every channel that carries the id", async () => {
      const infos = await makeTwinClient().channelInfo();

      expect(infos.map((info) => [info.index, info.id])).toEqual([
        [0, "same"],
        [1, "same"],
      ]);
    });

    test("rejects a query that names the shared id, naming both indices", async () => {
      const client = makeTwinClient();
      const window = {
        startUs: 1_000_000,
        endUs: 1_008_000,
        pixelWidthUs: 1000,
      };

      await expect(
        collect(client.query({ channels: ["same"], ...window })),
      ).rejects.toThrow(/channel id same is shared by channels 0, 1/);
      await expect(
        collect(client.queryEvents({ channels: ["same"], ...window })),
      ).rejects.toThrow(/channel id same is shared by channels 0, 1/);
    });
  });

  test("rejects an event channel", async () => {
    const client = makeClient();
    await expect(
      collect(client.query({ channels: ["u"], ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(/event channel; use queryEvents/);
  });

  test("rejects a pixel width that is not positive", async () => {
    const client = makeClient();
    await expect(
      collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 0 })),
    ).rejects.toThrow(RangeError);
  });

  test("rejects a query whose signal is already aborted", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          channels: ["a"],
          ...FULL,
          pixelWidthUs: 1000,
          signal: AbortSignal.abort(),
        }),
      ),
    ).rejects.toThrow(/abort/i);
  });

  test("rejects a query carrying both channels and a montage", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          channels: ["a"],
          ...FULL,
          pixelWidthUs: 1000,
          montage: [{ lead: "a", secondary: "b" }],
        }),
      ),
    ).rejects.toThrow(/either channels or montage, not both/);
  });

  test("rejects a query carrying neither channels nor a montage", async () => {
    const client = makeClient();
    await expect(
      collect(client.query({ ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(/no traces/);
    await expect(
      collect(
        client.query({
          channels: [],
          ...FULL,
          pixelWidthUs: 1000,
          montage: [],
        }),
      ),
    ).rejects.toThrow(/no traces/);
  });

  test("propagates a failed read's error", async () => {
    const store = withFailingKey(
      createMemoryStore(bundleFiles(CHANNELS)),
      "/0/raw/c/0",
    );
    const client = new StreamingClient({ store });

    await expect(
      collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(/read of \/0\/raw\/c\/0 failed/);
  });

  test("produces no unhandled rejection when iteration stops early", async () => {
    // The second trace's read fails after the generator is dropped. An unhandled
    // rejection would fail the run.
    const store = withFailingKey(
      createMemoryStore(bundleFiles(CHANNELS)),
      "/1/raw/c/0",
    );
    const client = new StreamingClient({ store });

    const iterator = client
      .query({
        channels: ["a", "b"],
        ...FULL,
        pixelWidthUs: 1000,
        raw: true,
      })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return(undefined);

    // Give the abandoned read a macrotask turn to reject.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("montage", () => {
  test("subtracts a pair on raw data under the montage channel key", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "b" }],
      }),
    );

    expect(segment.channel).toBe("a_A<->B");
    expect(segment.startUs).toBe(1_000_000);
    expect(segment.isMinMax).toBe(false);
    expect(Array.from(segment.data)).toEqual(new Array<number>(32).fill(-100));
  });

  test("resamples a montaged trace onto the pixel grid", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        ...FULL,
        pixelWidthUs: 8000,
        montage: [{ lead: "a", secondary: "b" }],
      }),
    );

    expect(segment.isMinMax).toBe(true);
    expect(Array.from(segment.data)).toEqual(new Array<number>(8).fill(-100));
  });

  test("aligns a pair whose starts differ by whole periods", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "d" }],
      }),
    );

    // Only the overlap of the two extents is read: a[2..32] minus d[0..30].
    expect(segment.startUs).toBe(1_002_000);
    expect(Array.from(segment.data)).toEqual(new Array<number>(30).fill(-198));
  });

  test("subtracts a channel from itself to a zero trace", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "a" }],
      }),
    );

    expect(segment.channel).toBe("a_A<->A");
    expect(Array.from(segment.data)).toEqual(new Array<number>(32).fill(0));
  });

  test("rejects a pair whose sample grids cannot be aligned", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          ...FULL,
          pixelWidthUs: 1000,
          montage: [{ lead: "a", secondary: "m" }],
        }),
      ),
    ).rejects.toThrow(/cannot be aligned/);
  });

  test("rejects a pair whose rates differ", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.query({
          ...FULL,
          pixelWidthUs: 1000,
          montage: [{ lead: "a", secondary: "c" }],
        }),
      ),
    ).rejects.toThrow(/mixes rates/);
  });
});

describe("filter", () => {
  test("filters a trace exactly as the filter module does", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 1000,
        raw: true,
        filter: LOWPASS,
      }),
    );

    const expected = createFilter(LOWPASS, 1000).process(
      Float64Array.from(RAW_A),
    );
    expect(Array.from(segment.data)).toEqual(Array.from(expected));
  });

  test("resamples a filtered trace onto the pixel grid", async () => {
    const client = makeClient();
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 8000,
        filter: LOWPASS,
      }),
    );

    const filtered = createFilter(LOWPASS, 1000).process(
      Float64Array.from(RAW_A),
    );
    expect(segment.isMinMax).toBe(true);
    expect(segment.samplePeriodUs).toBe(8000);
    expect(Array.from(segment.data)).toEqual(pairsOf(Array.from(filtered), 8));
  });

  test("filters continuously across seams that fall between samples", async () => {
    const client = makeClient();
    const chunked: number[] = [];
    const starts: number[] = [];
    // No window edge lands on a sample: each read shares its first sample with
    // the previous read. Three pages cover a second seam after a drop.
    for (const page of [
      { startUs: 1_000_500, endUs: 1_005_500 },
      { startUs: 1_005_500, endUs: 1_010_500 },
      { startUs: 1_010_500, endUs: 1_015_500 },
    ]) {
      const segment = await collectOne(
        client.query({
          channels: ["a"],
          ...page,
          pixelWidthUs: 1000,
          raw: true,
          filter: LOWPASS,
        }),
      );
      starts.push(segment.startUs);
      chunked.push(...Array.from(segment.data));
    }

    // Each page resumes on the first sample the previous page did not return.
    expect(starts).toEqual([1_000_000, 1_006_000, 1_011_000]);
    expect(chunked).toHaveLength(16);
    const expected = createFilter(LOWPASS, 1000).process(
      Float64Array.from(RAW_A.slice(0, 16)),
    );
    expect(chunked).toEqual(Array.from(expected));
  });

  test("filters continuously on a channel whose period is not a whole microsecond", async () => {
    const client = makeClient();
    const info = continuousById(await client.channelInfo(), "f");
    const periodUs = 1e6 / 512;
    const seam = info.startUs + 100.5 * periodUs;
    const chunked: number[] = [];
    for (const page of [
      { startUs: info.startUs + 0.5 * periodUs, endUs: seam },
      { startUs: seam, endUs: seam + 100 * periodUs },
    ]) {
      const segment = await collectOne(
        client.query({
          channels: ["f"],
          ...page,
          pixelWidthUs: periodUs,
          raw: true,
          filter: LOWPASS_512,
        }),
      );
      chunked.push(...Array.from(segment.data));
    }

    const expected = createFilter(LOWPASS_512, 512).process(
      Float64Array.from(FRACTIONAL.slice(0, chunked.length)),
    );
    expect(chunked.length).toBeGreaterThan(100);
    expect(chunked).toEqual(Array.from(expected));
  });

  test("carries filter state across consecutive queries and resets on a jump back", async () => {
    const client = makeClient();
    const halves = [
      { startUs: 1_000_000, endUs: 1_016_000 },
      { startUs: 1_016_000, endUs: 1_032_000 },
    ];
    const chunked: number[] = [];
    for (const half of halves) {
      const segment = await collectOne(
        client.query({
          channels: ["a"],
          ...half,
          pixelWidthUs: 1000,
          raw: true,
          filter: LOWPASS,
        }),
      );
      chunked.push(...Array.from(segment.data));
    }

    const whole = await collectOne(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 1000,
        raw: true,
        filter: LOWPASS,
      }),
    );

    expect(chunked).toEqual(Array.from(whole.data));
  });
});

describe("byte cap", () => {
  test("rejects with RawReadTooLargeError before issuing any fetch", async () => {
    const client = makeClient(64);
    const failure: unknown = await collect(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 1000,
        filter: LOWPASS,
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(failure instanceof RawReadTooLargeError)) {
      throw new Error("expected a RawReadTooLargeError rejection");
    }
    expect(failure.requestedBytes).toBe(128);
    expect(failure.maxBytes).toBe(64);
    expect(failure.name).toBe("RawReadTooLargeError");
  });

  test("counts both sides of a montage against the cap", async () => {
    const client = makeClient(200);
    await expect(
      collect(
        client.query({
          ...FULL,
          pixelWidthUs: 1000,
          montage: [{ lead: "a", secondary: "b" }],
        }),
      ),
    ).rejects.toThrow(RawReadTooLargeError);
  });

  test("applies the cap to a raw query", async () => {
    const client = makeClient(64);
    await expect(
      collect(
        client.query({
          channels: ["a"],
          ...FULL,
          pixelWidthUs: 1000,
          raw: true,
        }),
      ),
    ).rejects.toThrow(RawReadTooLargeError);
  });

  test("applies a per-query cap override", async () => {
    const client = makeClient(64);
    const segment = await collectOne(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 1000,
        raw: true,
        maxRawBytes: 128,
      }),
    );
    expect(segment.data.length).toBe(32);
  });

  test("applies the cap to a read that selects the raw level through the pixel width", async () => {
    const client = makeClient(64);
    await expect(
      collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(RawReadTooLargeError);
  });

  test("does not count a min/max level against the cap", async () => {
    const client = makeClient(64);
    const segment = await collectOne(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 4000 }),
    );
    expect(segment.isMinMax).toBe(true);
    expect(segment.data.length).toBe(16);
  });
});

describe("reads a query does not finish", () => {
  test("rejects a filter spec outside a trace's Nyquist range before any read", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );
    const client = new StreamingClient({ store: counting.store });
    await client.channelInfo();
    const before = counting.total();

    await expect(
      collect(
        client.query({
          channels: ["a", "b"],
          ...FULL,
          pixelWidthUs: 1000,
          filter: { type: "lowpass", order: 4, cutoffHz: 600 },
        }),
      ),
    ).rejects.toThrow(RangeError);

    expect(counting.total()).toBe(before);
  });

  test("cancels the other traces' reads when one read fails", async () => {
    const held = withHeldKeys(
      withFailingKey(createMemoryStore(bundleFiles(CHANNELS)), "/1/raw/c/0"),
      new Set(["/2/raw/c/0"]),
    );
    const client = new StreamingClient({ store: held.store });

    await expect(
      collect(
        client.query({
          channels: ["a", "b", "c"],
          ...FULL,
          pixelWidthUs: 1000,
        }),
      ),
    ).rejects.toThrow("read of /1/raw/c/0 failed");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = held.signals.get("/2/raw/c/0");
    expect(pending?.aborted).toBe(true);
  });

  test("cancels the remaining reads when the consumer stops iterating", async () => {
    const held = withHeldKeys(
      createMemoryStore(bundleFiles(CHANNELS)),
      new Set(["/1/raw/c/0", "/2/raw/c/0"]),
    );
    const client = new StreamingClient({ store: held.store });

    for await (const segment of client.query({
      channels: ["a", "b", "c"],
      ...FULL,
      pixelWidthUs: 1000,
    })) {
      expect(segment.channel).toBe("a");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.signals.size).toBeGreaterThan(0);
    for (const signal of held.signals.values()) {
      expect(signal?.aborted).toBe(true);
    }
  });

  test("leaves the reads running while the consumer is still iterating", async () => {
    const held = withHeldKeys(
      createMemoryStore(bundleFiles(CHANNELS)),
      new Set(["/2/raw/c/0"]),
    );
    const client = new StreamingClient({ store: held.store });
    const iterator = client
      .query({ channels: ["a", "c"], ...FULL, pixelWidthUs: 1000 })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(held.signals.get("/2/raw/c/0")?.aborted).toBe(false);
    await iterator.return(undefined);
  });
});

describe("chunked levels", () => {
  const chunked: FixtureChannel[] = [
    {
      index: 0,
      tsz: tsz("k", "K", 1000),
      raw: RAW_A,
      rawChunkLength: 8,
      levels: [{ periodUs: 4000, pairs: pairsOf(RAW_A, 4), chunkLength: 3 }],
    },
  ];

  test("reads a raw window that crosses chunk boundaries", async () => {
    const client = new StreamingClient({
      store: createMemoryStore(bundleFiles(chunked)),
    });
    const segment = await collectOne(
      client.query({
        channels: ["k"],
        startUs: 1_006_000,
        endUs: 1_018_000,
        pixelWidthUs: 1000,
      }),
    );
    expect(segment.startUs).toBe(1_006_000);
    expect(Array.from(segment.data)).toEqual(RAW_A.slice(6, 18));
  });

  test("reads a min/max level whose last chunk is partial", async () => {
    const client = new StreamingClient({
      store: createMemoryStore(bundleFiles(chunked)),
    });
    const segment = await collectOne(
      client.query({ channels: ["k"], ...FULL, pixelWidthUs: 4000 }),
    );
    expect(Array.from(segment.data)).toEqual(pairsOf(RAW_A, 4));
  });
});

describe("queryEvents", () => {
  test("reads events and labels without waveforms when zoomed out", async () => {
    const client = makeClient();
    const window = await collectOne(
      client.queryEvents({
        channels: ["u"],
        startUs: 1_003_000,
        endUs: 1_009_000,
        pixelWidthUs: 1000,
      }),
    );

    expect(window.channel).toBe("u");
    expect(Array.from(window.times)).toEqual([1_005_000, 1_005_500]);
    expect(Array.from(window.labels!)).toEqual([1, 1]);
    expect(window.waveforms).toBeUndefined();
  });

  test("reads waveforms when zoomed in", async () => {
    const client = makeClient();
    const window = await collectOne(
      client.queryEvents({
        channels: ["u"],
        startUs: 1_003_000,
        endUs: 1_009_000,
        pixelWidthUs: 20,
      }),
    );

    expect(window.waveforms?.pointsPerEvent).toBe(3);
    expect(Array.from(window.waveforms!.data)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  test("yields one window per channel in request order", async () => {
    const client = makeClient();
    const windows = await collect(
      client.queryEvents({
        channels: ["k", "u"],
        startUs: 0,
        endUs: 2_000_000,
      }),
    );
    expect(windows.map((window) => window.channel)).toEqual(["k", "u"]);
    expect(windows[0]!.text).toEqual(["first", "", "last"]);
    expect(windows[0]!.channels).toEqual([["a"], [], ["a", "b"]]);
  });

  test("includes an interval still open at the window start", async () => {
    const client = makeClient();
    const window = await collectOne(
      client.queryEvents({
        channels: ["k"],
        startUs: 1_005_000,
        endUs: 1_010_000,
      }),
    );
    expect(Array.from(window.times)).toEqual([1_000_000]);
    expect(Array.from(window.durations!)).toEqual([10_000]);
  });

  test("rejects a continuous channel", async () => {
    const client = makeClient();
    await expect(
      collect(client.queryEvents({ channels: ["a"], ...FULL })),
    ).rejects.toThrow(/continuous channel; use query\(\)/);
  });

  test("rejects an unknown channel id", async () => {
    const client = makeClient();
    await expect(
      collect(client.queryEvents({ channels: ["nope"], ...FULL })),
    ).rejects.toThrow(/no channel with id nope/);
  });

  test("rejects a pixel width that is not positive", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryEvents({
          channels: ["u"],
          ...FULL,
          pixelWidthUs: Number.NaN,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  test("rejects a query whose signal is already aborted", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryEvents({
          channels: ["u"],
          ...FULL,
          signal: AbortSignal.abort(),
        }),
      ),
    ).rejects.toThrow(/abort/i);
  });

  test("rejects a window that ends before it starts", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryEvents({
          channels: ["u"],
          startUs: 1_010_000,
          endUs: 1_005_000,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });
});

describe("eventCounts", () => {
  test("reads the coarsest count level that fits the pixel width", async () => {
    const client = makeClient();
    const counts = await client.eventCounts({
      channel: "u",
      startUs: 1_000_000,
      endUs: 1_012_000,
      pixelWidthUs: 5000,
    });
    expect(counts).toEqual({
      channel: "u",
      level: 1,
      startUs: 1_000_000,
      periodUs: 4000,
      labelCount: 2,
      counts: Uint32Array.from([1, 0, 0, 2, 1, 0]),
    });
  });

  test("delivers whole bins around the window", async () => {
    const client = makeClient();
    const counts = await client.eventCounts({
      channel: "u",
      startUs: 1_005_000,
      endUs: 1_006_000,
      pixelWidthUs: 4000,
    });
    expect(counts.startUs).toBe(1_004_000);
    expect(Array.from(counts.counts)).toEqual([0, 2]);
  });

  test("falls back to the finest count level at a narrow pixel width", async () => {
    const client = makeClient();
    const counts = await client.eventCounts({
      channel: "u",
      startUs: 1_000_000,
      endUs: 1_016_000,
      pixelWidthUs: 10,
    });
    expect(counts.level).toBe(1);
    expect(counts.counts.length).toBe(6);
  });

  test("selects a coarser level when the pixel width allows", async () => {
    const client = makeClient();
    const counts = await client.eventCounts({
      channel: "u",
      startUs: 1_000_000,
      endUs: 1_016_000,
      pixelWidthUs: 20_000,
    });
    expect(counts.level).toBe(2);
    expect(counts.periodUs).toBe(16_000);
    expect(Array.from(counts.counts)).toEqual([2, 2]);
  });

  test("returns no bins for a window past the levels", async () => {
    const client = makeClient();
    const counts = await client.eventCounts({
      channel: "u",
      startUs: 5_000_000,
      endUs: 6_000_000,
      pixelWidthUs: 4000,
    });
    expect(counts.counts.length).toBe(0);
  });

  test("rejects a channel with no count levels, a continuous channel, and bad bounds", async () => {
    const client = makeClient();
    await expect(
      client.eventCounts({ channel: "k", ...FULL, pixelWidthUs: 4000 }),
    ).rejects.toThrow(/no count levels/);
    await expect(
      client.eventCounts({ channel: "a", ...FULL, pixelWidthUs: 4000 }),
    ).rejects.toThrow(/continuous channel/);
    await expect(
      client.eventCounts({ channel: "u", ...FULL, pixelWidthUs: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      client.eventCounts({
        channel: "u",
        startUs: 2,
        endUs: 1,
        pixelWidthUs: 4000,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("waveformMean", () => {
  test("reads one mean snippet per label", async () => {
    const client = makeClient();
    await expect(client.waveformMean({ channel: "u" })).resolves.toEqual({
      pointsPerEvent: 3,
      periodUs: 100,
      eventSample: 0,
      data: Float64Array.from([1, 2, 3, 4, 5, 6]),
    });
  });

  test("resolves undefined for a channel without one", async () => {
    const client = makeClient();
    await expect(
      client.waveformMean({ channel: "k" }),
    ).resolves.toBeUndefined();
  });

  test("rejects a continuous channel", async () => {
    const client = makeClient();
    await expect(client.waveformMean({ channel: "a" })).rejects.toThrow(
      /continuous channel/,
    );
  });
});

describe("dataSpans", () => {
  test("reports spans from the coarsest level", async () => {
    const client = makeClient();
    expect(await client.dataSpans({ channel: "g", ...FULL })).toEqual([
      [1_000_000, 1_004_000],
      [1_008_000, 1_016_000],
      [1_024_000, 1_032_000],
    ]);
  });

  test("uses the level's count when it has one, so a partly recorded bin is covered", async () => {
    const client = makeClient();
    expect(await client.dataSpans({ channel: "h", ...FULL })).toEqual([
      [1_000_000, 1_008_000],
      [1_012_000, 1_032_000],
    ]);
  });

  test("bridges gaps no wider than the threshold", async () => {
    const client = makeClient();
    expect(
      await client.dataSpans({
        channel: "g",
        ...FULL,
        gapThresholdUs: 4000,
      }),
    ).toEqual([
      [1_000_000, 1_016_000],
      [1_024_000, 1_032_000],
    ]);
    expect(
      await client.dataSpans({
        channel: "g",
        ...FULL,
        gapThresholdUs: 8000,
      }),
    ).toEqual([[1_000_000, 1_032_000]]);
  });

  test("clamps span edges to the window", async () => {
    const client = makeClient();
    expect(
      await client.dataSpans({
        channel: "g",
        startUs: 1_002_000,
        endUs: 1_006_000,
      }),
    ).toEqual([[1_002_000, 1_004_000]]);
  });

  test("reports no spans for a window with no data", async () => {
    const client = makeClient();
    expect(
      await client.dataSpans({
        channel: "g",
        startUs: 1_004_000,
        endUs: 1_008_000,
      }),
    ).toEqual([]);
  });

  test("reads spans from a raw-only channel", async () => {
    const client = makeClient();
    expect(
      await client.dataSpans({
        channel: "r",
        startUs: 1_000_000,
        endUs: 1_008_000,
      }),
    ).toEqual([[1_000_000, 1_008_000]]);
  });

  test("rejects an event channel", async () => {
    const client = makeClient();
    await expect(client.dataSpans({ channel: "u", ...FULL })).rejects.toThrow(
      /event channel/,
    );
  });

  test("rejects a call whose signal is already aborted", async () => {
    const client = makeClient();
    await expect(
      client.dataSpans({
        channel: "g",
        ...FULL,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/abort/i);
  });

  test("passes its signal through to the level read", async () => {
    // The signal aborts during the catalog read, past the guard at the top of the call.
    // Only a signal reaching the store can reject this.
    const controller = new AbortController();
    const inner = createMemoryStore(bundleFiles(CHANNELS));
    const store: Store = {
      get: (key, opts) => {
        if (key === "/zarr.json") {
          controller.abort();
        }
        return inner.get(key, opts);
      },
      getRange: (key, range, opts) => inner.getRange(key, range, opts),
    };
    const client = new StreamingClient({ store });

    await expect(
      client.dataSpans({ channel: "g", ...FULL, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

describe("in-flight cap", () => {
  /** Wraps a store and records the most reads it ever had open at once. */
  function trackConcurrency(inner: Store): {
    store: Store;
    peak: () => number;
  } {
    let open = 0;
    let peak = 0;
    const enter = async <T>(work: Promise<T>): Promise<T> => {
      open += 1;
      peak = Math.max(peak, open);
      try {
        return await work;
      } finally {
        open -= 1;
      }
    };
    return {
      store: {
        get: (key, opts) => enter(inner.get(key, opts)),
        getRange: (key, range, opts) => enter(inner.getRange(key, range, opts)),
      },
      peak: () => peak,
    };
  }

  test("holds reads to the requested cap", async () => {
    const tracked = trackConcurrency(createMemoryStore(bundleFiles(CHANNELS)));
    const client = new StreamingClient({
      store: tracked.store,
      maxInflightFetches: 2,
      maxCacheBytes: 0,
    });

    await collect(
      client.query({
        channels: ["a", "b", "c", "r", "g"],
        ...FULL,
        pixelWidthUs: 1000,
      }),
    );

    expect(tracked.peak()).toBeLessThanOrEqual(2);
  });

  test("reads more traces at once when the cap allows", async () => {
    const tracked = trackConcurrency(createMemoryStore(bundleFiles(CHANNELS)));
    const client = new StreamingClient({
      store: tracked.store,
      maxInflightFetches: 5,
      maxCacheBytes: 0,
    });

    await collect(
      client.query({
        channels: ["a", "b", "c", "r", "g"],
        ...FULL,
        pixelWidthUs: 1000,
      }),
    );

    expect(tracked.peak()).toBeGreaterThan(2);
  });

  test("yields every trace in order when there are more traces than the cap", async () => {
    const count = 130;
    const many: FixtureChannel[] = Array.from({ length: count }, (_, i) => ({
      index: i,
      tsz: tsz(`ch${i}`, `Channel ${i}`, 1000),
      raw: Array.from({ length: 8 }, (_, j) => i + j),
    }));
    const tracked = trackConcurrency(createMemoryStore(bundleFiles(many)));
    const client = new StreamingClient({
      store: tracked.store,
      maxCacheBytes: 0,
    });

    const segments = await collect(
      client.query({
        channels: many.map((channel) => channel.tsz.id as string),
        ...FULL,
        pixelWidthUs: 1000,
      }),
    );

    expect(segments).toHaveLength(count);
    segments.forEach((segment, i) => {
      expect(segment.channel).toBe(`ch${i}`);
      expect(segment.data[0]).toBe(i);
    });
    expect(tracked.peak()).toBeLessThanOrEqual(64);
  });
});

describe("response cache", () => {
  test("reads no array metadata key beyond the bundle root", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );
    const client = new StreamingClient({ store: counting.store });

    await collect(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
    );
    await collect(client.queryEvents({ channels: ["k"], ...FULL }));

    const metadataKeys = [...counting.reads.keys()].filter((key) =>
      key.endsWith("zarr.json"),
    );
    expect(metadataKeys).toEqual(["/zarr.json"]);
  });

  test("reads the bundle root once across queries", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );
    const client = new StreamingClient({ store: counting.store });

    await client.channelInfo();
    await collect(
      client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
    );

    expect(counting.reads.get("/zarr.json")).toBe(1);
  });

  test("serves a repeated query from the cache", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );
    const client = new StreamingClient({ store: counting.store });
    const query = { channels: ["a"], ...FULL, pixelWidthUs: 1000 };

    await collect(client.query(query));
    const afterFirst = counting.total();
    await collect(client.query(query));

    expect(counting.total()).toBe(afterFirst);
  });

  test("reads through to the store when the cache is disabled", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles(CHANNELS)),
    );
    const client = new StreamingClient({
      store: counting.store,
      maxCacheBytes: 0,
    });
    const query = { channels: ["a"], ...FULL, pixelWidthUs: 1000 };

    await collect(client.query(query));
    const afterFirst = counting.total();
    await collect(client.query(query));

    expect(counting.total()).toBeGreaterThan(afterFirst);
  });

  test("returns the same samples whether or not the cache is on", async () => {
    const files = bundleFiles(CHANNELS);
    const query = { channels: ["a", "b"], ...FULL, pixelWidthUs: 1000 };
    const cached = new StreamingClient({ store: createMemoryStore(files) });
    const uncached = new StreamingClient({
      store: createMemoryStore(files),
      maxCacheBytes: 0,
    });

    const fromCached = await collect(cached.query(query));
    const fromUncached = await collect(uncached.query(query));

    expect(fromCached).toEqual(fromUncached);
  });
});

// scripts/generate-test-bundle.py writes test-data/sample.zarr and lists its contents.
const BUNDLE = fileURLToPath(
  new URL("../test-data/sample.zarr", import.meta.url),
);
const SINE_HZ = 5;
const AMPLITUDE = 50;
const RATE_HZ = 1000;
const SPIKE_STEP_US = 137_000;
const SPIKE_COUNT = 70_000;

describe("runs", () => {
  const tszOf = (id: string) => ({
    kind: "continuous",
    name: id,
    id,
    unit: "uV",
    rate_hz: 1000,
    offset_us: 1_000_000,
  });
  const TEN = Array.from({ length: 10 }, (_, i) => i);
  // Four samples, a pause of two grid samples, four more starting 0.4 periods late.
  const PAUSED: FixtureChannel = {
    index: 0,
    tsz: tszOf("p"),
    raw: TEN,
    runs: [
      [0, 4, 1_000_000],
      [6, 4, 1_006_400],
    ],
  };
  const PLAIN: FixtureChannel = { index: 1, tsz: tszOf("q"), raw: [1, 2, 3] };
  const EMPTY: FixtureChannel = { index: 2, tsz: tszOf("e"), raw: [] };
  const EVENTS: FixtureChannel = {
    index: 3,
    tsz: { kind: "event", name: "E", id: "ev" },
    events: [1],
  };
  const makeClient = (channels: FixtureChannel[]) =>
    new StreamingClient({ store: createMemoryStore(bundleFiles(channels)) });

  test("reads the table with the exact start and end of each run", async () => {
    const client = makeClient([PAUSED, PLAIN, EMPTY, EVENTS]);

    expect(await client.runs({ channel: "p" })).toEqual([
      { firstSample: 0, sampleCount: 4, startUs: 1_000_000, endUs: 1_004_000 },
      { firstSample: 6, sampleCount: 4, startUs: 1_006_400, endUs: 1_010_400 },
    ]);
    // The channel ends where its last run does.
    const info = continuousById(await client.channelInfo(), "p");
    expect([info.runs, info.startUs, info.endUs]).toEqual([
      2, 1_000_000, 1_010_400,
    ]);
  });

  test("synthesizes one run without a table, and none for an empty channel", async () => {
    const client = makeClient([PAUSED, PLAIN, EMPTY, EVENTS]);
    expect(await client.runs({ channel: "q" })).toEqual([
      { firstSample: 0, sampleCount: 3, startUs: 1_000_000, endUs: 1_003_000 },
    ]);
    expect(await client.runs({ channel: "e" })).toEqual([]);
  });

  test("reads the table once per channel", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles([PAUSED, PLAIN, EMPTY, EVENTS])),
    );
    const client = new StreamingClient({ store: counting.store });
    await client.runs({ channel: "p" });
    await client.runs({ channel: "p" });
    expect(counting.reads.get("/0/runs/c/0/0")).toBe(1);
  });

  test("rejects a table that breaks the format's rules, then retries", async () => {
    const broken: Array<[number[][], RegExp]> = [
      // Row 0 must start the channel at offset_us.
      [[[0, 10, 1_000_500]], /row 0 .* must be \[0, n, 1000000\]/],
      // A run cannot start inside the one before it.
      [
        [
          [0, 4, 1_000_000],
          [3, 7, 1_003_000],
        ],
        /row 1 .* overlaps the run before it, which ends at sample 4/,
      ],
      // A run cannot start before the samples of the one before it end.
      [
        [
          [0, 4, 1_000_000],
          [4, 6, 1_003_500],
        ],
        /row 1 .* starts before the run before it ends at 1004000 us/,
      ],
      // A run starts within one sample period of its grid sample.
      [
        [
          [0, 4, 1_000_000],
          [6, 4, 1_005_000],
        ],
        /row 1 .* starts -1000 us from its grid sample/,
      ],
      // The last run ends at the last sample.
      [[[0, 9, 1_000_000]], /runs end at sample 9 but raw holds 10 samples/],
    ];
    for (const [runs, message] of broken) {
      const client = makeClient([{ ...PAUSED, runs }]);
      await expect(client.runs({ channel: "p" })).rejects.toThrow(message);
      await expect(client.runs({ channel: "p" })).rejects.toThrow(message);
    }
  });

  test("rejects only the caller that aborts, and honours a later caller's signal", async () => {
    const counting = createCountingStore(
      createMemoryStore(bundleFiles([PAUSED, PLAIN, EMPTY, EVENTS])),
    );
    const client = new StreamingClient({ store: counting.store });

    const first = new AbortController();
    const second = new AbortController();
    const firstCall = client.runs({ channel: "p", signal: first.signal });
    const secondCall = client.runs({ channel: "p", signal: second.signal });
    const thirdCall = client.runs({ channel: "p" });
    first.abort(new Error("first gave up"));

    await expect(firstCall).rejects.toThrow(/first gave up/);
    expect((await secondCall).length).toBe(2);
    expect((await thirdCall).length).toBe(2);
    expect(counting.reads.get("/0/runs/c/0/0")).toBe(1);

    // A caller joining after the read is cached can still be aborted.
    const late = new AbortController();
    const lateCall = client.runs({ channel: "q", signal: late.signal });
    late.abort(new Error("late gave up"));
    await expect(lateCall).rejects.toThrow(/late gave up/);
    expect((await client.runs({ channel: "q" })).length).toBe(1);
  });

  describe("raw reads", () => {
    const query = (
      client: StreamingClient,
      startUs: number,
      endUs: number,
      extra: Partial<Parameters<StreamingClient["query"]>[0]> = {},
    ) =>
      collect(
        client.query({
          channels: ["p"],
          startUs,
          endUs,
          pixelWidthUs: 1000,
          raw: true,
          ...extra,
        }),
      );
    const pieces = (segments: readonly Segment[]) =>
      segments.map((segment) => [segment.startUs, Array.from(segment.data)]);

    test("yields one segment per run at the exact time of its first sample", async () => {
      const client = makeClient([PAUSED]);
      const segments = await query(client, 1_000_000, 1_010_400);
      expect(pieces(segments)).toEqual([
        [1_000_000, [0, 1, 2, 3]],
        [1_006_400, [6, 7, 8, 9]],
      ]);
      expect(segments.map((segment) => segment.channel)).toEqual(["p", "p"]);
      expect(segments.every((segment) => !segment.isMinMax)).toBe(true);
    });

    test("selects the raw level by pixel width without raw set", async () => {
      const client = makeClient([PAUSED]);
      const segments = await query(client, 1_000_000, 1_010_400, {
        raw: false,
      });
      expect(pieces(segments)).toEqual([
        [1_000_000, [0, 1, 2, 3]],
        [1_006_400, [6, 7, 8, 9]],
      ]);
    });

    test("cuts the first and last run at the window", async () => {
      const client = makeClient([PAUSED]);
      // Sample 1 spans [1_001_000, 1_002_000) and sample 7 starts at 1_007_400.
      const segments = await query(client, 1_001_500, 1_007_500);
      expect(pieces(segments)).toEqual([
        [1_001_000, [1, 2, 3]],
        [1_006_400, [6, 7]],
      ]);
    });

    test("starts a segment inside a run at that sample's time", async () => {
      const client = makeClient([PAUSED]);
      const segments = await query(client, 1_007_500, 1_009_000);
      expect(pieces(segments)).toEqual([[1_007_400, [7, 8]]]);
    });

    test("yields one empty segment for a window inside the pause", async () => {
      const client = makeClient([PAUSED]);
      const segments = await query(client, 1_004_000, 1_006_000);
      expect(pieces(segments)).toEqual([[1_004_000, []]]);
    });

    test("yields one empty segment for a window outside the channel", async () => {
      const client = makeClient([PAUSED]);
      expect(pieces(await query(client, 0, 500_000))).toEqual([
        [1_000_000, []],
      ]);
      expect(pieces(await query(client, 2_000_000, 3_000_000))).toEqual([
        [1_010_000, []],
      ]);
    });

    test("keeps a trace without a table in one segment on the grid", async () => {
      const client = makeClient([PAUSED, PLAIN]);
      const segments = await query(client, 1_000_000, 1_003_000, {
        channels: ["q"],
      });
      expect(pieces(segments)).toEqual([[1_000_000, [1, 2, 3]]]);
    });

    test("yields each trace's segments in request order", async () => {
      const client = makeClient([PAUSED, PLAIN]);
      const segments = await query(client, 1_000_000, 1_010_400, {
        channels: ["q", "p"],
      });
      expect(segments.map((segment) => segment.channel)).toEqual([
        "q",
        "p",
        "p",
      ]);
    });

    test("counts the samples read against the byte cap, not the pause", async () => {
      const client = makeClient([PAUSED]);
      // Eight samples of four bytes. The grid between the first and last holds ten.
      const segments = await query(client, 1_000_000, 1_010_400, {
        maxRawBytes: 32,
      });
      expect(segments).toHaveLength(2);
      await expect(
        query(client, 1_000_000, 1_010_400, { maxRawBytes: 31 }),
      ).rejects.toBeInstanceOf(RawReadTooLargeError);
    });

    test("reads the runs once for a query and the calls that follow", async () => {
      const counting = createCountingStore(
        createMemoryStore(bundleFiles([PAUSED])),
      );
      const client = new StreamingClient({ store: counting.store });
      await query(client, 1_000_000, 1_010_400);
      await client.runs({ channel: "p" });
      await client.channelInfo();
      expect(counting.reads.get("/0/runs/c/0/0")).toBe(1);
    });

    test("keeps a montage on the grid", async () => {
      const partner: FixtureChannel = {
        index: 1,
        tsz: tszOf("r"),
        raw: TEN.map((value) => 2 * value),
      };
      const client = makeClient([PAUSED, partner]);
      const [segment] = await collect(
        client.query({
          montage: [{ lead: "p", secondary: "r" }],
          startUs: 1_000_000,
          endUs: 1_010_400,
          pixelWidthUs: 1000,
        }),
      );
      expect([segment!.startUs, Array.from(segment!.data)]).toEqual([
        1_000_000,
        TEN.map((value) => 0 - value),
      ]);
    });

    test("rejects an unknown channel before reading the runs", async () => {
      const counting = createCountingStore(
        createMemoryStore(bundleFiles([PAUSED])),
      );
      const client = new StreamingClient({ store: counting.store });
      await expect(
        query(client, 1_000_000, 1_010_400, { channels: ["p", "nope"] }),
      ).rejects.toThrow(/no channel with id nope/);
      expect(counting.reads.get("/0/runs/c/0/0")).toBeUndefined();
    });

    test("rejects an aborted signal while the runs load", async () => {
      const client = makeClient([PAUSED]);
      const controller = new AbortController();
      const pending = query(client, 1_000_000, 1_010_400, {
        signal: controller.signal,
      });
      controller.abort(new Error("stop"));
      await expect(pending).rejects.toThrow(/stop/);
    });
  });

  describe("filtered reads", () => {
    const spec = { type: "lowpass", order: 2, cutoffHz: 100 } as const;
    const ramp = (count: number): number[] =>
      Array.from({ length: count }, (_, i) =>
        Math.fround(Math.sin(i / 3) * 10 + i),
      );
    const filteredRuns = async (channel: FixtureChannel, endUs: number) =>
      collect(
        makeClient([channel]).query({
          channels: ["p"],
          startUs: 1_000_000,
          endUs,
          pixelWidthUs: 1000,
          raw: true,
          filter: spec,
        }),
      );

    test("continues the filter across a pause shorter than the reset gap", async () => {
      const [first, second] = await filteredRuns(PAUSED, 1_010_400);
      const expected = createFilter(spec, 1000).process(
        Float64Array.from([0, 1, 2, 3, 6, 7, 8, 9]),
      );
      expect(Array.from(first!.data)).toEqual(Array.from(expected.slice(0, 4)));
      expect(Array.from(second!.data)).toEqual(Array.from(expected.slice(4)));
    });

    test("restarts the filter after a pause longer than the reset gap", async () => {
      // 400 samples, a pause of 200 grid samples, and a resume 0.4 periods late.
      const raw = ramp(400);
      const channel: FixtureChannel = {
        index: 0,
        tsz: tszOf("p"),
        raw,
        runs: [
          [0, 100, 1_000_000],
          [300, 100, 1_300_400],
        ],
      };
      const [first, second] = await filteredRuns(channel, 1_400_400);
      const before = Float64Array.from(raw.slice(0, 100));
      const after = Float64Array.from(raw.slice(300));
      expect(Array.from(first!.data)).toEqual(
        Array.from(createFilter(spec, 1000).process(before)),
      );
      expect(Array.from(second!.data)).toEqual(
        Array.from(createFilter(spec, 1000).process(after)),
      );
    });

    test("continues the filter across a resume less than one period off the grid", async () => {
      // No pause: the second run follows the first and starts 0.4 periods late.
      const raw = ramp(8);
      const channel: FixtureChannel = {
        index: 0,
        tsz: tszOf("p"),
        raw,
        runs: [
          [0, 4, 1_000_000],
          [4, 4, 1_004_400],
        ],
      };
      const [first, second] = await filteredRuns(channel, 1_008_400);
      const expected = createFilter(spec, 1000).process(Float64Array.from(raw));
      expect(Array.from(first!.data)).toEqual(Array.from(expected.slice(0, 4)));
      expect(Array.from(second!.data)).toEqual(Array.from(expected.slice(4)));
    });
  });

  test("ends the channel where its last run does, in info and data spans", async () => {
    const channel: FixtureChannel = {
      ...PAUSED,
      raw: [0, 1, 2, 3, NaN, NaN, 6, 7, 8, 9],
    };
    const client = makeClient([channel]);
    const info = continuousById(await client.channelInfo(), "p");
    expect(info.endUs).toBe(1_010_400);
    expect(
      await client.dataSpans({
        channel: "p",
        startUs: 0,
        endUs: 2_000_000,
      }),
    ).toEqual([
      [1_000_000, 1_004_000],
      [1_006_400, 1_010_400],
    ]);
  });

  test("clamps data spans to the window at exact sample times", async () => {
    const channel: FixtureChannel = {
      ...PAUSED,
      raw: [0, 1, 2, 3, NaN, NaN, 6, 7, 8, 9],
    };
    const client = makeClient([channel]);
    expect(
      await client.dataSpans({
        channel: "p",
        startUs: 1_002_000,
        endUs: 1_008_000,
        gapThresholdUs: 2400,
      }),
    ).toEqual([[1_002_000, 1_008_000]]);
  });

  test("rejects an event channel, an unknown id, and an aborted signal", async () => {
    const client = makeClient([PAUSED, PLAIN, EMPTY, EVENTS]);
    await expect(client.runs({ channel: "ev" })).rejects.toThrow(
      /is an event channel/,
    );
    await expect(client.runs({ channel: "nope" })).rejects.toThrow(
      /no channel with id nope/,
    );
    await expect(
      client.runs({ channel: "p", signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe("acceptance: committed bundle", () => {
  test("lists the channels with bundle-relative times and the recording's origin", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const infos = await client.channelInfo();

    expect(infos.map((info) => [info.index, info.id, info.kind])).toEqual([
      [0, "sineA", "continuous"],
      [1, "sineB", "continuous"],
      [2, "noise", "continuous"],
      [3, "pausedA", "continuous"],
      [4, "unitA", "event"],
      [5, "marks", "event"],
    ]);
    const sineA = continuousById(infos, "sineA");
    expect([sineA.startUs, sineA.endUs]).toEqual([0, 30_000_000]);
    const sineB = continuousById(infos, "sineB");
    expect([sineB.startUs, sineB.endUs]).toEqual([2_000_000, 32_000_000]);

    const recording = await client.recording();
    expect(recording?.referenceTimeUs).toBe(1_704_067_200_000_000);
    expect(recording?.subject).toEqual({ id: "sub-synth" });
  });

  test("raw samples match the generating sine", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = continuousById(await client.channelInfo(), "sineA");

    const segment = await collectOne(
      client.query({
        channels: [info.id],
        startUs: info.startUs,
        endUs: info.startUs + 100_000,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );

    expect(segment.data.length).toBe(100);
    Array.from(segment.data).forEach((value, i) => {
      expect(value).toBeCloseTo(
        AMPLITUDE * Math.sin((2 * Math.PI * SINE_HZ * i) / RATE_HZ),
        3,
      );
    });
  });

  test("a pyramid level equals min/max over the raw samples it summarizes", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = continuousById(await client.channelInfo(), "sineA");
    const window = { startUs: info.startUs, endUs: info.endUs };

    const pyramid = await collectOne(
      client.query({ channels: [info.id], ...window, pixelWidthUs: 64_000 }),
    );
    const raw = await collectOne(
      client.query({
        channels: [info.id],
        ...window,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );

    const expected = pairsOf(Array.from(raw.data), 64);
    expect(pyramid.isMinMax).toBe(true);
    expect(pyramid.samplePeriodUs).toBe(64_000);
    expect(Array.from(pyramid.data)).toEqual(expected);
  });

  test("a montage across channels with different offsets reads their shared extent", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const segment = await collectOne(
      client.query({
        montage: [{ lead: "sineA", secondary: "sineB" }],
        startUs: 0,
        endUs: 2_010_000,
        pixelWidthUs: 1000,
      }),
    );

    // sineB starts at 2 s, so the pair overlaps from there: a[2000..2010] - b[0..10].
    expect(segment.startUs).toBe(2_000_000);
    expect(segment.data.length).toBe(10);
    Array.from(segment.data).forEach((value, i) => {
      const a =
        AMPLITUDE * Math.sin((2 * Math.PI * SINE_HZ * (2000 + i)) / RATE_HZ);
      const b = 30 * Math.sin((2 * Math.PI * 8 * i) / RATE_HZ);
      expect(value).toBeCloseTo(a - b, 3);
    });
  });

  test("the pyramid path fetches less than a tenth of the raw bytes", async () => {
    const inner = await openBundle(BUNDLE);
    let bytes = 0;
    const counted = (result: Uint8Array | undefined) => {
      bytes += result?.length ?? 0;
      return result;
    };
    const store: Store = {
      get: (key, opts) => inner.get(key, opts).then(counted),
      getRange: (key, range, opts) =>
        inner.getRange(key, range, opts).then(counted),
    };
    const client = new StreamingClient({ store });
    // The incompressible channel: compression hides the sample-count ratio on
    // the sines.
    const info = continuousById(await client.channelInfo(), "noise");
    const window = { startUs: info.startUs, endUs: info.endUs };

    bytes = 0;
    await collect(
      client.query({ channels: [info.id], ...window, pixelWidthUs: 64_000 }),
    );
    const pyramidBytes = bytes;

    bytes = 0;
    await collect(
      client.query({
        channels: [info.id],
        ...window,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );
    const rawBytes = bytes;

    expect(pyramidBytes * 10).toBeLessThan(rawBytes);
  });

  test("data spans come from the coarsest level's count", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    // The coarsest level has 64 ms bins and its last bin runs 16 ms past the data,
    // so the span ends at the channel's end however far the window reaches.
    expect(
      await client.dataSpans({
        channel: "sineB",
        startUs: 0,
        endUs: 40_000_000,
      }),
    ).toEqual([[2_000_000, 32_000_000]]);
    expect(
      await client.dataSpans({
        channel: "sineB",
        startUs: 0,
        endUs: 32_000_000,
      }),
    ).toEqual([[2_000_000, 32_000_000]]);
  });

  test("reads a sorted-units channel: events, labels, mean waveforms, and counts", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = eventById(await client.channelInfo(), "unitA");
    expect(info.eventCount).toBe(SPIKE_COUNT);
    expect(info.columns).toEqual(["labels"]);
    expect(info.labelNames).toEqual(["u0", "u1", "u2"]);
    expect(info.hasWaveformMean).toBe(true);
    expect(info.countLevels).toBeGreaterThanOrEqual(3);
    expect(info.provenance).toEqual({ software: "generate-test-bundle.py" });

    const window = { startUs: 1_000_000, endUs: 2_000_000 };
    const expectedIndices = [7, 8, 9, 10, 11, 12, 13];
    const events = await collectOne(
      client.queryEvents({ channels: ["unitA"], ...window }),
    );
    expect(Array.from(events.times)).toEqual(
      expectedIndices.map((i) => (i + 1) * SPIKE_STEP_US),
    );
    expect(Array.from(events.labels!)).toEqual(
      expectedIndices.map((i) => i % 3),
    );
    expect(events.waveforms).toBeUndefined();

    const mean = await client.waveformMean({ channel: "unitA" });
    expect(mean?.pointsPerEvent).toBe(32);
    expect(mean?.periodUs).toBeCloseTo(1e6 / 30_000, 9);
    expect(mean?.data.length).toBe(3 * 32);
    // Row j of the mean is j, j + 1, ..., j + 31.
    expect(Array.from(mean!.data.slice(32, 64))).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 1),
    );

    // Count level 1 has 256 ms bins. Expected counts follow from the spike arithmetic.
    const counts = await client.eventCounts({
      channel: "unitA",
      startUs: 0,
      endUs: 2_560_000,
      pixelWidthUs: 256_000,
    });
    expect(counts.level).toBe(1);
    expect(counts.periodUs).toBe(256_000);
    expect(counts.startUs).toBe(0);
    expect(counts.labelCount).toBe(3);
    const expected = new Uint32Array(10 * 3);
    for (let i = 0; i < SPIKE_COUNT; i++) {
      const bin = Math.floor(((i + 1) * SPIKE_STEP_US) / 256_000);
      if (bin >= 10) break;
      expected[bin * 3 + (i % 3)]! += 1;
    }
    expect(Array.from(counts.counts)).toEqual(Array.from(expected));

    // A coarser level sums its children exactly.
    const coarse = await client.eventCounts({
      channel: "unitA",
      startUs: 0,
      endUs: 2_560_000,
      pixelWidthUs: 1_024_000,
    });
    expect(coarse.level).toBe(2);
    expect(coarse.counts.length).toBe(3 * 3);
    for (let label = 0; label < 3; label++) {
      let fine = 0;
      for (let bin = 0; bin < 4; bin++) fine += expected[bin * 3 + label]!;
      expect(coarse.counts[label]).toBe(fine);
    }
  });

  test("reads clinical marks: open intervals, text, and channel scope", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = eventById(await client.channelInfo(), "marks");
    expect(info.columns).toEqual(["durations", "labels", "text", "channels"]);
    expect(info.maxDurationUs).toBe(90_000_000);

    // The seizure runs 10 s to 100 s. A window at 50 s holds it and nothing else.
    const during = await collectOne(
      client.queryEvents({
        channels: ["marks"],
        startUs: 50_000_000,
        endUs: 60_000_000,
      }),
    );
    expect(Array.from(during.times)).toEqual([10_000_000]);
    expect(Array.from(during.durations!)).toEqual([90_000_000]);
    expect(during.text).toEqual(["seizure"]);
    expect(during.channels).toEqual([["sineA"]]);

    const early = await collectOne(
      client.queryEvents({
        channels: ["marks"],
        startUs: 11_000_000,
        endUs: 26_000_000,
      }),
    );
    expect(Array.from(early.times)).toEqual([
      10_000_000, 12_000_000, 15_500_000, 20_000_000, 25_000_000,
    ]);
    expect(Array.from(early.labels!)).toEqual([0, 1, 1, 2, 1]);
    expect(early.text).toEqual([
      "seizure",
      "spike",
      "spike",
      "note: reviewed",
      "spike",
    ]);
    expect(early.channels).toEqual([
      ["sineA"],
      ["sineA"],
      ["sineB"],
      [],
      ["sineA", "sineB"],
    ]);
  });

  test("reads a paused channel: one raw segment per run at the table's times", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = continuousById(await client.channelInfo(), "pausedA");
    expect([info.runs, info.startUs, info.endUs]).toEqual([2, 0, 22_000_400]);

    // The second run resumed 0.4 ms past grid sample 12,000, which the grid cannot
    // say and the table does.
    const runs = await client.runs({ channel: "pausedA" });
    expect(runs).toEqual([
      { firstSample: 0, sampleCount: 10_000, startUs: 0, endUs: 10_000_000 },
      {
        firstSample: 12_000,
        sampleCount: 10_000,
        startUs: 12_000_400,
        endUs: 22_000_400,
      },
    ]);

    const whole = await collect(
      client.query({
        channels: ["pausedA"],
        startUs: info.startUs,
        endUs: info.endUs,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );
    expect(whole.map((segment) => segment.startUs)).toEqual(
      runs.map((run) => run.startUs),
    );
    expect(whole.map((segment) => segment.data.length)).toEqual(
      runs.map((run) => run.sampleCount),
    );
    expect(whole.every((segment) => segment.data.every(Number.isFinite))).toBe(
      true,
    );

    // A window across the pause holds the last sample of the first run and the first
    // two of the second. The pause adds no samples.
    const across = await collect(
      client.query({
        channels: ["pausedA"],
        startUs: 9_999_000,
        endUs: 12_002_000,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );
    expect(
      across.map((segment) => [segment.startUs, segment.data.length]),
    ).toEqual([
      [9_999_000, 1],
      [12_000_400, 2],
    ]);

    // The coarsest level has 64 ms bins on the grid. A level read stays one segment, and
    // the pause empties the bins inside it. The two bins straddling its edges keep the
    // samples they recorded.
    const level = await collectOne(
      client.query({
        channels: ["pausedA"],
        startUs: 0,
        endUs: 22_000_000,
        pixelWidthUs: 64_000,
      }),
    );
    expect([level.isMinMax, level.startUs]).toEqual([true, 0]);
    expect(
      await client.dataSpans({
        channel: "pausedA",
        startUs: 0,
        endUs: 22_000_400,
      }),
    ).toEqual([
      [0, 10_048_000],
      [11_968_000, 22_000_400],
    ]);
  });

  test("the filter path equals the filter module applied to the raw read", async () => {
    const spec = { type: "lowpass", order: 4, cutoffHz: 40 } as const;
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = continuousById(await client.channelInfo(), "sineA");
    const window = {
      startUs: info.startUs,
      endUs: info.startUs + 10_000_000,
    };

    const raw = await collectOne(
      client.query({
        channels: [info.id],
        ...window,
        pixelWidthUs: 1000,
        raw: true,
      }),
    );
    const filtered = await collectOne(
      client.query({
        channels: [info.id],
        ...window,
        pixelWidthUs: 1000,
        raw: true,
        filter: spec,
      }),
    );

    const expected = createFilter(spec, info.rateHz).process(raw.data);
    expect(Array.from(filtered.data)).toEqual(Array.from(expected));
  });
});

describe("channels at 30000 Hz from an epoch-scale offset", () => {
  const EPOCH_US = 1_790_000_000_000_000;
  const COUNT = 100;
  const ramp = Array.from({ length: COUNT }, (_, i) => i);
  // Bins 2 and 3 of the 4-sample level hold no finite sample.
  const gapped = pairsOf(ramp, 4).map((value, i) =>
    i >= 4 && i < 8 ? NaN : value,
  );

  const client = new StreamingClient({
    store: createMemoryStore(
      bundleFiles([
        { index: 0, tsz: tsz("p", "P", 30_000, EPOCH_US), raw: ramp },
        {
          index: 1,
          tsz: tsz("q", "Q", 30_000, EPOCH_US + 100),
          raw: ramp.map((value) => value * 2),
        },
        {
          index: 2,
          tsz: tsz("r", "R", 30_000, EPOCH_US + 34),
          raw: ramp,
        },
        {
          index: 3,
          tsz: tsz("s", "S", 30_000, EPOCH_US),
          raw: ramp,
          levels: [{ periodUs: (4 * 1e6) / 30_000, pairs: gapped }],
        },
      ]),
    ),
  });

  test("reports a channel end rounded up to a whole microsecond", async () => {
    const info = continuousById(await client.channelInfo(), "p");
    expect(info.startUs).toBe(EPOCH_US);
    expect(info.endUs).toBe(EPOCH_US + 3334);
  });

  test("starts a read on the sample whose grid time is the window start", async () => {
    const segment = await collectOne(
      client.query({
        channels: ["p"],
        startUs: EPOCH_US + 100,
        endUs: EPOCH_US + 200,
        pixelWidthUs: 1e6 / 30_000,
        raw: true,
      }),
    );
    expect(segment.startUs).toBe(EPOCH_US + 100);
    expect(Array.from(segment.data)).toEqual([3, 4, 5]);
  });

  test("starts a read at the grid time of its first sample", async () => {
    const segment = await collectOne(
      client.query({
        channels: ["p"],
        startUs: EPOCH_US + 99,
        endUs: EPOCH_US + 134,
        pixelWidthUs: 1e6 / 30_000,
        raw: true,
      }),
    );
    expect(segment.startUs).toBe(EPOCH_US + (2 * 1e6) / 30_000);
    expect(Array.from(segment.data)).toEqual([2, 3, 4]);
  });

  test("aligns a pair whose starts differ by a whole number of samples", async () => {
    const segment = await collectOne(
      client.query({
        startUs: EPOCH_US,
        endUs: EPOCH_US + 3334,
        pixelWidthUs: 1e6 / 30_000,
        montage: [{ lead: "p", secondary: "q" }],
      }),
    );
    expect(segment.startUs).toBe(EPOCH_US + 100);
    expect(segment.data).toHaveLength(COUNT - 3);
    expect(segment.data[0]).toBe(3);
    expect(segment.data[1]).toBe(2);
  });

  test("rejects a pair whose starts are not a whole number of samples apart", async () => {
    await expect(
      collect(
        client.query({
          startUs: EPOCH_US,
          endUs: EPOCH_US + 3334,
          pixelWidthUs: 1e6 / 30_000,
          montage: [{ lead: "p", secondary: "r" }],
        }),
      ),
    ).rejects.toThrow(/cannot be aligned/);
  });

  test("rounds data spans outward to whole microseconds inside the channel", async () => {
    expect(
      await client.dataSpans({
        channel: "s",
        startUs: EPOCH_US - 1000,
        endUs: EPOCH_US + 10_000,
      }),
    ).toEqual([
      [EPOCH_US, EPOCH_US + 267],
      [EPOCH_US + 533, EPOCH_US + 3334],
    ]);
  });

  test("clamps data spans to the window", async () => {
    expect(
      await client.dataSpans({
        channel: "s",
        startUs: EPOCH_US + 600,
        endUs: EPOCH_US + 700,
      }),
    ).toEqual([[EPOCH_US + 600, EPOCH_US + 700]]);
  });
});
