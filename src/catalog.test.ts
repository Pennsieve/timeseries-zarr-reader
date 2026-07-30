import { expect, test } from "vitest";
import type { FixtureChannel } from "./test-utils.js";
import {
  bundleMetadata,
  createMemoryStore,
  makeSegment,
} from "./test-utils.js";
import { trimToBounds } from "./trim.js";
import {
  binRange,
  readCatalog,
  selectLevel,
  toChannelInfo,
} from "./catalog.js";

const START_US = 1_700_000_000_000_000;

const continuousAttrs = {
  id: "ch-1",
  name: "LFP 1",
  unit: "uV",
  rate_hz: 1000,
  start_us: START_US,
  kind: "continuous",
};

const unitAttrs = { ...continuousAttrs, id: "ch-9", kind: "unit" };

test("maps a continuous channel's attributes to camelCase and derives its end", () => {
  expect(
    toChannelInfo(continuousAttrs, { periodUs: 1000, sampleCount: 500 }),
  ).toEqual({
    id: "ch-1",
    name: "LFP 1",
    unit: "uV",
    rateHz: 1000,
    startUs: START_US,
    endUs: START_US + 500_000,
    kind: "continuous",
  });
});

test("treats endUs as the exclusive end, one period past the last sample", () => {
  const info = toChannelInfo(continuousAttrs, {
    periodUs: 250,
    sampleCount: 4,
  });
  expect(info.endUs).toBe(START_US + 1000);
});

test("reports a unit channel's end as its start, needing no level 0", () => {
  const info = toChannelInfo(unitAttrs);
  expect(info.kind).toBe("unit");
  expect(info.startUs).toBe(START_US);
  expect(info.endUs).toBe(START_US);
});

test("ignores attributes it does not recognise", () => {
  const info = toChannelInfo(
    { ...continuousAttrs, colour: "red", channel_type: 7 },
    { periodUs: 1000, sampleCount: 1 },
  );
  expect(info.id).toBe("ch-1");
});

test("rejects a missing or wrong-typed string attribute, naming it", () => {
  const withoutName: Record<string, unknown> = { ...continuousAttrs };
  delete withoutName.name;

  expect(() =>
    toChannelInfo(withoutName, { periodUs: 1000, sampleCount: 1 }),
  ).toThrow(TypeError);
  expect(() =>
    toChannelInfo(withoutName, { periodUs: 1000, sampleCount: 1 }),
  ).toThrow(/name/);
});

test("rejects a non-numeric rate_hz, naming it", () => {
  expect(() =>
    toChannelInfo(
      { ...continuousAttrs, rate_hz: "1000" },
      { periodUs: 1000, sampleCount: 1 },
    ),
  ).toThrow(/rate_hz/);
});

test("rejects a rate_hz that is not above zero", () => {
  expect(() =>
    toChannelInfo(
      { ...continuousAttrs, rate_hz: 0 },
      { periodUs: 1000, sampleCount: 1 },
    ),
  ).toThrow(RangeError);
});

test("rejects a non-finite start_us", () => {
  expect(() =>
    toChannelInfo(
      { ...continuousAttrs, start_us: Number.NaN },
      { periodUs: 1000, sampleCount: 1 },
    ),
  ).toThrow(/start_us/);
});

test("rejects a kind it does not recognise", () => {
  expect(() =>
    toChannelInfo(
      { ...continuousAttrs, kind: "annotation" },
      { periodUs: 1000, sampleCount: 1 },
    ),
  ).toThrow(/kind/);
});

test("rejects attributes that are not an object", () => {
  expect(() => toChannelInfo(null)).toThrow(TypeError);
  expect(() => toChannelInfo("continuous")).toThrow(TypeError);
});

test("rejects a continuous channel with no level 0 geometry", () => {
  expect(() => toChannelInfo(continuousAttrs)).toThrow(/level 0/);
});

/** A pyramid decimating 4x per level, coarsest last. */
const pyramid = [
  { path: "0/0", periodUs: 1000 },
  { path: "0/1", periodUs: 4000 },
  { path: "0/2", periodUs: 16_000 },
];

test("picks the coarsest level whose bins fit within one pixel", () => {
  expect(selectLevel(pyramid, 5000).periodUs).toBe(4000);
});

