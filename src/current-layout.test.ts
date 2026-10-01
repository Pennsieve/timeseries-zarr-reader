import { describe, expect, test } from "vitest";
import { readCatalog } from "./catalog.js";
import { StreamingClient } from "./client.js";
import {
  arrayMetadata,
  collect,
  createMemoryStore,
  float32Chunk,
} from "./test-utils.js";

// A bundle in the layout bundle-format.md specifies: raw samples in a named `raw` array,
// each level a numbered group carrying period_us with its min/max pairs in `env`, and an
// annotation channel of kind `event` beside the signal.
const SAMPLES = [1, 2, 3, 4, 5, 6, 7, 8];
const PAIRS = [1, 4, 5, 8];

const group = (attributes: Record<string, unknown>) => ({
  zarr_format: 3,
  node_type: "group",
  attributes,
});
const array = (
  shape: number[],
  dataType = "float32",
): Record<string, unknown> =>
  JSON.parse(arrayMetadata(shape, shape, {}, dataType)) as Record<
    string,
    unknown
  >;

function currentLayoutStore(extra: Record<string, unknown> = {}) {
  const metadata: Record<string, unknown> = {
    "0": group({
      id: "ch-1",
      name: "RP08",
      unit: "uV",
      rate_hz: 1000,
      offset_us: 2000,
      kind: "continuous",
    }),
    "0/raw": array([8]),
    "0/1": group({ period_us: 4000 }),
    "0/1/env": array([2, 2]),
    "0/1/mean": array([2]),
    "0/1/valid": array([2], "uint16"),
    "1": group({
      id: "clinical-marks",
      name: "Clinical marks",
      offset_us: 0,
      kind: "event",
    }),
    "1/events": array([3], "int64"),
    "1/labels": array([3], "uint16"),
    "1/1": group({ period_us: 4000 }),
    "1/1/counts": array([2], "uint32"),
    ...extra,
  };

  return createMemoryStore({
    "/zarr.json": JSON.stringify({
      zarr_format: 3,
      node_type: "group",
      attributes: {},
      consolidated_metadata: {
        kind: "inline",
        must_understand: false,
        metadata,
      },
    }),
    "/0/raw/zarr.json": arrayMetadata([8]),
    "/0/raw/c/0": float32Chunk(SAMPLES),
    "/0/1/env/zarr.json": arrayMetadata([2, 2]),
    "/0/1/env/c/0/0": float32Chunk(PAIRS),
  });
}

describe("current bundle layout", () => {
  test("reads raw as the finest level and each group's env as a min/max level", async () => {
    const catalog = await readCatalog(currentLayoutStore());
    expect(catalog.channels.map((c) => c.info.id)).toEqual(["ch-1"]);
    expect(catalog.channels[0]!.levels).toEqual([
      { path: "/0/raw", periodUs: 1000, binCount: 8, isMinMax: false },
      { path: "/0/1/env", periodUs: 4000, binCount: 2, isMinMax: true },
    ]);
  });

  test("takes startUs from offset_us and derives endUs from raw", async () => {
    const catalog = await readCatalog(currentLayoutStore());
    const info = catalog.channels[0]!.info;
    expect(info.startUs).toBe(2000);
    expect(info.endUs).toBe(2000 + 8 * 1000);
  });

  test("keeps event channels out of the signal channels", async () => {
    const catalog = await readCatalog(currentLayoutStore());
    expect(catalog.byId.has("clinical-marks")).toBe(false);
  });

  test("ignores a level group that has no env member", async () => {
    const catalog = await readCatalog(
      currentLayoutStore({ "0/2": group({ period_us: 16000 }) }),
    );
    expect(catalog.channels[0]!.levels.map((l) => l.path)).toEqual([
      "/0/raw",
      "/0/1/env",
    ]);
  });

  test("rejects a raw array when the channel has no rate_hz", async () => {
    const store = currentLayoutStore({
      "0": group({
        id: "ch-1",
        name: "RP08",
        unit: "uV",
        offset_us: 0,
        kind: "continuous",
      }),
    });
    await expect(readCatalog(store)).rejects.toThrow(/rate_hz/);
  });

  test("serves raw samples and envelope pairs from their new paths", async () => {
    const client = new StreamingClient({ store: currentLayoutStore() });
    const window = { channels: ["ch-1"], startUs: 2000, endUs: 10_000 };

    const [raw] = await collect(
      client.query({ ...window, pixelWidthUs: 1000 }),
    );
    expect(raw!.isMinMax).toBe(false);
    expect(Array.from(raw!.data)).toEqual(SAMPLES);

    const [env] = await collect(
      client.query({ ...window, pixelWidthUs: 4000 }),
    );
    expect(env!.isMinMax).toBe(true);
    expect(Array.from(env!.data)).toEqual(PAIRS);
  });
});
