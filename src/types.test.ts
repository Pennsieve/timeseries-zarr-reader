import { expect, expectTypeOf, test } from "vitest";
import type {
  ByteRange,
  ChannelInfo,
  ContinuousChannelInfo,
  EventChannelInfo,
  EventCounts,
  EventWindow,
  FilterSpec,
  MontagePair,
  ReadPriority,
  RecordingInfo,
  Segment,
  Store,
  StoreOptions,
  Waveforms,
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

test("ChannelInfo discriminates continuous and event channels on kind", () => {
  const continuous: ChannelInfo = {
    kind: "continuous",
    index: 0,
    id: "ch1",
    name: "Fp1",
    unit: "uV",
    rateHz: 250,
    startUs: 0,
    endUs: 4_000_000,
    runs: 1,
  };
  const event: ChannelInfo = {
    kind: "event",
    index: 1,
    id: "marks",
    name: "marks",
    eventCount: 3,
    columns: ["durations", "text"],
    labelNames: ["onset"],
    maxDurationUs: 60_000_000,
    hasWaveformMean: false,
    countLevels: 0,
  };
  if (continuous.kind === "continuous") {
    expectTypeOf(continuous).toEqualTypeOf<ContinuousChannelInfo>();
    expectTypeOf(continuous.rateHz).toBeNumber();
  }
  if (event.kind === "event") {
    expectTypeOf(event).toEqualTypeOf<EventChannelInfo>();
    expectTypeOf(event.eventCount).toBeNumber();
  }
  expectTypeOf<ChannelInfo["kind"]>().toEqualTypeOf<"continuous" | "event">();
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

test("EventWindow carries times plus optional columns", () => {
  const waveforms: Waveforms = {
    pointsPerEvent: 2,
    periodUs: 40,
    eventSample: 0,
    data: new Float64Array([1, 2, 3, 4]),
  };
  const window: EventWindow = {
    channel: "unit-3",
    startUs: 0,
    endUs: 1_000_000,
    times: new Float64Array([1000, 2000]),
    labels: new Uint16Array([0, 1]),
    text: ["a", "b"],
    channels: [["ch1"], []],
    waveforms,
  };
  expectTypeOf(window.times).toEqualTypeOf<Float64Array>();
  expectTypeOf(window.durations).toEqualTypeOf<Float64Array | undefined>();
  expectTypeOf(window.waveforms?.data).toEqualTypeOf<
    Float64Array | undefined
  >();
});

test("EventCounts and RecordingInfo have the documented shapes", () => {
  const counts: EventCounts = {
    channel: "unit-3",
    level: 1,
    startUs: 0,
    periodUs: 256_000,
    labelCount: 2,
    counts: new Uint32Array([1, 0]),
  };
  expectTypeOf(counts.counts).toEqualTypeOf<Uint32Array>();
  const recording: RecordingInfo = {
    referenceTime: "1970-01-01T00:00:00Z",
    referenceTimeUs: 0,
  };
  expectTypeOf(recording.referenceTimeUs).toEqualTypeOf<number | undefined>();
});

test("ReadPriority has the documented values", () => {
  expectTypeOf<ReadPriority>().toEqualTypeOf<
    "viewport" | "prefetch" | "background"
  >();
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