test("accepts a level whose period matches the pixel width exactly", () => {
  expect(selectLevel(pyramid, 4000).periodUs).toBe(4000);
});

test("falls back to the finest level when every level is coarser", () => {
  expect(selectLevel(pyramid, 500).periodUs).toBe(1000);
});

test("returns the only level of a single-level bundle", () => {
  expect(selectLevel([{ path: "0/0", periodUs: 1000 }], 999_999).path).toBe(
    "0/0",
  );
});

test("does not depend on the order the levels arrive in", () => {
  const descending = [
    { path: "0/2", periodUs: 16_000 },
    { path: "0/1", periodUs: 4000 },
    { path: "0/0", periodUs: 1000 },
  ];
  expect(selectLevel(descending, 5000).periodUs).toBe(4000);
  expect(selectLevel(descending, 500).periodUs).toBe(1000);
});

test("returns the caller's own level object", () => {
  expect(selectLevel(pyramid, 5000)).toBe(pyramid[1]);
});

test("rejects an empty level list", () => {
  expect(() => selectLevel([], 5000)).toThrow(RangeError);
});

test("rejects a pixel width that is not above zero", () => {
  expect(() => selectLevel(pyramid, 0)).toThrow(RangeError);
  expect(() => selectLevel(pyramid, -1)).toThrow(RangeError);
  expect(() => selectLevel(pyramid, Number.NaN)).toThrow(RangeError);
});

/** Ten 1000 us bins, anchored well away from zero so offsets cannot pass by accident. */
const GRID_START_US = 1_000_000;
const grid = { startUs: GRID_START_US, periodUs: 1000, binCount: 10 };
const at = (bin: number) => GRID_START_US + bin * 1000;

test("selects the bins a window overlaps", () => {
  expect(binRange(grid, at(2), at(5))).toEqual({ start: 2, end: 5 });
});

test("keeps a bin that overlaps the window only in part", () => {
  expect(binRange(grid, at(1) + 500, at(3) + 500)).toEqual({
    start: 1,
    end: 4,
  });
});

test("excludes a bin starting exactly at endUs", () => {
  expect(binRange(grid, at(0), at(3))).toEqual({ start: 0, end: 3 });
});

test("clamps a window that overruns the level at both ends", () => {
  expect(binRange(grid, 0, at(50))).toEqual({ start: 0, end: 10 });
});

test("yields an empty range for a window outside the level", () => {
  expect(binRange(grid, 0, 500_000)).toEqual({ start: 0, end: 0 });
  expect(binRange(grid, at(20), at(30))).toEqual({ start: 10, end: 10 });
});

test("yields the single bin holding a window narrower than one bin", () => {
  expect(binRange(grid, at(4) + 100, at(4) + 200)).toEqual({
    start: 4,
    end: 5,
  });
});

test("yields an empty range for a zero-width window", () => {
  expect(binRange(grid, at(3), at(3))).toEqual({ start: 3, end: 3 });
});

test("yields an empty range for a level with no bins", () => {
  expect(binRange({ ...grid, binCount: 0 }, at(0), at(5))).toEqual({
    start: 0,
    end: 0,
  });
});

test("rejects a window whose end precedes its start", () => {
  expect(() => binRange(grid, at(5), at(2))).toThrow(RangeError);
});

test("rejects a bin period that is not above zero", () => {
  expect(() => binRange({ ...grid, periodUs: 0 }, at(0), at(5))).toThrow(
    RangeError,
  );
});

const continuousChannel = (
  over: Partial<FixtureChannel> = {},
): FixtureChannel => ({
  path: "0",
  attributes: { ...continuousAttrs },
  levels: [
    { shape: [400], periodUs: 1000 },
    { shape: [100, 2], periodUs: 4000 },
  ],
  ...over,
});

const storeOf = (...channels: FixtureChannel[]) =>
  createMemoryStore({ "/zarr.json": bundleMetadata(channels) });

test("enumerates a channel with its info and its levels", async () => {
  const catalog = await readCatalog(storeOf(continuousChannel()));

  expect(catalog.channels).toHaveLength(1);
  const [entry] = catalog.channels;
  expect(entry?.path).toBe("/0");
  expect(entry?.info.id).toBe("ch-1");
  expect(entry?.info.rateHz).toBe(1000);
  expect(entry?.levels).toEqual([
    { path: "/0/0", periodUs: 1000, binCount: 400, isMinMax: false },
    { path: "/0/1", periodUs: 4000, binCount: 100, isMinMax: true },
  ]);
});

