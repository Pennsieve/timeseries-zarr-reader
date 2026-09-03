import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createFilter } from "./filter.js";
import type { BundleChannel } from "./test-utils.js";
import {
  bundleFiles,
  collect,
  createCountingStore,
  createMemoryStore,
} from "./test-utils.js";
import type { ChannelInfo, Store, StoreOptions } from "./types.js";
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

function channelById(infos: readonly ChannelInfo[], id: string): ChannelInfo {
  const info = infos.find((candidate) => candidate.id === id);
  if (!info) {
    throw new Error(`bundle has no channel ${id}`);
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

const attrs = (
  id: string,
  name: string,
  rateHz: number,
  kind = "continuous",
) => ({
  id,
  name,
  unit: "uV",
  rate_hz: rateHz,
  start_us: 1_000_000,
  kind,
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

const CHANNELS: BundleChannel[] = [
  {
    path: "0",
    attributes: attrs("a", "A", 1000),
    levels: [
      { periodUs: 1000, samples: RAW_A },
      { periodUs: 4000, pairs: pairsOf(RAW_A, 4) },
    ],
  },
  {
    path: "1",
    attributes: attrs("b", "B", 1000),
    levels: [
      { periodUs: 1000, samples: RAW_B },
      { periodUs: 4000, pairs: pairsOf(RAW_B, 4) },
    ],
  },
  {
    path: "2",
    attributes: attrs("c", "C", 500),
    levels: [{ periodUs: 2000, samples: new Array<number>(16).fill(0) }],
  },
  {
    path: "3",
    attributes: attrs("r", "R", 1000),
    levels: [{ periodUs: 1000, samples: [0, 10, 2, 8, 5, 5, 5, 5] }],
  },
  {
    path: "4",
    attributes: attrs("g", "G", 1000),
    levels: [
      { periodUs: 1000, samples: new Array<number>(32).fill(0) },
      {
        periodUs: 4000,
        pairs: [1, 2, NaN, NaN, 3, 4, 5, 6, NaN, NaN, NaN, NaN, 7, 8, 9, 10],
      },
    ],
  },
  {
    path: "5",
    attributes: attrs("u", "U", 10_000, "unit"),
    events: [1_002_000, 1_005_000, 1_005_500, 1_009_000],
    waveforms: {
      periodUs: 100,
      pointsPerEvent: 3,
      samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    },
  },
  {
    // Same rate and grid as "a", but starting two samples later.
    path: "6",
    attributes: { ...attrs("d", "D", 1000), start_us: 1_002_000 },
    levels: [
      {
        periodUs: 1000,
        samples: Array.from({ length: 30 }, (_, i) => i + 200),
      },
    ],
  },
  {
    // Same rate as "a", offset half a period: no shared grid exists.
    path: "7",
    attributes: { ...attrs("m", "M", 1000), start_us: 1_000_500 },
    levels: [{ periodUs: 1000, samples: [0, 0, 0, 0, 0, 0, 0, 0] }],
  },
  {
    // 512 Hz from an epoch start: period_us is 1953.125, and startUs arithmetic
    // rounds. No drift lands on an exact period.
    path: "8",
    attributes: { ...attrs("f", "F", 512), start_us: 1_704_067_200_000_000 },
    levels: [{ periodUs: 1e6 / 512, samples: FRACTIONAL }],
  },
];

const makeClient = (maxRawBytes?: number) =>
  new StreamingClient({
    store: createMemoryStore(bundleFiles(CHANNELS)),
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
    ]);
    expect(rootReads).toBe(1);
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
    expect((await client.channelInfo()).length).toBe(9);
  });

  test("channelInfo returns a fresh copy per call", async () => {
    const client = makeClient();
    const first = channelById(await client.channelInfo(), "a");
    const second = channelById(await client.channelInfo(), "a");
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
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

  test("rejects a unit channel", async () => {
    const client = makeClient();
    await expect(
      collect(client.query({ channels: ["u"], ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(/unit channel/);
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
      "/0/0/c/0",
    );
    const client = new StreamingClient({ store });

    await expect(
      collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 })),
    ).rejects.toThrow(/read of \/0\/0\/c\/0 failed/);
  });

  test("produces no unhandled rejection when iteration stops early", async () => {
    // The second trace's read fails after the generator is dropped. An unhandled
    // rejection would fail the run.
    const store = withFailingKey(
      createMemoryStore(bundleFiles(CHANNELS)),
      "/1/0/c/0",
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
    const info = channelById(await client.channelInfo(), "f");
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
      withFailingKey(createMemoryStore(bundleFiles(CHANNELS)), "/1/0/c/0"),
      new Set(["/2/0/c/0"]),
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
    ).rejects.toThrow("read of /1/0/c/0 failed");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = held.signals.get("/2/0/c/0");
    expect(pending?.aborted).toBe(true);
  });

  test("cancels the remaining reads when the consumer stops iterating", async () => {
    const held = withHeldKeys(
      createMemoryStore(bundleFiles(CHANNELS)),
      new Set(["/1/0/c/0", "/2/0/c/0"]),
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
      new Set(["/2/0/c/0"]),
    );
    const client = new StreamingClient({ store: held.store });
    const iterator = client
      .query({ channels: ["a", "c"], ...FULL, pixelWidthUs: 1000 })
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(held.signals.get("/2/0/c/0")?.aborted).toBe(false);
    await iterator.return(undefined);
  });
});

describe("chunked levels", () => {
  const chunked: BundleChannel[] = [
    {
      path: "0",
      attributes: attrs("k", "K", 1000),
      levels: [
        { periodUs: 1000, samples: RAW_A, chunkLength: 8 },
        { periodUs: 4000, pairs: pairsOf(RAW_A, 4), chunkLength: 3 },
      ],
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

describe("queryUnits", () => {
  test("reads events without waveforms when zoomed out", async () => {
    const client = makeClient();
    const event = await collectOne(
      client.queryUnits({
        channels: ["u"],
        startUs: 1_003_000,
        endUs: 1_009_000,
        pixelWidthUs: 1000,
      }),
    );

    expect(event.channel).toBe("u");
    expect(Array.from(event.times)).toEqual([1_005_000, 1_005_500]);
    expect(event.pointsPerEvent).toBe(0);
    expect(event.data.length).toBe(0);
  });

  test("reads waveforms when zoomed in", async () => {
    const client = makeClient();
    const event = await collectOne(
      client.queryUnits({
        channels: ["u"],
        startUs: 1_003_000,
        endUs: 1_009_000,
        pixelWidthUs: 20,
      }),
    );

    expect(event.pointsPerEvent).toBe(3);
    expect(Array.from(event.data)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  test("rejects a continuous channel", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryUnits({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
      ),
    ).rejects.toThrow(/not a unit channel/);
  });

  test("rejects an unknown channel id", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryUnits({ channels: ["nope"], ...FULL, pixelWidthUs: 1000 }),
      ),
    ).rejects.toThrow(/no channel with id nope/);
  });

  test("rejects a pixel width that is not positive", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryUnits({
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
        client.queryUnits({
          channels: ["u"],
          ...FULL,
          pixelWidthUs: 1000,
          signal: AbortSignal.abort(),
        }),
      ),
    ).rejects.toThrow(/abort/i);
  });

  test("rejects a window that ends before it starts", async () => {
    const client = makeClient();
    await expect(
      collect(
        client.queryUnits({
          channels: ["u"],
          startUs: 1_010_000,
          endUs: 1_005_000,
          pixelWidthUs: 1000,
        }),
      ),
    ).rejects.toThrow(RangeError);
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

  test("rejects a unit channel", async () => {
    const client = makeClient();
    await expect(client.dataSpans({ channel: "u", ...FULL })).rejects.toThrow(
      /unit channel/,
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
    const many: BundleChannel[] = Array.from({ length: count }, (_, i) => ({
      path: String(i),
      attributes: attrs(`ch${i}`, `Channel ${i}`, 1000),
      levels: [
        { periodUs: 1000, samples: Array.from({ length: 8 }, (_, j) => i + j) },
      ],
    }));
    const tracked = trackConcurrency(createMemoryStore(bundleFiles(many)));
    const client = new StreamingClient({
      store: tracked.store,
      maxCacheBytes: 0,
    });

    const segments = await collect(
      client.query({
        channels: many.map((channel) => channel.attributes.id as string),
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

describe("acceptance: committed bundle", () => {
  test("raw samples match the generating sine", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = channelById(await client.channelInfo(), "sineA");

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
    const info = channelById(await client.channelInfo(), "sineA");
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
    expect(Array.from(pyramid.data)).toEqual(expected);
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
    const info = channelById(await client.channelInfo(), "noise");
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

  test("reads a real unit channel's events and waveforms", async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const infos = await client.channelInfo();
    const unitInfo = infos.find((info) => info.kind === "unit");
    if (!unitInfo) {
      throw new Error("bundle has no unit channel");
    }
    expect(unitInfo.endUs).toBe(unitInfo.startUs);

    const window = {
      startUs: unitInfo.startUs + 1_000_000,
      endUs: unitInfo.startUs + 2_000_000,
    };
    const expectedTimes = [8, 9, 10, 11, 12, 13, 14].map(
      (n) => unitInfo.startUs + n * 137_000,
    );

    // Zoomed out: events only.
    const marks = await collectOne(
      client.queryUnits({
        channels: [unitInfo.id],
        ...window,
        pixelWidthUs: 1000,
      }),
    );
    expect(Array.from(marks.times)).toEqual(expectedTimes);
    expect(marks.pointsPerEvent).toBe(0);
    expect(marks.data.length).toBe(0);

    // Zoomed in: a 32-point waveform at 30 kHz spans ~1067 us, > 10 pixels of 50 us.
    const shapes = await collectOne(
      client.queryUnits({
        channels: [unitInfo.id],
        ...window,
        pixelWidthUs: 50,
      }),
    );
    expect(shapes.pointsPerEvent).toBe(32);
    expect(shapes.samplePeriodUs).toBeCloseTo(1e6 / 30_000, 9);
    expect(shapes.data.length).toBe(7 * 32);
    // The first fetched row is event index 7, whose ramp starts at 7.
    expect(Array.from(shapes.data.slice(0, 32))).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 7),
    );
  });

  test("the filter path equals the filter module applied to the raw read", async () => {
    const spec = { type: "lowpass", order: 4, cutoffHz: 40 } as const;
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    const info = channelById(await client.channelInfo(), "sineA");
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
