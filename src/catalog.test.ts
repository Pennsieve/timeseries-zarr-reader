import { describe, expect, test } from "vitest";
import type {
  FixtureChannel,
  FixtureContinuous,
  FixtureEvent,
} from "./test-utils.js";
import { bundleFiles, createMemoryStore } from "./test-utils.js";
import { readCatalog, selectLevel } from "./catalog.js";

const continuousTsz = {
  kind: "continuous",
  name: "LFP 1",
  id: "ch-1",
  unit: "uV",
  rate_hz: 1000,
  offset_us: 0,
};

/** Interleaved [min, max] per disjoint block, matching the minmax encoding. */
function pairsOf(samples: number[], block: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += block) {
    const values = samples.slice(i, i + block);
    out.push(Math.min(...values), Math.max(...values));
  }
  return out;
}

const RAW = Array.from({ length: 400 }, (_, i) => i);

/** Returns a copy of `object` without the named keys. */
function without<T extends object, K extends keyof T>(
  object: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...object } as Record<string, unknown>;
  for (const key of keys) {
    delete copy[key as string];
  }
  return copy as Omit<T, K>;
}

const continuousChannel = (
  over: Partial<FixtureContinuous> = {},
): FixtureContinuous => ({
  index: 0,
  tsz: { ...continuousTsz },
  raw: RAW,
  levels: [
    { periodUs: 4000, pairs: pairsOf(RAW, 4) },
    {
      periodUs: 16_000,
      pairs: pairsOf(RAW, 16),
      count: new Array<number>(25).fill(16),
    },
  ],
  ...over,
});

const eventChannel = (over: Partial<FixtureEvent> = {}): FixtureEvent => ({
  index: 2,
  tsz: { kind: "event", name: "marks", id: "ch-9" },
  events: [1000, 2000, 3000],
  ...over,
});

const storeOf = (channels: FixtureChannel[], options = {}) =>
  createMemoryStore(bundleFiles(channels, options));

/** Parses a fixture's root so a test can break one part of it. */
function rootOf(channels: FixtureChannel[]): {
  root: Record<string, unknown> & {
    consolidated_metadata: {
      metadata: Record<string, Record<string, unknown>>;
    };
  };
  files: ReturnType<typeof bundleFiles>;
} {
  const files = bundleFiles(channels);
  const root = JSON.parse(files["/zarr.json"] as string) as ReturnType<
    typeof rootOf
  >["root"];
  return { root, files };
}

describe("selectLevel", () => {
  /** A pyramid decimating 4x per level, coarsest last. */
  const pyramid = [
    { path: "0/raw", periodUs: 1000 },
    { path: "0/1", periodUs: 4000 },
    { path: "0/2", periodUs: 16_000 },
  ];

  test("selects the coarsest level whose period is at most the pixel width", () => {
    expect(selectLevel(pyramid, 5000).periodUs).toBe(4000);
  });

  test("selects a level whose period equals the pixel width", () => {
    expect(selectLevel(pyramid, 4000).periodUs).toBe(4000);
  });

  test("falls back to the finest level when every level is coarser", () => {
    expect(selectLevel(pyramid, 500).periodUs).toBe(1000);
  });

  test("returns the only level of a single-level list", () => {
    expect(selectLevel([{ path: "0/raw", periodUs: 1000 }], 999_999).path).toBe(
      "0/raw",
    );
  });

  test("accepts levels in any order", () => {
    const descending = [
      { path: "0/2", periodUs: 16_000 },
      { path: "0/1", periodUs: 4000 },
      { path: "0/raw", periodUs: 1000 },
    ];
    expect(selectLevel(descending, 5000).periodUs).toBe(4000);
    expect(selectLevel(descending, 500).periodUs).toBe(1000);
  });

  test("returns the selected level object by reference", () => {
    expect(selectLevel(pyramid, 5000)).toBe(pyramid[1]);
  });

  test("rejects an empty level list", () => {
    expect(() => selectLevel([], 5000)).toThrow(RangeError);
  });

  test("rejects a pixel width that is not greater than zero", () => {
    expect(() => selectLevel(pyramid, 0)).toThrow(RangeError);
    expect(() => selectLevel(pyramid, -1)).toThrow(RangeError);
    expect(() => selectLevel(pyramid, Number.NaN)).toThrow(RangeError);
  });
});

