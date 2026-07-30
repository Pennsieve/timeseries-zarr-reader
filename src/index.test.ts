import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { makeFilter } from "./filter.js";
import type { BundleChannel } from "./test-utils.js";
import { bundleFiles, createMemoryStore } from "./test-utils.js";
import type { Store } from "./types.js";
import {
  FetchStore,
  FilterWindowTooWide,
  openBundle,
  StreamingClient,
} from "./index.js";

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
};

/** Interleaved [min, max] per disjoint block, the pyramid's own reduction. */
const pairsOf = (samples: number[], block: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += block) {
    const values = samples.slice(i, i + block);
    out.push(Math.min(...values), Math.max(...values));
  }
  return out;
};

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
    // Same rate as "a", but sampling half a period later: no shared grid exists.
    path: "7",
    attributes: { ...attrs("m", "M", 1000), start_us: 1_000_500 },
    levels: [{ periodUs: 1000, samples: [0, 0, 0, 0, 0, 0, 0, 0] }],
  },
];

const makeClient = (filterMaxBytes?: number) =>
  new StreamingClient({
    store: createMemoryStore(bundleFiles(CHANNELS)),
    ...(filterMaxBytes === undefined ? {} : { filterMaxBytes }),
  });

const FULL = { startUs: 1_000_000, endUs: 1_032_000 };
const LOWPASS = { type: "lowpass", order: 4, cutoffHz: 100 } as const;

test("channelInfo lists every channel from one catalog read", async () => {
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
  ]);
  expect(rootReads).toBe(1);
});

test("retries the catalog after a transient failure instead of caching it", async () => {
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
  expect((await client.channelInfo()).length).toBe(8);
});

test("channelInfo returns copies, so a caller cannot corrupt the catalog", async () => {
  const client = makeClient();
  const [first] = await client.channelInfo();
  if (first) {
    first.name = "mutated";
  }
  const [second] = await client.channelInfo();
  expect(second?.name).toBe("A");
});

test("reads raw samples exactly as stored at raw zoom", async () => {
  const client = makeClient();
  const segments = await collect(
    client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
  );

  expect(segments).toHaveLength(1);
  const segment = segments[0];
  expect(segment?.channel).toBe("a");
  expect(segment?.startUs).toBe(1_000_000);
  expect(segment?.samplePeriodUs).toBe(1000);
  expect(segment?.isMinMax).toBe(false);
  expect(Array.from(segment?.data ?? [])).toEqual(RAW_A);
});

test("trims the read to the window at bin granularity", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      startUs: 1_005_500,
      endUs: 1_008_500,
      pixelWidthUs: 1000,
    }),
  );

  expect(segment?.startUs).toBe(1_005_000);
  expect(Array.from(segment?.data ?? [])).toEqual([5, 6, 7, 8]);
});

test("selects a pyramid level and resamples it onto the pixel grid", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({ channels: ["a"], ...FULL, pixelWidthUs: 16_000 }),
  );

  expect(segment?.isMinMax).toBe(true);
  expect(segment?.samplePeriodUs).toBe(16_000);
  expect(Array.from(segment?.data ?? [])).toEqual([0, 15, 16, 31]);
});

test("delivers a level as fetched when it already sits at pixel resolution", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({ channels: ["a"], ...FULL, pixelWidthUs: 4000 }),
  );

  expect(segment?.isMinMax).toBe(true);
  expect(segment?.samplePeriodUs).toBe(4000);
  expect(Array.from(segment?.data ?? [])).toEqual(pairsOf(RAW_A, 4));
});

test("does not resample when one pixel spans exactly the threshold ratio", async () => {
  // 12000 us pixels over 4000 us bins: exactly 3 bins per pixel, not more.
  const client = makeClient();
  const [segment] = await collect(
    client.query({ channels: ["a"], ...FULL, pixelWidthUs: 12_000 }),
  );

  expect(segment?.samplePeriodUs).toBe(4000);
  expect(Array.from(segment?.data ?? [])).toEqual(pairsOf(RAW_A, 4));
});

test("keeps samples raw at a coarse pixel width when minMax is false", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      ...FULL,
      pixelWidthUs: 8000,
      minMax: false,
    }),
  );

  expect(segment?.isMinMax).toBe(false);
  expect(segment?.samplePeriodUs).toBe(1000);
  expect(Array.from(segment?.data ?? [])).toEqual(RAW_A);
});

