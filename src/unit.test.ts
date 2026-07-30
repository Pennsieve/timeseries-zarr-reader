import { expect, test } from "vitest";
import type { UnitArrays } from "./catalog.js";
import { bundleFiles, createMemoryStore } from "./test-utils.js";
import type { TimestampReader } from "./zarr.js";
import {
  firstIndexAtOrAfter,
  queryUnitChannel,
  shouldFetchWaveforms,
} from "./unit.js";

/** A reader over an in-memory list, for driving the search without a store. */
const readerOf = (times: number[]): TimestampReader => ({
  count: times.length,
  read: (start, end) =>
    Promise.resolve(Float64Array.from(times.slice(start, end))),
});

test("fetches waveforms only when one waveform spans enough pixels", () => {
  // 32 points at 40 us = a 1280 us waveform; the threshold is 10 pixels.
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

test("returns the FIRST of duplicate timestamps, not whichever probe hits", async () => {
  // Simultaneous events share a microsecond; landing mid-run would drop the earlier ones.
  const reader = readerOf([1000, 5000, 5000, 5000, 9000]);
  expect(await firstIndexAtOrAfter(reader, 5000)).toBe(1);
  expect(await firstIndexAtOrAfter(readerOf([5000, 5000, 5000]), 5000)).toBe(0);
});

const UNIT: UnitArrays = {
  events: { path: "/5/events", count: 4 },
  waveforms: { path: "/5/waveforms", pointsPerEvent: 3, periodUs: 100 },
};

const store = createMemoryStore(
  bundleFiles([
    {
      path: "5",
      attributes: {
        id: "u",
        name: "Unit 1",
        unit: "uV",
        rate_hz: 10_000,
        start_us: 1_000_000,
        kind: "unit",
      },
      events: [1_002_000, 1_005_000, 1_005_500, 1_009_000],
      waveforms: {
        periodUs: 100,
        pointsPerEvent: 3,
        samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      },
    },
  ]),
);

test("reads the events inside a window, end exclusive", async () => {
  const event = await queryUnitChannel(store, "u", UNIT, {
    startUs: 1_003_000,
    endUs: 1_009_000,
    pixelWidthUs: 1000,
  });

  expect(event.channel).toBe("u");
  expect(event.startUs).toBe(1_003_000);
  expect(event.endUs).toBe(1_009_000);
  expect(Array.from(event.times)).toEqual([1_005_000, 1_005_500]);
  expect(event.samplePeriodUs).toBe(100);
  expect(event.pointsPerEvent).toBe(0);
  expect(event.data.length).toBe(0);
  expect(event.isResampled).toBe(false);
});

test("includes an event exactly at the window start", async () => {
  const event = await queryUnitChannel(store, "u", UNIT, {
    startUs: 1_005_000,
    endUs: 1_009_000,
    pixelWidthUs: 1000,
  });
  expect(Array.from(event.times)).toEqual([1_005_000, 1_005_500]);
});

test("fetches the matching waveform rows when zoomed in far enough", async () => {
  // One waveform is 3 x 100 us = 300 us; a 20 us pixel puts it across 15 pixels.
  const event = await queryUnitChannel(store, "u", UNIT, {
    startUs: 1_003_000,
    endUs: 1_009_000,
    pixelWidthUs: 20,
  });

  expect(event.pointsPerEvent).toBe(3);
  expect(Array.from(event.data)).toEqual([4, 5, 6, 7, 8, 9]);
});

test("reports an empty window as no events and no waveforms", async () => {
  const event = await queryUnitChannel(store, "u", UNIT, {
    startUs: 2_000_000,
    endUs: 2_100_000,
    pixelWidthUs: 20,
  });

  expect(event.times.length).toBe(0);
  expect(event.data.length).toBe(0);
  expect(event.pointsPerEvent).toBe(0);
});