test("derives the channel's end from its raw level", async () => {
  const catalog = await readCatalog(storeOf(continuousChannel()));
  expect(catalog.channels[0]?.info.endUs).toBe(START_US + 400_000);
});

test("keys byId on the channel id, sharing the entries with channels", async () => {
  const catalog = await readCatalog(storeOf(continuousChannel()));
  expect(catalog.byId.get("ch-1")).toBe(catalog.channels[0]);
});

test("returns levels finest first however they are stored", async () => {
  const catalog = await readCatalog(
    storeOf(
      continuousChannel({
        levels: [
          { shape: [100, 2], periodUs: 4000 },
          { shape: [400], periodUs: 1000 },
        ],
      }),
    ),
  );
  expect(catalog.channels[0]?.levels.map((l) => l.periodUs)).toEqual([
    1000, 4000,
  ]);
});

const unitChannel = (over: Partial<FixtureChannel> = {}): FixtureChannel => ({
  path: "2",
  attributes: { ...continuousAttrs, id: "ch-9", kind: "unit" },
  extraArrays: {
    events: [128],
    units: [128],
    waveforms: { shape: [128, 32], attributes: { period_us: 40 } },
  },
  ...over,
});

test("enumerates a unit channel, which has no levels", async () => {
  const catalog = await readCatalog(storeOf(unitChannel()));

  const entry = catalog.byId.get("ch-9");
  expect(entry?.info.kind).toBe("unit");
  expect(entry?.levels).toEqual([]);
  expect(entry?.info.endUs).toBe(START_US);
  expect(entry?.unit).toEqual({
    events: { path: "/2/events", count: 128 },
    waveforms: { path: "/2/waveforms", pointsPerEvent: 32, periodUs: 40 },
  });
});

test("gives a continuous channel no unit arrays", async () => {
  const catalog = await readCatalog(storeOf(continuousChannel()));
  expect(catalog.channels[0]?.unit).toBeUndefined();
});

test("enumerates every channel in a mixed bundle", async () => {
  const catalog = await readCatalog(
    storeOf(continuousChannel(), unitChannel({ path: "1" })),
  );
  expect([...catalog.byId.keys()]).toEqual(["ch-1", "ch-9"]);
});

test("rejects a unit channel with no arrays at all", async () => {
  const store = storeOf(unitChannel({ extraArrays: {} }));
  await expect(readCatalog(store)).rejects.toThrow(/events/);
});

test("rejects a unit channel with no events array", async () => {
  const store = storeOf(
    unitChannel({
      extraArrays: {
        waveforms: { shape: [128, 32], attributes: { period_us: 40 } },
      },
    }),
  );
  await expect(readCatalog(store)).rejects.toThrow(/events/);
});

test("rejects a unit channel whose events array is not rank 1", async () => {
  const store = storeOf(
    unitChannel({
      extraArrays: {
        events: [128, 2],
        waveforms: { shape: [128, 32], attributes: { period_us: 40 } },
      },
    }),
  );
  await expect(readCatalog(store)).rejects.toThrow(/events/);
});

test("rejects a unit channel with no waveforms array", async () => {
  const store = storeOf(unitChannel({ extraArrays: { events: [128] } }));
  await expect(readCatalog(store)).rejects.toThrow(/waveforms/);
});

test("rejects a unit channel whose event and waveform counts disagree", async () => {
  const store = storeOf(
    unitChannel({
      extraArrays: {
        events: [100],
        waveforms: { shape: [128, 32], attributes: { period_us: 40 } },
      },
    }),
  );
  await expect(readCatalog(store)).rejects.toThrow(/100 events but 128/);
});