describe("readCatalog: the root", () => {
  test("records the bundle's version", async () => {
    const catalog = await readCatalog(storeOf([continuousChannel()]));
    expect(catalog.version).toBe("1.0");
  });

  test("reads any 1.x bundle", async () => {
    const store = storeOf([continuousChannel()], {
      rootTsz: { version: "1.7", future_key: true },
    });
    const catalog = await readCatalog(store);
    expect(catalog.version).toBe("1.7");
    expect(catalog.channels).toHaveLength(1);
  });

  test("rejects a bundle of another major version", async () => {
    const store = storeOf([continuousChannel()], {
      rootTsz: { version: "2.0" },
    });
    await expect(readCatalog(store)).rejects.toThrow(/TS-Zarr 2\.0.*1\.x/);
  });

  test("rejects a bundle with no tsz.version, naming the pre-1.0 layout", async () => {
    const noTsz = storeOf([continuousChannel()], { rootTsz: null });
    await expect(readCatalog(noTsz)).rejects.toThrow(/before TS-Zarr 1\.0/);

    const noVersion = storeOf([continuousChannel()], { rootTsz: {} });
    await expect(readCatalog(noVersion)).rejects.toThrow(/tsz\.version/);
  });

  test("rejects a malformed version string", async () => {
    for (const version of ["1", "one.zero", 1.0, "1.0.0"]) {
      const store = storeOf([continuousChannel()], { rootTsz: { version } });
      await expect(readCatalog(store)).rejects.toThrow(/major\.minor/);
    }
  });

  test("rejects a bundle with no root metadata", async () => {
    await expect(readCatalog(createMemoryStore({}))).rejects.toThrow(
      /zarr\.json/,
    );
  });

  test("rejects root metadata that is not JSON", async () => {
    const store = createMemoryStore({ "/zarr.json": "{not json" });
    await expect(readCatalog(store)).rejects.toThrow(/zarr\.json/);
  });

  test("rejects root metadata that is not an object", async () => {
    const store = createMemoryStore({ "/zarr.json": "42" });
    await expect(readCatalog(store)).rejects.toThrow(/object/);
  });

  test("rejects a root that is not a Zarr v3 group", async () => {
    const { root } = rootOf([continuousChannel()]);
    const wrongFormat = createMemoryStore({
      "/zarr.json": JSON.stringify({ ...root, zarr_format: 2 }),
    });
    await expect(readCatalog(wrongFormat)).rejects.toThrow(/zarr_format/);

    const wrongNode = createMemoryStore({
      "/zarr.json": JSON.stringify({ ...root, node_type: "array" }),
    });
    await expect(readCatalog(wrongNode)).rejects.toThrow(/node_type/);
  });

  test("rejects a bundle with no consolidated metadata", async () => {
    const { root } = rootOf([continuousChannel()]);
    const bare = without(root, "consolidated_metadata");
    const store = createMemoryStore({ "/zarr.json": JSON.stringify(bare) });
    await expect(readCatalog(store)).rejects.toThrow(/consolidated_metadata/);
  });
});

