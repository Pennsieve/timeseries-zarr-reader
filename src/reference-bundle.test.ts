/**
 * Reads the TS-Zarr reference bundle the timeseries-zarr-paper repository publishes,
 * `testdata/synthetic.tszarr`, which its seeded generator validates against the
 * specification. The bundle exercises every array the format defines, including the
 * ones the committed sample lacks: per-event waveforms, `values`, `var`, and a channel
 * with NaN dropouts.
 *
 * Skipped when the bundle is not on disk. Set TSZ_REFERENCE_BUNDLE to point at it,
 * or check the paper repository out beside this one.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collect } from "./test-utils.js";
import { openBundle, StreamingClient } from "./index.js";

const BUNDLE =
  process.env.TSZ_REFERENCE_BUNDLE ??
  fileURLToPath(
    new URL(
      "../../timeseries-zarr-paper/testdata/synthetic.tszarr",
      import.meta.url,
    ),
  );

const SECOND = 1_000_000;

describe.skipIf(!existsSync(BUNDLE))("acceptance: reference bundle", () => {
  const open = async () => {
    const client = new StreamingClient({ store: await openBundle(BUNDLE) });
    return { client, infos: await client.channelInfo() };
  };

  test("lists the six channels and the recording's origin", async () => {
    const { client, infos } = await open();

    expect(infos.map((info) => [info.index, info.kind])).toEqual([
      [0, "continuous"],
      [1, "continuous"],
      [2, "continuous"],
      [3, "event"],
      [4, "event"],
      [5, "event"],
    ]);
    const slow = infos[1]!;
    expect(slow.kind === "continuous" && slow.startUs).toBe(500_000);
    expect(slow.kind === "continuous" && slow.rateHz).toBe(256);

    // The paper's bundle still writes the pre-1.0 `start` key for the reference
    // time, which 1.0 does not define, so the reader ignores it.
    const recording = await client.recording();
    expect(recording?.referenceTime).toBeUndefined();
    expect(recording?.subject).toMatchObject({ id: "sub-synth01" });
  });

  test("serves the whole recording from the coarsest level at one pixel per bin", async () => {
    const { client, infos } = await open();
    const eeg = infos[0]!;
    if (eeg.kind !== "continuous")
      throw new Error("channel 0 is not continuous");

    // Level 5 of a 1024 Hz channel is 4^5 / 1024 = 1 s per bin.
    const [segment] = await collect(
      client.query({
        channels: [eeg.id],
        startUs: eeg.startUs,
        endUs: eeg.endUs,
        pixelWidthUs: SECOND,
      }),
    );
    expect(segment?.isMinMax).toBe(true);
    expect(segment?.samplePeriodUs).toBe(SECOND);
    expect(segment?.data.length).toBe(600 * 2);
    expect(Array.from(segment!.data).every(Number.isFinite)).toBe(true);
  });

  test("finds the dropouts of channel 2 from its count member, not its bad sample", async () => {
    const { client, infos } = await open();
    const gappy = infos[2]!;
    if (gappy.kind !== "continuous")
      throw new Error("channel 2 is not continuous");

    const spans = await client.dataSpans({
      channel: gappy.id,
      startUs: gappy.startUs,
      endUs: gappy.endUs,
    });
    // The 4.5 s dropout at 120 s splits the recording. The 0.8 s dropout at 400.2 s
    // and the single bad sample at 250 s each sit inside one 2 s bin of the coarsest
    // level that still recorded samples, so `count` keeps those bins covered.
    expect(spans).toEqual([
      [0, 120 * SECOND],
      [124 * SECOND, 600 * SECOND],
    ]);
  });

  test("reads sorted units: labelled spikes with snippets, mean waveforms, and counts", async () => {
    const { client, infos } = await open();
    const units = infos[3]!;
    if (units.kind !== "event")
      throw new Error("channel 3 is not an event channel");
    expect(units.eventCount).toBe(8099);
    expect(units.columns).toEqual(["labels", "waveforms"]);
    expect(units.labelNames).toHaveLength(5);
    expect(units.countLevels).toBe(2);

    const [window] = await collect(
      client.queryEvents({
        channels: [units.id],
        startUs: 0,
        endUs: 10 * SECOND,
        pixelWidthUs: 10,
      }),
    );
    expect(window!.times.length).toBeGreaterThan(0);
    expect(Array.from(window!.labels!).every((label) => label < 5)).toBe(true);
    expect(window!.waveforms).toMatchObject({
      pointsPerEvent: 32,
      eventSample: 12,
    });
    expect(window!.waveforms!.data.length).toBe(window!.times.length * 32);

    const mean = await client.waveformMean({ channel: units.id });
    expect(mean?.data.length).toBe(5 * 32);
    expect(mean?.eventSample).toBe(12);

    // Every spike lands in exactly one bin of level 1.
    const counts = await client.eventCounts({
      channel: units.id,
      startUs: 0,
      endUs: 600 * SECOND,
      pixelWidthUs: 256_000,
    });
    expect(counts.level).toBe(1);
    expect(counts.labelCount).toBe(5);
    expect(counts.counts.reduce((sum, count) => sum + count, 0)).toBe(8099);
  });

  test("reads curated marks: intervals, text, and channel scope", async () => {
    const { client, infos } = await open();
    const marks = infos[4]!;
    if (marks.kind !== "event")
      throw new Error("channel 4 is not an event channel");
    expect(marks.columns).toEqual(["durations", "labels", "text", "channels"]);
    expect(marks.maxDurationUs).toBe(90 * SECOND);

    const [window] = await collect(
      client.queryEvents({
        channels: [marks.id],
        startUs: 0,
        endUs: 600 * SECOND,
      }),
    );
    expect(window!.times.length).toBe(14);
    expect(Math.max(...window!.durations!)).toBe(90 * SECOND);
    expect(window!.text!.every((text) => text.length > 0)).toBe(true);
    const channelIds = new Set(infos.map((info) => info.id));
    for (const scope of window!.channels!) {
      for (const id of scope) {
        expect(channelIds.has(id)).toBe(true);
      }
    }
  });

  test("reads detector output: a score per event and JSON text", async () => {
    const { client, infos } = await open();
    const detector = infos[5]!;
    if (detector.kind !== "event")
      throw new Error("channel 5 is not an event channel");
    expect(detector.columns).toEqual(["labels", "values", "text", "channels"]);
    expect(detector.unit).toBeDefined();

    const [window] = await collect(
      client.queryEvents({
        channels: [detector.id],
        startUs: 0,
        endUs: 60 * SECOND,
        columns: ["values", "text"],
      }),
    );
    expect(window!.values!.length).toBe(window!.times.length);
    expect(window!.labels).toBeUndefined();
    for (const text of window!.text!) {
      expect(typeof JSON.parse(text)).toBe("object");
    }
  });
});