test("rejects a unit channel whose waveforms carry no usable period", async () => {
  const store = storeOf(
    unitChannel({
      extraArrays: { events: [128], waveforms: { shape: [128, 32] } },
    }),
  );
  await expect(readCatalog(store)).rejects.toThrow(/period_us/);
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

test("ignores metadata entries that are neither channel groups nor levels", async () => {
  const root = JSON.parse(bundleMetadata([continuousChannel()])) as {
    consolidated_metadata: { metadata: Record<string, unknown> };
  };
  const { metadata } = root.consolidated_metadata;
  metadata.junk = 42;
  metadata.sidecar = { node_type: "array", shape: [4], attributes: {} };
  metadata["0/extra/deep"] = { node_type: "array", shape: [4], attributes: {} };
  const store = createMemoryStore({ "/zarr.json": JSON.stringify(root) });

  const catalog = await readCatalog(store);

  expect(catalog.channels).toHaveLength(1);
});

test("rejects a level whose shape is not a list of dimensions", async () => {
  const root = JSON.parse(bundleMetadata([continuousChannel()])) as {
    consolidated_metadata: {
      metadata: Record<string, Record<string, unknown>>;
    };
  };
  const level = root.consolidated_metadata.metadata["0/0"];
  expect(level).toBeDefined();
  if (level) level.shape = "400";
  const store = createMemoryStore({ "/zarr.json": JSON.stringify(root) });

  await expect(readCatalog(store)).rejects.toThrow(/shape/);
});

test("rejects a root that is not a Zarr v3 group", async () => {
  const wrongFormat = createMemoryStore({
    "/zarr.json": bundleMetadata([continuousChannel()], { zarr_format: 2 }),
  });
  await expect(readCatalog(wrongFormat)).rejects.toThrow(/zarr_format/);

  const wrongNode = createMemoryStore({
    "/zarr.json": bundleMetadata([continuousChannel()], { node_type: "array" }),
  });
  await expect(readCatalog(wrongNode)).rejects.toThrow(/node_type/);
});

test("rejects a bundle with no consolidated metadata", async () => {
  const store = createMemoryStore({
    "/zarr.json": bundleMetadata([continuousChannel()], {
      consolidated_metadata: undefined,
    }),
  });
  await expect(readCatalog(store)).rejects.toThrow(/consolidated_metadata/);
});

test("rejects a level whose shape is neither raw nor min/max", async () => {
  const trailingNotTwo = storeOf(
    continuousChannel({ levels: [{ shape: [100, 3], periodUs: 1000 }] }),
  );
  await expect(readCatalog(trailingNotTwo)).rejects.toThrow(/shape/);

  const rankThree = storeOf(
    continuousChannel({ levels: [{ shape: [100, 2, 2], periodUs: 1000 }] }),
  );
  await expect(readCatalog(rankThree)).rejects.toThrow(/shape/);
});

test("rejects a level with no usable period", async () => {
  const store = createMemoryStore({
    "/zarr.json": bundleMetadata([
      continuousChannel({ levels: [{ shape: [400], periodUs: 0 }] }),
    ]),
  });
  await expect(readCatalog(store)).rejects.toThrow(/period_us/);
});

test("rejects a continuous channel with no raw level", async () => {
  const store = storeOf(
    continuousChannel({ levels: [{ shape: [100, 2], periodUs: 4000 }] }),
  );
  await expect(readCatalog(store)).rejects.toThrow(/raw/);
});

test("rejects two channels claiming the same id", async () => {
  const store = storeOf(continuousChannel(), continuousChannel({ path: "1" }));
  await expect(readCatalog(store)).rejects.toThrow(/ch-1/);
});

test("surfaces a malformed channel attribute, naming it", async () => {
  const attributes: Record<string, unknown> = { ...continuousAttrs };
  delete attributes.unit;
  const store = storeOf(continuousChannel({ attributes }));
  await expect(readCatalog(store)).rejects.toThrow(/unit/);
});

test("agrees with trimToBounds about which bins a window overlaps", () => {
  const windows: Array<[number, number]> = [
    [at(2), at(5)],
    [at(1) + 500, at(3) + 500],
    [at(0), at(3)],
    [0, at(50)],
    [at(20), at(30)],
  ];

  for (const [windowStartUs, windowEndUs] of windows) {
    const { start, end } = binRange(grid, windowStartUs, windowEndUs);
    const trimmed = trimToBounds(
      makeSegment({
        startUs: grid.startUs,
        samplePeriodUs: grid.periodUs,
        data: new Float64Array(grid.binCount),
      }),
      windowStartUs,
      windowEndUs,
    );

    expect(trimmed.data.length).toBe(end - start);
    if (end > start) {
      expect(trimmed.startUs).toBe(grid.startUs + start * grid.periodUs);
    }
  }
});