describe("readCatalog: continuous channels", () => {
  test("enumerates a channel with its info and levels, raw first", async () => {
    const catalog = await readCatalog(storeOf([continuousChannel()]));

    expect(catalog.channels).toHaveLength(1);
    const entry = catalog.channels[0]!;
    expect(entry.kind).toBe("continuous");
    expect(entry.path).toBe("/0");
    expect(entry.info).toEqual({
      kind: "continuous",
      index: 0,
      id: "ch-1",
      name: "LFP 1",
      unit: "uV",
      rateHz: 1000,
      startUs: 0,
      endUs: 400_000,
      runs: 1,
    });
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels).toEqual([
      {
        path: "/0/raw",
        periodUs: 1000,
        samplesPerBin: 1,
        binCount: 400,
        isMinMax: false,
      },
      {
        path: "/0/1/minmax",
        periodUs: 4000,
        samplesPerBin: 4,
        binCount: 100,
        isMinMax: true,
      },
      {
        path: "/0/2/minmax",
        periodUs: 16_000,
        samplesPerBin: 16,
        binCount: 25,
        isMinMax: true,
        countPath: "/0/2/count",
      },
    ]);
  });

  test("derives the raw period from rate_hz and endUs from the sample count", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel({
          tsz: { ...continuousTsz, rate_hz: 512, offset_us: 2_000_000 },
          raw: new Array<number>(1024).fill(0),
          levels: [],
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    expect(entry.info.kind === "continuous" && entry.info.startUs).toBe(
      2_000_000,
    );
    expect(entry.info.kind === "continuous" && entry.info.endUs).toBe(
      4_000_000,
    );
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels[0]!.periodUs).toBe(1e6 / 512);
  });

  test("defaults offset_us to 0 and the id to the channel index", async () => {
    const minimal = without(continuousTsz, "offset_us", "id");
    const catalog = await readCatalog(
      storeOf([continuousChannel({ index: 4, tsz: minimal })]),
    );
    const entry = catalog.channels[0]!;
    expect(entry.info.id).toBe("4");
    expect(entry.info.index).toBe(4);
    expect(entry.info.kind === "continuous" && entry.info.startUs).toBe(0);
    expect(catalog.byId.get("4")).toEqual([entry]);
    expect(catalog.idByIndex.get(4)).toBe("4");
  });

  test("accepts a negative offset_us", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel({ tsz: { ...continuousTsz, offset_us: -400_000 } }),
      ]),
    );
    const info = catalog.channels[0]!.info;
    expect(info.kind === "continuous" && info.startUs).toBe(-400_000);
    expect(info.kind === "continuous" && info.endUs).toBe(0);
  });

  test("carries provenance through", async () => {
    const provenance = { software: "edf2tsz 1.2" };
    const catalog = await readCatalog(
      storeOf([continuousChannel({ tsz: { ...continuousTsz, provenance } })]),
    );
    expect(catalog.channels[0]!.info.provenance).toEqual(provenance);
  });

  test("ignores tsz keys the format does not define and records the level's member paths", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel({
          tsz: { ...continuousTsz, color: "red" },
          levels: [
            {
              periodUs: 4000,
              pairs: pairsOf(RAW, 4),
              mean: new Array<number>(100).fill(0),
              var: new Array<number>(100).fill(1),
            },
          ],
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels).toHaveLength(2);
    expect(entry.levels[1]).toEqual({
      path: "/0/1/minmax",
      periodUs: 4000,
      samplesPerBin: 4,
      binCount: 100,
      isMinMax: true,
      meanPath: "/0/1/mean",
      variancePath: "/0/1/var",
    });
  });

  test("accepts an empty channel: a zero-length raw and no levels", async () => {
    const catalog = await readCatalog(
      storeOf([continuousChannel({ raw: [], levels: [] })]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.info.endUs).toBe(entry.info.startUs);
    expect(entry.levels).toEqual([
      {
        path: "/0/raw",
        periodUs: 1000,
        samplesPerBin: 1,
        binCount: 0,
        isMinMax: false,
      },
    ]);
  });

  test("returns levels finest first regardless of storage order", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    const { metadata } = root.consolidated_metadata;
    const reversed = Object.fromEntries(Object.entries(metadata).reverse());
    root.consolidated_metadata.metadata = reversed;
    files["/zarr.json"] = JSON.stringify(root);

    const catalog = await readCatalog(createMemoryStore(files));
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels.map((level) => level.periodUs)).toEqual([
      1000, 4000, 16_000,
    ]);
  });

  test("names the missing attribute in the error", async () => {
    for (const key of ["name", "unit", "rate_hz"] as const) {
      const tsz = without(continuousTsz, key);
      await expect(
        readCatalog(storeOf([continuousChannel({ tsz })])),
      ).rejects.toThrow(new RegExp(`channel /0: tsz\\.${key} is missing`));
    }
  });

  test("rejects a malformed attribute, naming it", async () => {
    const malformed: Array<[string, unknown]> = [
      ["rate_hz", "1000"],
      ["rate_hz", 0],
      ["rate_hz", -1],
      ["offset_us", 1.5],
      ["offset_us", "0"],
      ["name", 7],
      ["id", 7],
      ["provenance", "edf"],
    ];
    for (const [key, value] of malformed) {
      const store = storeOf([
        continuousChannel({ tsz: { ...continuousTsz, [key]: value } }),
      ]);
      await expect(readCatalog(store)).rejects.toThrow(
        new RegExp(`tsz\\.${key} must be`),
      );
    }
  });

  test("rejects a level group with no tsz attributes", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    root.consolidated_metadata.metadata["0/1"]!.attributes = {};
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /level \/0\/1 has no tsz/,
    );
  });

  test("rejects a continuous channel with no raw array", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    delete root.consolidated_metadata.metadata["0/raw"];
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /raw array/,
    );
  });

  test("rejects a raw array that is not rank 1", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    root.consolidated_metadata.metadata["0/raw"]!.shape = [400, 1];
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /raw array of shape \[n\]/,
    );
  });

  test("rejects a level with no minmax member or a malformed one", async () => {
    const missing = rootOf([continuousChannel()]);
    delete missing.root.consolidated_metadata.metadata["0/1/minmax"];
    missing.files["/zarr.json"] = JSON.stringify(missing.root);
    await expect(readCatalog(createMemoryStore(missing.files))).rejects.toThrow(
      /level \/0\/1 must have a minmax array/,
    );

    for (const shape of [[100, 3], [100], [100, 2, 2], "100"]) {
      const { root, files } = rootOf([continuousChannel()]);
      root.consolidated_metadata.metadata["0/1/minmax"]!.shape = shape;
      files["/zarr.json"] = JSON.stringify(root);
      await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
        /minmax array of shape \[n, 2\]/,
      );
    }
  });

  test("rejects a level whose count has a different number of bins", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    root.consolidated_metadata.metadata["0/2/count"]!.shape = [24];
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /25 bins but count/,
    );
  });

  test("rejects a level with a missing or non-positive period_us", async () => {
    const zero = storeOf([
      continuousChannel({ levels: [{ periodUs: 0, pairs: pairsOf(RAW, 4) }] }),
    ]);
    await expect(readCatalog(zero)).rejects.toThrow(/period_us must be/);

    const { root, files } = rootOf([continuousChannel()]);
    root.consolidated_metadata.metadata["0/1"]!.attributes = { tsz: {} };
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /period_us is missing/,
    );
  });

  test("opens two channels that share an id", async () => {
    const catalog = await readCatalog(
      storeOf([continuousChannel(), continuousChannel({ index: 1 })]),
    );
    expect(catalog.channels.map((entry) => entry.info.index)).toEqual([0, 1]);
    expect(catalog.byId.get("ch-1")).toEqual(catalog.channels);
    expect([...catalog.idByIndex]).toEqual([
      [0, "ch-1"],
      [1, "ch-1"],
    ]);
  });
});

