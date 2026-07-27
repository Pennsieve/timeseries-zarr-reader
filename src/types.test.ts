import { test, expect, expectTypeOf } from "vitest";
import type {
  ChannelInfo,
  Event,
  FilterSpec,
  MontagePair,
  Segment,
  Store,
} from "./types";

test("Segment has the documented shape", () => {
  const seg: Segment = {
    channel: "ch1",
    startUs: 0,
    samplePeriodUs: 1000,
    isMinMax: false,
    data: new Float64Array([1, 2, 3]),
  };
  expectTypeOf(seg.data).toEqualTypeOf<Float64Array>();
  expectTypeOf<Segment["isMinMax"]>().toBeBoolean();
  expect(seg.data.length).toBe(3);
});

test("ChannelInfo has the documented shape", () => {
  const info: ChannelInfo = {
    id: "ch1",
    name: "Fp1",
    unit: "uV",
    rateHz: 250,
    startUs: 0,
    endUs: 4_000_000,
    kind: "continuous",
  };
  expectTypeOf(info.rateHz).toBeNumber();
  expectTypeOf<ChannelInfo["kind"]>().toEqualTypeOf<"continuous" | "unit">();
  expect(info.kind).toBe("continuous");
});

test("MontagePair has the documented shape", () => {
  const pair: MontagePair = { lead: "ch1", secondary: "ch2" };
  expectTypeOf<MontagePair>().toEqualTypeOf<{
    lead: string;
    secondary: string;
  }>();
  expect(pair).toEqual({ lead: "ch1", secondary: "ch2" });
});

test("FilterSpec discriminates cutoff fields by type", () => {
  const lowpass: FilterSpec = { type: "lowpass", order: 2, cutoffHz: 40 };
  const bandpass: FilterSpec = {
    type: "bandpass",
    order: 4,
    lowHz: 1,
    highHz: 40,
  };
  expect(lowpass.type).toBe("lowpass");
  expect(bandpass.type).toBe("bandpass");
  // The discriminant narrows to the band-specific cutoff fields.
  if (bandpass.type === "bandpass") {
    expect(bandpass.lowHz).toBe(1);
    expect(bandpass.highHz).toBe(40);
  }
  expectTypeOf<FilterSpec["type"]>().toEqualTypeOf<
    "lowpass" | "highpass" | "bandpass" | "bandstop"
  >();
});

test("Event has the documented shape", () => {
  const ev: Event = {
    channel: "unit-3",
    startUs: 0,
    endUs: 1_000_000,
    samplePeriodUs: 40,
    pointsPerEvent: 0,
    isResampled: false,
    times: new Float64Array([1000, 2000]),
    data: new Float64Array([]),
  };
  expectTypeOf(ev.times).toEqualTypeOf<Float64Array>();
  expectTypeOf(ev.data).toEqualTypeOf<Float64Array>();
  expect(ev.channel).toBe("unit-3");
  expect(ev.pointsPerEvent).toBe(0);
});

test("Store is a get(key)-shaped readable that returns bytes or undefined", async () => {
  const store: Store = {
    get: async (key) =>
      key === "/zarr.json" ? new Uint8Array([1]) : undefined,
  };
  expectTypeOf<Awaited<ReturnType<Store["get"]>>>().toEqualTypeOf<
    Uint8Array | undefined
  >();
  await expect(store.get("/zarr.json")).resolves.toEqual(new Uint8Array([1]));
  await expect(store.get("/missing")).resolves.toBeUndefined();
});

test("Store mirrors a zarrita Readable-like shape", () => {
  // Local mimic of zarrita's Readable; replaced by a real conformance check in zarr.ts.
  type ReadableLike = {
    get(key: `/${string}`, opts?: unknown): Promise<Uint8Array | undefined>;
  };
  expectTypeOf<Store>().toEqualTypeOf<ReadableLike>();
});