test("resamples raw data when no coarser level exists", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["r"],
      startUs: 1_000_000,
      endUs: 1_008_000,
      pixelWidthUs: 4000,
    }),
  );

  expect(segment?.isMinMax).toBe(true);
  expect(Array.from(segment?.data ?? [])).toEqual([0, 10, 5, 5]);
});

test("yields one segment per channel, in request order", async () => {
  const client = makeClient();
  const segments = await collect(
    client.query({ channels: ["b", "a"], ...FULL, pixelWidthUs: 1000 }),
  );
  expect(segments.map((segment) => segment.channel)).toEqual(["b", "a"]);
});

test("yields empty data for a window past the channel's end", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      startUs: 2_000_000,
      endUs: 2_032_000,
      pixelWidthUs: 1000,
    }),
  );
  expect(segment?.data.length).toBe(0);
});

test("subtracts a montage pair on raw data under the compound key", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: [],
      ...FULL,
      pixelWidthUs: 1000,
      montage: [{ lead: "a", secondary: "b" }],
    }),
  );

  expect(segment?.channel).toBe("a_A<->B");
  expect(segment?.startUs).toBe(1_000_000);
  expect(segment?.isMinMax).toBe(false);
  expect(Array.from(segment?.data ?? [])).toEqual(
    new Array<number>(32).fill(-100),
  );
});

test("resamples a montaged trace like any other", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: [],
      ...FULL,
      pixelWidthUs: 8000,
      montage: [{ lead: "a", secondary: "b" }],
    }),
  );

  expect(segment?.isMinMax).toBe(true);
  expect(Array.from(segment?.data ?? [])).toEqual(
    new Array<number>(8).fill(-100),
  );
});

test("aligns a montage pair whose starts differ by whole periods", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: [],
      ...FULL,
      pixelWidthUs: 1000,
      montage: [{ lead: "a", secondary: "d" }],
    }),
  );

  // Only the overlap of the two extents is read: a[2..32] minus d[0..30].
  expect(segment?.startUs).toBe(1_002_000);
  expect(Array.from(segment?.data ?? [])).toEqual(
    new Array<number>(30).fill(-198),
  );
});

test("montages a channel with itself to a flat zero trace", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: [],
      ...FULL,
      pixelWidthUs: 1000,
      montage: [{ lead: "a", secondary: "a" }],
    }),
  );

  expect(segment?.channel).toBe("a_A<->A");
  expect(Array.from(segment?.data ?? [])).toEqual(
    new Array<number>(32).fill(0),
  );
});

test("rejects a montage pair whose sample grids cannot be aligned", async () => {
  const client = makeClient();
  await expect(
    collect(
      client.query({
        channels: [],
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "m" }],
      }),
    ),
  ).rejects.toThrow(/different instants/);
});

test("rejects a montage pair whose rates differ", async () => {
  const client = makeClient();
  await expect(
    collect(
      client.query({
        channels: [],
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "c" }],
      }),
    ),
  ).rejects.toThrow(/mixes rates/);
});

test("filters a trace exactly as the filter module would", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      ...FULL,
      pixelWidthUs: 1000,
      minMax: false,
      filter: LOWPASS,
    }),
  );

  const expected = makeFilter(LOWPASS, 1000).process(Float64Array.from(RAW_A));
  expect(Array.from(segment?.data ?? [])).toEqual(Array.from(expected));
});

test("resamples a filtered trace onto the pixel grid", async () => {
  const client = makeClient();
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      ...FULL,
      pixelWidthUs: 8000,
      filter: LOWPASS,
    }),
  );

  const filtered = makeFilter(LOWPASS, 1000).process(Float64Array.from(RAW_A));
  expect(segment?.isMinMax).toBe(true);
  expect(segment?.samplePeriodUs).toBe(8000);
  expect(Array.from(segment?.data ?? [])).toEqual(
    pairsOf(Array.from(filtered), 8),
  );
});