describe("readCatalog: level structure", () => {
  const levelsOf = async (
    levels: Array<{ periodUs: number; width: number }>,
    over: Partial<FixtureContinuous> = {},
  ) => {
    const raw = over.raw ?? RAW;
    return readCatalog(
      storeOf([
        continuousChannel({
          raw,
          levels: levels.map(({ periodUs, width }) => ({
            periodUs,
            pairs: pairsOf(raw, width),
          })),
          ...over,
        }),
      ]),
    );
  };

  test("derives each level's width in samples from its period", async () => {
    const catalog = await levelsOf([
      { periodUs: 2000, width: 2 },
      { periodUs: 6000, width: 6 },
    ]);
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels.map((level) => level.samplesPerBin)).toEqual([1, 2, 6]);
    expect(entry.levels.map((level) => level.binCount)).toEqual([400, 200, 67]);
  });

  test("counts a short last bin", async () => {
    const raw = Array.from({ length: 401 }, (_, i) => i);
    const catalog = await levelsOf([{ periodUs: 4000, width: 4 }], { raw });
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels[1]!.binCount).toBe(101);
  });

  test("accepts a period that carries rounding error at 30000 Hz", async () => {
    const raw = Array.from({ length: 10_000 }, (_, i) => i);
    const catalog = await levelsOf(
      [
        { periodUs: (4 * 1e6) / 30_000, width: 4 },
        { periodUs: 136_533.33333333334, width: 4096 },
      ],
      { raw, tsz: { ...continuousTsz, rate_hz: 30_000 } },
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels.map((level) => level.samplesPerBin)).toEqual([
      1, 4, 4096,
    ]);
    expect(entry.levels.map((level) => level.binCount)).toEqual([
      10_000, 2500, 3,
    ]);
  });

  test("rejects levels numbered with a gap", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    const { metadata } = root.consolidated_metadata;
    for (const key of Object.keys(metadata)) {
      if (key.startsWith("0/2")) {
        metadata[key.replace("0/2", "0/3")] = metadata[key]!;
        delete metadata[key];
      }
    }
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /channel \/0: levels must be numbered from 1 with no gap \(got 1, 3\)/,
    );
  });

  test("rejects a period that is not a whole number of samples", async () => {
    await expect(levelsOf([{ periodUs: 4500, width: 4 }])).rejects.toThrow(
      /level \/0\/1: tsz\.period_us must be a whole number of samples/,
    );
  });

  test("rejects a level one sample wide", async () => {
    await expect(levelsOf([{ periodUs: 1000, width: 1 }])).rejects.toThrow(
      /level \/0\/1: tsz\.period_us must be a whole number of samples from 2/,
    );
  });

  test("rejects a level 2^32 samples wide", async () => {
    const raw = [1, 2, 3];
    await expect(
      readCatalog(
        storeOf([
          continuousChannel({
            raw,
            levels: [{ periodUs: 2 ** 32 * 1000, pairs: [1, 3] }],
          }),
        ]),
      ),
    ).rejects.toThrow(/level \/0\/1: tsz\.period_us must be a whole number/);
  });

  test("rejects a level that is not a multiple of the level before it", async () => {
    await expect(
      levelsOf([
        { periodUs: 4000, width: 4 },
        { periodUs: 6000, width: 6 },
      ]),
    ).rejects.toThrow(/level \/0\/2: tsz\.period_us must be a multiple/);
  });

  test("rejects a level less than twice as wide as the level before it", async () => {
    await expect(
      levelsOf([
        { periodUs: 4000, width: 4 },
        { periodUs: 4000, width: 4 },
      ]),
    ).rejects.toThrow(/level \/0\/2: tsz\.period_us must be a multiple/);
  });

  test("rejects a minmax array with the wrong number of bins", async () => {
    const short = pairsOf(RAW, 4).slice(0, -2);
    await expect(
      readCatalog(
        storeOf([
          continuousChannel({ levels: [{ periodUs: 4000, pairs: short }] }),
        ]),
      ),
    ).rejects.toThrow(/level \/0\/1 has 100 bins but minmax has shape/);
  });

  test("rejects a member with the wrong number of bins", async () => {
    for (const member of ["count", "mean", "var"] as const) {
      const { root, files } = rootOf([
        continuousChannel({
          levels: [
            {
              periodUs: 4000,
              pairs: pairsOf(RAW, 4),
              [member]: new Array<number>(100).fill(1),
            },
          ],
        }),
      ]);
      root.consolidated_metadata.metadata[`0/1/${member}`]!.shape = [99];
      files["/zarr.json"] = JSON.stringify(root);
      await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
        new RegExp(`level /0/1 has 100 bins but ${member} has shape`),
      );
    }
  });

  test("rejects a level on a channel with no samples", async () => {
    await expect(
      levelsOf([{ periodUs: 4000, width: 4 }], { raw: [] }),
    ).rejects.toThrow(/channel \/0 has no samples, so it must have no levels/);
  });

  test("accepts a level without count", async () => {
    const catalog = await levelsOf([{ periodUs: 4000, width: 4 }]);
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels[1]!.countPath).toBeUndefined();
  });
});

