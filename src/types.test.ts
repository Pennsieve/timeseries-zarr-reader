import { expect, expectTypeOf, test } from "vitest";
import type {
  ByteRange,
  ChannelInfo,
  Event,
  FilterSpec,
  MontagePair,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";

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
});

test("MontagePair has the documented shape", () => {
  expectTypeOf<MontagePair>().toEqualTypeOf<{
    readonly lead: string;
    readonly secondary: string;
  }>();
});

test("FilterSpec discriminates cutoff fields by type", () => {
  const lowpass: FilterSpec = { type: "lowpass", order: 2, cutoffHz: 40 };
  const bandpass: FilterSpec = {
    type: "bandpass",
    order: 4,
    lowHz: 1,
    highHz: 40,
  };
  if (lowpass.type === "lowpass") {
    expectTypeOf(lowpass.cutoffHz).toBeNumber();
  }
  if (bandpass.type === "bandpass") {
    expectTypeOf(bandpass.lowHz).toBeNumber();
    expectTypeOf(bandpass.highHz).toBeNumber();
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
});

test("Store reads whole keys and ranges, returning bytes or undefined", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const store: Store = {
    get: async (key) => (key === "/zarr.json" ? bytes : undefined),
    getRange: async (key, range) =>
      key === "/zarr.json" || !("offset" in range)
        ? bytes.slice(0, 2)
        : undefined,
  };
  expectTypeOf<Awaited<ReturnType<Store["get"]>>>().toEqualTypeOf<
    Uint8Array | undefined
  >();
  expectTypeOf<Awaited<ReturnType<Store["getRange"]>>>().toEqualTypeOf<
    Uint8Array | undefined
  >();

  await expect(store.get("/zarr.json")).resolves.toEqual(bytes);
  await expect(store.get("/missing")).resolves.toBeUndefined();
  await expect(
    store.getRange("/zarr.json", { offset: 0, length: 2 }),
  ).resolves.toEqual(new Uint8Array([1, 2]));
  await expect(
    store.getRange("/missing", { offset: 0, length: 2 }),
  ).resolves.toBeUndefined();
});

test("Store declares the whole-key and ranged read surface", () => {
  // Mirrors zarrita's AsyncReadable with getRange required. The zarr.ts call
  // site that hands a Store to zarrita fails to compile if the two drift.
  expectTypeOf<Store>().toEqualTypeOf<{
    get(
      key: `/${string}`,
      opts?: StoreOptions,
    ): Promise<Uint8Array | undefined>;
    getRange(
      key: `/${string}`,
      range: ByteRange,
      opts?: StoreOptions,
    ): Promise<Uint8Array | undefined>;
  }>();
});