test("carries filter state across consecutive queries and resets on a jump back", async () => {
  const client = makeClient();
  const halves = [
    { startUs: 1_000_000, endUs: 1_016_000 },
    { startUs: 1_016_000, endUs: 1_032_000 },
  ];
  const chunked: number[] = [];
  for (const half of halves) {
    const [segment] = await collect(
      client.query({
        channels: ["a"],
        ...half,
        pixelWidthUs: 1000,
        minMax: false,
        filter: LOWPASS,
      }),
    );
    chunked.push(...Array.from(segment?.data ?? []));
  }

  // The jump back to the start resets the state, so the whole window filters fresh.
  const [whole] = await collect(
    client.query({
      channels: ["a"],
      ...FULL,
      pixelWidthUs: 1000,
      minMax: false,
      filter: LOWPASS,
    }),
  );

  expect(chunked).toEqual(Array.from(whole?.data ?? []));
});

test("refuses a forced-raw read past the byte cap before fetching anything", async () => {
  const client = makeClient(64);
  const failure = await collect(
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

  expect(failure).toBeInstanceOf(FilterWindowTooWide);
  const tooWide = failure as FilterWindowTooWide;
  expect(tooWide.requestedBytes).toBe(128);
  expect(tooWide.maxBytes).toBe(64);
  expect(tooWide.name).toBe("FilterWindowTooWide");
});

test("counts both sides of a montage against the cap", async () => {
  const client = makeClient(200);
  await expect(
    collect(
      client.query({
        channels: [],
        ...FULL,
        pixelWidthUs: 1000,
        montage: [{ lead: "a", secondary: "b" }],
      }),
    ),
  ).rejects.toThrow(FilterWindowTooWide);
});

test("applies the cap to minMax: false, which also forces a raw read", async () => {
  const client = makeClient(64);
  await expect(
    collect(
      client.query({
        channels: ["a"],
        ...FULL,
        pixelWidthUs: 1000,
        minMax: false,
      }),
    ),
  ).rejects.toThrow(FilterWindowTooWide);
});

test("honours a per-query cap override", async () => {
  const client = makeClient(64);
  const [segment] = await collect(
    client.query({
      channels: ["a"],
      ...FULL,
      pixelWidthUs: 1000,
      minMax: false,
      filterMaxBytes: 128,
    }),
  );
  expect(segment?.data.length).toBe(32);
});

test("rejects an unknown channel id, naming it", async () => {
  const client = makeClient();
  await expect(
    collect(client.query({ channels: ["nope"], ...FULL, pixelWidthUs: 1000 })),
  ).rejects.toThrow(/no channel with id nope/);
});

test("rejects a unit channel in a continuous query", async () => {
  const client = makeClient();
  await expect(
    collect(client.query({ channels: ["u"], ...FULL, pixelWidthUs: 1000 })),
  ).rejects.toThrow(/unit channel/);
});

test("rejects a pixel width that is not above zero", async () => {
  const client = makeClient();
  await expect(
    collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 0 })),
  ).rejects.toThrow(RangeError);
  await expect(
    collect(
      client.queryUnits({ channels: ["u"], ...FULL, pixelWidthUs: Number.NaN }),
    ),
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

test("surfaces a failed read with its cause", async () => {
  const files = bundleFiles(CHANNELS);
  delete files["/0/0/zarr.json"];
  const client = new StreamingClient({ store: createMemoryStore(files) });

  await expect(
    collect(client.query({ channels: ["a"], ...FULL, pixelWidthUs: 1000 })),
  ).rejects.toThrow(/no array at \/0\/0/);
});

test("leaves no rejection unhandled when the consumer abandons the query", async () => {
  // The second trace's read fails after the generator has been dropped; a run with an
  // unhandled rejection fails the suite, so finishing cleanly is the assertion.
  const files = bundleFiles(CHANNELS);
  delete files["/1/0/zarr.json"];
  const client = new StreamingClient({ store: createMemoryStore(files) });

  const iterator = client
    .query({
      channels: ["a", "b"],
      ...FULL,
      pixelWidthUs: 1000,
      minMax: false,
    })
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  await iterator.return?.(undefined);

  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("reads unit events without waveforms when zoomed out", async () => {
  const client = makeClient();
  const [event] = await collect(
    client.queryUnits({
      channels: ["u"],
      startUs: 1_003_000,
      endUs: 1_009_000,
      pixelWidthUs: 1000,
    }),
  );

  expect(event?.channel).toBe("u");
  expect(Array.from(event?.times ?? [])).toEqual([1_005_000, 1_005_500]);
  expect(event?.pointsPerEvent).toBe(0);
  expect(event?.data.length).toBe(0);
});

test("reads unit waveforms when zoomed in", async () => {
  const client = makeClient();
  const [event] = await collect(
    client.queryUnits({
      channels: ["u"],
      startUs: 1_003_000,
      endUs: 1_009_000,
      pixelWidthUs: 20,
    }),
  );

  expect(event?.pointsPerEvent).toBe(3);
  expect(Array.from(event?.data ?? [])).toEqual([4, 5, 6, 7, 8, 9]);
});

test("rejects a continuous channel in a unit query", async () => {
  const client = makeClient();
  await expect(
    collect(
      client.queryUnits({ channels: ["a"], ...FULL, pixelWidthUs: 1000 }),
    ),
  ).rejects.toThrow(/not a unit channel/);
});

test("rejects an unknown channel id in a unit query", async () => {
  const client = makeClient();
  await expect(
    collect(
      client.queryUnits({ channels: ["nope"], ...FULL, pixelWidthUs: 1000 }),
    ),
  ).rejects.toThrow(/no channel with id nope/);
});

test("reports data-availability spans from the coarsest level", async () => {
  const client = makeClient();
  expect(await client.getSegmentSpans({ channel: "g", ...FULL })).toEqual([
    [1_000_000, 1_004_000],
    [1_008_000, 1_016_000],
    [1_024_000, 1_032_000],
  ]);
});

test("bridges gaps no wider than the threshold", async () => {
  const client = makeClient();
  expect(
    await client.getSegmentSpans({
      channel: "g",
      ...FULL,
      gapThresholdUs: 4000,
    }),
  ).toEqual([
    [1_000_000, 1_016_000],
    [1_024_000, 1_032_000],
  ]);
  expect(
    await client.getSegmentSpans({
      channel: "g",
      ...FULL,
      gapThresholdUs: 8000,
    }),
  ).toEqual([[1_000_000, 1_032_000]]);
});

test("clamps span edges to the window", async () => {
  const client = makeClient();
  expect(
    await client.getSegmentSpans({
      channel: "g",
      startUs: 1_002_000,
      endUs: 1_006_000,
    }),
  ).toEqual([[1_002_000, 1_004_000]]);
});

test("reports no spans for a window with no data", async () => {
  const client = makeClient();
  expect(
    await client.getSegmentSpans({
      channel: "g",
      startUs: 1_004_000,
      endUs: 1_008_000,
    }),
  ).toEqual([]);
});

test("reads spans from a raw-only channel", async () => {
  const client = makeClient();
  expect(
    await client.getSegmentSpans({
      channel: "r",
      startUs: 1_000_000,
      endUs: 1_008_000,
    }),
  ).toEqual([[1_000_000, 1_008_000]]);
});

test("rejects spans for a unit channel", async () => {
  const client = makeClient();
  await expect(
    client.getSegmentSpans({ channel: "u", ...FULL }),
  ).rejects.toThrow(/unit channel/);
});

test("re-exports the HTTP store the reader picks for http locations", async () => {
  expect(await openBundle("http://localhost:9090/sample.zarr")).toBeInstanceOf(
    FetchStore,
  );
});

// --- Acceptance against the committed bundle (test-data/sample.zarr, produced by the
// real writer via scripts/generate-test-bundle.py; content documented there) ---

const BUNDLE = fileURLToPath(
  new URL("../test-data/sample.zarr", import.meta.url),
);
const SINE_HZ = 5;
const AMPLITUDE = 50;
const RATE_HZ = 1000;

const channelById = (infos: { id: string }[], id: string) => {
  const info = infos.find((candidate) => candidate.id === id);
  if (!info) throw new Error(`bundle has no channel ${id}`);
  return info as Awaited<ReturnType<StreamingClient["channelInfo"]>>[number];
};

test("acceptance: raw samples match the generating sine", async () => {
  const client = new StreamingClient({ store: await openBundle(BUNDLE) });
  const info = channelById(await client.channelInfo(), "sineA");

  const [segment] = await collect(
    client.query({
      channels: [info.id],
      startUs: info.startUs,
      endUs: info.startUs + 100_000,
      pixelWidthUs: 1000,
      minMax: false,
    }),
  );

  expect(segment?.data.length).toBe(100);
  Array.from(segment?.data ?? []).forEach((value, i) => {
    expect(value).toBeCloseTo(
      AMPLITUDE * Math.sin((2 * Math.PI * SINE_HZ * i) / RATE_HZ),
      3,
    );
  });
});

test("acceptance: a pyramid level equals min/max over the raw samples it summarises", async () => {
  const client = new StreamingClient({ store: await openBundle(BUNDLE) });
  const info = channelById(await client.channelInfo(), "sineA");
  const window = { startUs: info.startUs, endUs: info.endUs };

  const [pyramid] = await collect(
    client.query({ channels: [info.id], ...window, pixelWidthUs: 64_000 }),
  );
  const [raw] = await collect(
    client.query({
      channels: [info.id],
      ...window,
      pixelWidthUs: 1000,
      minMax: false,
    }),
  );

  const expected = pairsOf(Array.from(raw?.data ?? []), 64);
  expect(pyramid?.isMinMax).toBe(true);
  expect(Array.from(pyramid?.data ?? [])).toEqual(expected);
});

test("acceptance: the pyramid path fetches a small fraction of the raw bytes", async () => {
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
  // The incompressible channel: on the sines, compression hides the sample-count ratio.
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
      minMax: false,
    }),
  );
  const rawBytes = bytes;

  expect(pyramidBytes * 10).toBeLessThan(rawBytes);
});