describe("readCatalog: event channels", () => {
  test("enumerates a minimal event channel", async () => {
    const catalog = await readCatalog(storeOf([eventChannel()]));

    const entry = catalog.byId.get("ch-9")?.[0];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("event");
    expect(entry!.info).toEqual({
      kind: "event",
      index: 2,
      id: "ch-9",
      name: "marks",
      eventCount: 3,
      columns: [],
      hasWaveformMean: false,
      countLevels: 0,
    });
    if (entry!.kind !== "event") throw new Error("unreachable");
    expect(entry!.arrays).toEqual({
      events: { path: "/2/events", count: 3 },
      countLevels: [],
    });
  });

  test("enumerates every column, snippet array, and count level", async () => {
    const catalog = await readCatalog(
      storeOf([
        eventChannel({
          tsz: {
            kind: "event",
            name: "detector",
            id: "det",
            unit: "a.u.",
            label_names: ["ripple", "fast-ripple"],
            max_duration_us: 50_000,
            provenance: { software: "det 0.3" },
          },
          durations: [0, 10_000, 50_000],
          labels: [0, 1, 0],
          values: [0.5, 0.25, 0.75],
          text: ["a", "bb", ""],
          channels: [[0], [], [0, 2]],
          waveforms: {
            periodUs: 100,
            pointsPerEvent: 2,
            samples: [1, 2, 3, 4, 5, 6],
            eventSample: 1,
          },
          waveformMean: {
            periodUs: 100,
            pointsPerEvent: 2,
            samples: [2, 3, 4, 5],
          },
          countLevels: [
            { periodUs: 1000, labelCount: 2, counts: [1, 0, 0, 1, 1, 0] },
            { periodUs: 4000, offsetUs: 0, labelCount: 2, counts: [2, 1] },
          ],
        }),
      ]),
    );

    const entry = catalog.byId.get("det")![0]!;
    expect(entry.info).toEqual({
      kind: "event",
      index: 2,
      id: "det",
      name: "detector",
      unit: "a.u.",
      eventCount: 3,
      columns: [
        "durations",
        "labels",
        "values",
        "text",
        "channels",
        "waveforms",
      ],
      labelNames: ["ripple", "fast-ripple"],
      maxDurationUs: 50_000,
      hasWaveformMean: true,
      countLevels: 2,
      provenance: { software: "det 0.3" },
    });
    if (entry.kind !== "event") throw new Error("unreachable");
    expect(entry.arrays).toEqual({
      events: { path: "/2/events", count: 3 },
      durations: { path: "/2/durations", maxDurationUs: 50_000 },
      labels: { path: "/2/labels" },
      values: { path: "/2/values" },
      text: { path: "/2/text", width: 2 },
      channels: { path: "/2/channels", width: 1 },
      waveforms: {
        path: "/2/waveforms",
        rows: 3,
        pointsPerEvent: 2,
        periodUs: 100,
        eventSample: 1,
      },
      waveformMean: {
        path: "/2/waveform_mean",
        rows: 2,
        pointsPerEvent: 2,
        periodUs: 100,
        eventSample: 0,
      },
      countLevels: [
        {
          path: "/2/1/count",
          level: 1,
          periodUs: 1000,
          offsetUs: 0,
          binCount: 3,
          labelCount: 2,
        },
        {
          path: "/2/2/count",
          level: 2,
          periodUs: 4000,
          offsetUs: 0,
          binCount: 1,
          labelCount: 2,
        },
      ],
    });
  });

  test("reads a count level's offset_us", async () => {
    const catalog = await readCatalog(
      storeOf([
        eventChannel({
          countLevels: [
            {
              periodUs: 1000,
              offsetUs: -2000,
              labelCount: 1,
              counts: [0, 0, 1, 1, 1],
            },
          ],
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "event") throw new Error("unreachable");
    expect(entry.arrays.countLevels[0]!.offsetUs).toBe(-2000);
  });

  test("keeps durations without a bound, leaving maxDurationUs unset", async () => {
    const catalog = await readCatalog(
      storeOf([eventChannel({ durations: [0, 0, 0] })]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "event") throw new Error("unreachable");
    expect(entry.info.maxDurationUs).toBeUndefined();
    expect(entry.arrays.durations).toEqual({ path: "/2/durations" });
  });

  test("defaults the id to the channel key", async () => {
    const catalog = await readCatalog(
      storeOf([
        eventChannel({ index: 7, tsz: { kind: "event", name: "marks" } }),
      ]),
    );
    expect(catalog.channels[0]!.info.id).toBe("7");
  });

  test("ignores arrays and groups under the channel that the format does not define", async () => {
    const catalog = await readCatalog(
      storeOf([
        eventChannel({
          extraArrays: {
            scores2: { shape: [3] },
            notes: { shape: [3, 4], dataType: "uint8" },
          },
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "event") throw new Error("unreachable");
    expect(entry.info.columns).toEqual([]);
    expect(Object.keys(entry.arrays)).toEqual(["events", "countLevels"]);
  });

  test("enumerates a mixed bundle in index order", async () => {
    const catalog = await readCatalog(
      storeOf([eventChannel({ index: 1 }), continuousChannel()]),
    );
    expect(
      catalog.channels.map((entry) => [entry.info.index, entry.kind]),
    ).toEqual([
      [0, "continuous"],
      [1, "event"],
    ]);
    expect([...catalog.idByIndex]).toEqual([
      [0, "ch-1"],
      [1, "ch-9"],
    ]);
  });

  test("rejects an event channel with no events array or a malformed one", async () => {
    const missing = rootOf([eventChannel()]);
    delete missing.root.consolidated_metadata.metadata["2/events"];
    missing.files["/zarr.json"] = JSON.stringify(missing.root);
    await expect(readCatalog(createMemoryStore(missing.files))).rejects.toThrow(
      /events array of shape \[n\]/,
    );

    const { root, files } = rootOf([eventChannel()]);
    root.consolidated_metadata.metadata["2/events"]!.shape = [3, 1];
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /events array of shape \[n\]/,
    );
  });

  test("rejects a column whose length is not the event count", async () => {
    for (const column of [
      "durations",
      "labels",
      "values",
      "text",
      "channels",
    ]) {
      const { root, files } = rootOf([
        eventChannel({
          durations: [0, 0, 0],
          labels: [0, 0, 0],
          values: [0, 0, 0],
          text: ["a", "b", "c"],
          channels: [[], [], []],
        }),
      ]);
      const node = root.consolidated_metadata.metadata[`2/${column}`]!;
      node.shape = (node.shape as number[]).map((dim, i) =>
        i === 0 ? 2 : dim,
      );
      files["/zarr.json"] = JSON.stringify(root);
      await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
        new RegExp(`3 events but ${column}`),
      );
    }
  });

  test("rejects waveforms with the wrong row count, rank, or no period_us", async () => {
    const snippets = {
      periodUs: 100,
      pointsPerEvent: 2,
      samples: [1, 2, 3, 4, 5, 6],
    };

    const rows = rootOf([eventChannel({ waveforms: snippets })]);
    rows.root.consolidated_metadata.metadata["2/waveforms"]!.shape = [2, 2];
    rows.files["/zarr.json"] = JSON.stringify(rows.root);
    await expect(readCatalog(createMemoryStore(rows.files))).rejects.toThrow(
      /3 events but waveforms has 2 rows/,
    );

    const rank = rootOf([eventChannel({ waveforms: snippets })]);
    rank.root.consolidated_metadata.metadata["2/waveforms"]!.shape = [6];
    rank.files["/zarr.json"] = JSON.stringify(rank.root);
    await expect(readCatalog(createMemoryStore(rank.files))).rejects.toThrow(
      /waveforms must have shape \[rows, points\]/,
    );

    const period = rootOf([eventChannel({ waveforms: snippets })]);
    period.root.consolidated_metadata.metadata["2/waveforms"]!.attributes = {
      tsz: {},
    };
    period.files["/zarr.json"] = JSON.stringify(period.root);
    await expect(readCatalog(createMemoryStore(period.files))).rejects.toThrow(
      /waveforms: tsz\.period_us is missing/,
    );
  });

  test("rejects a count level with no count array", async () => {
    const { root, files } = rootOf([
      eventChannel({
        countLevels: [{ periodUs: 1000, labelCount: 1, counts: [1, 1, 1] }],
      }),
    ]);
    delete root.consolidated_metadata.metadata["2/1/count"];
    files["/zarr.json"] = JSON.stringify(root);
    await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
      /count level \/2\/1 must have a count array/,
    );
  });

  test("rejects malformed event attributes, naming them", async () => {
    const malformed: Array<[string, unknown]> = [
      ["label_names", "ripple"],
      ["label_names", [1, 2]],
      ["max_duration_us", "50000"],
      ["max_duration_us", 1.5],
      ["unit", 7],
    ];
    for (const [key, value] of malformed) {
      const store = storeOf([
        eventChannel({ tsz: { kind: "event", name: "marks", [key]: value } }),
      ]);
      await expect(readCatalog(store)).rejects.toThrow(
        new RegExp(`event channel /2: tsz\\.${key} must be`),
      );
    }
  });

  test("rejects an event channel with no name", async () => {
    const store = storeOf([eventChannel({ tsz: { kind: "event" } })]);
    await expect(readCatalog(store)).rejects.toThrow(/tsz\.name is missing/);
  });
});

describe("readCatalog: what is not a channel", () => {
  test("ignores root children that carry no tsz, an unknown kind, or are arrays", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    const { metadata } = root.consolidated_metadata;
    metadata.montages = {
      node_type: "group",
      attributes: { montage: { pairs: [[0, 2]] } },
    };
    metadata.index = { node_type: "array", shape: [4], attributes: {} };
    metadata["9"] = {
      node_type: "group",
      attributes: { tsz: { kind: "spectrogram", name: "later" } },
    };
    (metadata as Record<string, unknown>).junk = 42;
    metadata["0/extra/deep/node"] = {
      node_type: "array",
      shape: [4],
      attributes: {},
    };
    files["/zarr.json"] = JSON.stringify(root);

    const catalog = await readCatalog(createMemoryStore(files));

    expect(catalog.channels.map((entry) => entry.info.index)).toEqual([0]);
  });

  test("ignores a level group named 0, which the format does not define", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    root.consolidated_metadata.metadata["0/0"] = {
      node_type: "group",
      attributes: {},
    };
    files["/zarr.json"] = JSON.stringify(root);

    const catalog = await readCatalog(createMemoryStore(files));
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels).toHaveLength(3);
  });
});

describe("readCatalog: runs", () => {
  test("notes a runs table and counts its rows, reading none of it", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel({
          runs: [
            [0, 100, 0],
            [200, 200, 200_400],
          ],
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.runs).toEqual({ path: "/0/runs", rows: 2 });
    expect(entry.sampleCount).toBe(400);
    expect(entry.info.runs).toBe(2);
  });

  test("reports one run without a table, and none for an empty channel", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel(),
        continuousChannel({
          index: 1,
          tsz: { ...continuousTsz, id: "empty" },
          raw: [],
          levels: [],
        }),
      ]),
    );
    expect(catalog.channels.map((entry) => entry.info)).toMatchObject([
      { runs: 1 },
      { runs: 0 },
    ]);
    expect(catalog.channels[0]).not.toHaveProperty("runs");
  });

  test("rejects a runs table that is not [runs, 3] or has no rows", async () => {
    const { root, files } = rootOf([
      continuousChannel({ runs: [[0, 400, 0]] }),
    ]);
    for (const shape of [[1], [1, 2], [0, 3]]) {
      root.consolidated_metadata.metadata["0/runs"]!.shape = shape;
      files["/zarr.json"] = JSON.stringify(root);
      await expect(readCatalog(createMemoryStore(files))).rejects.toThrow(
        /channel \/0 runs must have shape \[runs, 3\]/,
      );
    }
  });
});

describe("readCatalog: the rules of 1.0", () => {
  test("ignores a root group whose name is not an integer name", async () => {
    const { root, files } = rootOf([continuousChannel()]);
    const metadata = root.consolidated_metadata.metadata;
    for (const name of ["07", "ch1", "-1"]) {
      metadata[name] = { ...metadata["0"]! };
    }
    files["/zarr.json"] = JSON.stringify(root);

    const catalog = await readCatalog(createMemoryStore(files));
    expect(catalog.channels.map((entry) => entry.path)).toEqual(["/0"]);
  });

  test("accepts levels whose factor is not 4", async () => {
    const catalog = await readCatalog(
      storeOf([
        continuousChannel({
          levels: [
            { periodUs: 2000, pairs: pairsOf(RAW, 2) },
            { periodUs: 6000, pairs: pairsOf(RAW, 6) },
            { periodUs: 24_000, pairs: pairsOf(RAW, 24) },
          ],
        }),
      ]),
    );
    const entry = catalog.channels[0]!;
    if (entry.kind !== "continuous") throw new Error("unreachable");
    expect(entry.levels.map((level) => level.periodUs)).toEqual([
      1000, 2000, 6000, 24_000,
    ]);
  });

  test("rejects a count level whose period_us is not a positive integer", async () => {
    for (const periodUs of [1000.5, 0, -1000]) {
      await expect(
        readCatalog(
          storeOf([
            eventChannel({
              countLevels: [{ periodUs, labelCount: 1, counts: [3] }],
            }),
          ]),
        ),
      ).rejects.toThrow(
        /count level \/2\/1: tsz\.period_us must be an integer/,
      );
    }
  });

  test("rejects an event_sample outside the snippet", async () => {
    for (const eventSample of [-1, 3]) {
      await expect(
        readCatalog(
          storeOf([
            eventChannel({
              waveforms: {
                periodUs: 100,
                pointsPerEvent: 3,
                samples: new Array<number>(9).fill(0),
                eventSample,
              },
            }),
          ]),
        ),
      ).rejects.toThrow(/waveforms: tsz\.event_sample must be in \[0, 3\)/);
    }
  });

  test("rejects an empty label_names", async () => {
    await expect(
      readCatalog(
        storeOf([
          eventChannel({
            tsz: { kind: "event", name: "marks", label_names: [] },
          }),
        ]),
      ),
    ).rejects.toThrow(/label_names must name at least one label/);
  });
});