test("acceptance: reads a real unit channel's events and waveforms", async () => {
  const client = new StreamingClient({ store: await openBundle(BUNDLE) });
  const infos = await client.channelInfo();
  const unitInfo = infos.find((info) => info.kind === "unit");
  if (!unitInfo) throw new Error("bundle has no unit channel");
  expect(unitInfo.endUs).toBe(unitInfo.startUs);

  const window = {
    startUs: unitInfo.startUs + 1_000_000,
    endUs: unitInfo.startUs + 2_000_000,
  };
  const expectedTimes = [8, 9, 10, 11, 12, 13, 14].map(
    (n) => unitInfo.startUs + n * 137_000,
  );

  // Zoomed out: events only.
  const [marks] = await collect(
    client.queryUnits({
      channels: [unitInfo.id],
      ...window,
      pixelWidthUs: 1000,
    }),
  );
  expect(Array.from(marks?.times ?? [])).toEqual(expectedTimes);
  expect(marks?.pointsPerEvent).toBe(0);
  expect(marks?.data.length).toBe(0);

  // Zoomed in: a 32-point waveform at 30 kHz spans ~1067 us, > 10 pixels of 50 us.
  const [shapes] = await collect(
    client.queryUnits({
      channels: [unitInfo.id],
      ...window,
      pixelWidthUs: 50,
    }),
  );
  expect(shapes?.pointsPerEvent).toBe(32);
  expect(shapes?.samplePeriodUs).toBeCloseTo(1e6 / 30_000, 9);
  expect(shapes?.data.length).toBe(7 * 32);
  // The first fetched row is event index 7, whose ramp starts at 7.
  expect(Array.from(shapes?.data.slice(0, 32) ?? [])).toEqual(
    Array.from({ length: 32 }, (_, i) => i + 7),
  );
});

test("acceptance: the filter path equals the filter module applied to the raw read", async () => {
  const spec = { type: "lowpass", order: 4, cutoffHz: 40 } as const;
  const client = new StreamingClient({ store: await openBundle(BUNDLE) });
  const info = channelById(await client.channelInfo(), "sineA");
  const window = {
    startUs: info.startUs,
    endUs: info.startUs + 10_000_000,
  };

  const [raw] = await collect(
    client.query({
      channels: [info.id],
      ...window,
      pixelWidthUs: 1000,
      minMax: false,
    }),
  );
  const [filtered] = await collect(
    client.query({
      channels: [info.id],
      ...window,
      pixelWidthUs: 1000,
      minMax: false,
      filter: spec,
    }),
  );

  const expected = makeFilter(spec, info.rateHz).process(
    raw?.data ?? new Float64Array(0),
  );
  expect(Array.from(filtered?.data ?? [])).toEqual(Array.from(expected));
});
