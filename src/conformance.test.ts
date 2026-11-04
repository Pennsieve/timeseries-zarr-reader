/**
 * Reads the conformance fixtures of the TS-Zarr specification and checks the reader
 * returns the values their manifest states.
 *
 * `test-data/conformance/` holds the bundles and `manifest.json`.
 * `scripts/sync-conformance-fixtures.py` regenerates them from
 * `timeseries-zarr-py`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collect } from "./test-utils.js";
import type { ChannelInfo, EventColumn } from "./index.js";
import { openBundle, StreamingClient } from "./index.js";

const DIR = fileURLToPath(new URL("../test-data/conformance", import.meta.url));

interface ManifestContinuous {
  index: number;
  kind: "continuous";
  name: string;
  id: string;
  unit: string;
  rate_hz: number;
  offset_us: number;
  num_samples: number;
  runs: number[][] | null;
  samples: Array<{ index: number; value: number | null }>;
  levels: Array<{
    level: number;
    period_us: number;
    bins: number;
    bin_values: Array<{
      index: number;
      min: number | null;
      max: number | null;
      count: number;
      mean: number | null;
      var?: number | null;
    }>;
  }>;
}

interface ManifestEvent {
  index: number;
  kind: "event";
  name: string;
  id: string;
  unit?: string;
  label_names?: string[] | null;
  num_labels: number;
  max_duration_us: number | null;
  num_events: number;
  events: number[];
  durations?: number[];
  labels?: number[];
  values?: number[];
  text?: string[];
  channels?: number[][];
  waveform?: {
    samples: number;
    period_us: number;
    event_sample: number;
    waveforms: Array<Array<number | null>>;
    waveform_mean: Array<Array<number | null>>;
  };
  columns: EventColumn[];
  count_levels: Array<{
    level: number;
    period_us: number;
    offset_us: number;
    bins: number;
    count: number[][];
  }>;
}

interface Fixture {
  path: string;
  exercises: string;
  version: string;
  recording_json: Record<string, unknown> | null;
  reader_must_reject: boolean;
  channels?: Array<ManifestContinuous | ManifestEvent>;
}

interface Manifest {
  spec_version: string;
  fixtures: Record<string, Fixture>;
}

const MANIFEST = join(DIR, "manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
const fixtures = Object.entries(manifest.fixtures);

/** The manifest writes NaN as null. */
const number = (value: number | null): number => value ?? NaN;
const numbers = (values: Array<number | null>): number[] => values.map(number);

/**
 * Checks `actual` against a manifest `mean` or `var`: NaN matches NaN, and any other
 * value matches within 2^-20 relative.
 */
function expectWithinTolerance(
  actual: number | undefined,
  expected: number | null,
): void {
  if (expected === null) {
    expect(actual).toBeNaN();
    return;
  }
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(
    2 ** -20 * Math.abs(expected),
  );
}

describe("conformance fixtures", () => {
  const open = async (fixture: Fixture) =>
    new StreamingClient({ store: await openBundle(join(DIR, fixture.path)) });

  const idOf = (infos: ChannelInfo[], index: number): string =>
    infos.find((info) => info.index === index)?.id ?? String(index);

  async function checkContinuous(
    client: StreamingClient,
    infos: ChannelInfo[],
    channel: ManifestContinuous,
  ): Promise<void> {
    const periodUs = 1e6 / channel.rate_hz;
    const info = infos.find((candidate) => candidate.index === channel.index);
    expect(info).toMatchObject({
      kind: "continuous",
      name: channel.name,
      id: channel.id,
      unit: channel.unit,
      rateHz: channel.rate_hz,
      startUs: channel.offset_us,
      runs: channel.runs?.length ?? (channel.num_samples > 0 ? 1 : 0),
    });
    if (info?.kind !== "continuous") throw new Error("unreachable");
    // A channel with runs ends where its last run does.
    const lastRun = channel.runs?.[channel.runs.length - 1];
    expect(info.endUs).toBeCloseTo(
      lastRun === undefined
        ? channel.offset_us + channel.num_samples * periodUs
        : lastRun[2]! + lastRun[1]! * periodUs,
      6,
    );

    // 1. Raw samples, read whole: one segment per run at the run's time. A sample
    // between runs is not delivered.
    if (channel.num_samples > 0) {
      const table = channel.runs ?? [
        [0, channel.num_samples, channel.offset_us],
      ];
      const segments = await collect(
        client.query({
          channels: [info.id],
          startUs: info.startUs,
          endUs: info.endUs,
          pixelWidthUs: periodUs,
          raw: true,
        }),
      );
      expect(segments.map((segment) => segment.startUs)).toEqual(
        table.map((run) => run[2]),
      );
      expect(segments.map((segment) => segment.data.length)).toEqual(
        table.map((run) => run[1]),
      );
      for (const { index, value } of channel.samples) {
        const row = table.findIndex(
          ([first, count]) => index >= first! && index < first! + count!,
        );
        if (row < 0) {
          expect(value).toBeNull();
        } else {
          expect(segments[row]!.data[index - table[row]![0]!]).toBe(
            number(value),
          );
        }
      }
    }

    // 2. Runs, exact to the microsecond.
    const runs = await client.runs({ channel: info.id });
    if (channel.runs === null) {
      expect(runs).toHaveLength(channel.num_samples > 0 ? 1 : 0);
    } else {
      expect(runs).toHaveLength(channel.runs.length);
      channel.runs.forEach(([firstSample, sampleCount, startUs], row) => {
        expect(runs[row]).toMatchObject({ firstSample, sampleCount, startUs });
        expect(runs[row]!.endUs).toBeCloseTo(
          startUs! + sampleCount! * periodUs,
          6,
        );
      });
    }

    // 3. Each level, selected by a pixel exactly one bin wide.
    for (const level of channel.levels) {
      const [segment] = await collect(
        client.query({
          channels: [info.id],
          startUs: info.startUs,
          endUs: info.endUs,
          pixelWidthUs: level.period_us,
          members: ["mean", "var", "count"],
        }),
      );
      expect(segment).toMatchObject({
        isMinMax: true,
        samplePeriodUs: level.period_us,
        startUs: info.startUs,
      });
      expect(segment!.data.length).toBe(level.bins * 2);
      for (const bin of level.bin_values) {
        expect(segment!.data[2 * bin.index]).toBe(number(bin.min));
        expect(segment!.data[2 * bin.index + 1]).toBe(number(bin.max));
        expect(segment!.count![bin.index]).toBe(bin.count);
        expectWithinTolerance(segment!.mean![bin.index], bin.mean);
        if (bin.var === undefined) {
          expect(segment!.variance).toBeUndefined();
        } else {
          expectWithinTolerance(segment!.variance![bin.index], bin.var);
        }
      }
    }
  }

  async function checkEvent(
    client: StreamingClient,
    infos: ChannelInfo[],
    channel: ManifestEvent,
  ): Promise<void> {
    const info = infos.find((candidate) => candidate.index === channel.index);
    expect(info).toMatchObject({
      kind: "event",
      name: channel.name,
      id: channel.id,
      eventCount: channel.num_events,
      columns: channel.columns,
      hasWaveformMean: channel.waveform?.waveform_mean !== undefined,
      countLevels: channel.count_levels.length,
    });
    if (info?.kind !== "event") throw new Error("unreachable");
    expect(info.unit).toBe(channel.unit);
    expect(info.labelNames).toEqual(channel.label_names ?? undefined);
    expect(info.maxDurationUs).toBe(channel.max_duration_us ?? undefined);

    // 1. Every event, with every column, over a window around them all.
    const first = channel.events[0] ?? 0;
    const last = channel.events[channel.events.length - 1] ?? 0;
    const [window] = await collect(
      client.queryEvents({
        channels: [info.id],
        startUs: first - 1,
        endUs: last + 1,
      }),
    );
    expect(Array.from(window!.times)).toEqual(channel.events);
    const column = <T>(name: EventColumn, read: () => T): T | undefined =>
      channel.columns.includes(name) ? read() : undefined;
    expect(column("durations", () => Array.from(window!.durations!))).toEqual(
      channel.durations,
    );
    expect(column("labels", () => Array.from(window!.labels!))).toEqual(
      channel.labels,
    );
    expect(column("values", () => Array.from(window!.values!))).toEqual(
      channel.values,
    );
    expect(column("text", () => window!.text)).toEqual(channel.text);
    expect(column("channels", () => window!.channels)).toEqual(
      channel.channels?.map((indices) =>
        indices.map((index) => idOf(infos, index)),
      ),
    );
    const waveform = channel.waveform;
    if (channel.columns.includes("waveforms") && channel.num_events > 0) {
      expect(window!.waveforms).toMatchObject({
        pointsPerEvent: waveform!.samples,
        periodUs: waveform!.period_us,
        eventSample: waveform!.event_sample,
      });
      expect(Array.from(window!.waveforms!.data)).toEqual(
        waveform!.waveforms.flatMap(numbers),
      );
    }

    // 2. The mean waveform per label.
    const mean = await client.waveformMean({ channel: info.id });
    if (waveform?.waveform_mean === undefined) {
      expect(mean).toBeUndefined();
    } else {
      expect(mean).toMatchObject({
        pointsPerEvent: waveform.samples,
        periodUs: waveform.period_us,
        eventSample: waveform.event_sample,
      });
      expect(Array.from(mean!.data)).toEqual(
        waveform.waveform_mean.flatMap(numbers),
      );
    }

    // 3. Each count level, whole, selected by a pixel one bin wide.
    for (const level of channel.count_levels) {
      const counts = await client.eventCounts({
        channel: info.id,
        startUs: level.offset_us,
        endUs: level.offset_us + level.bins * level.period_us,
        pixelWidthUs: level.period_us,
      });
      expect(counts).toMatchObject({
        level: level.level,
        startUs: level.offset_us,
        periodUs: level.period_us,
        labelCount: channel.num_labels,
      });
      expect(Array.from(counts.counts)).toEqual(level.count.flat());
    }
  }

  for (const [name, fixture] of fixtures) {
    test(name, async () => {
      const client = await open(fixture);
      if (fixture.reader_must_reject) {
        await expect(client.channelInfo()).rejects.toThrow();
        return;
      }

      // An invalid bundle a reader may still open lists no channel values.
      const infos = await client.channelInfo();
      if (fixture.channels === undefined) {
        return;
      }
      expect(infos).toHaveLength(fixture.channels.length);
      for (const channel of fixture.channels) {
        if (channel.kind === "continuous") {
          await checkContinuous(client, infos, channel);
        } else {
          await checkEvent(client, infos, channel);
        }
      }

      const recording = await client.recording();
      if (fixture.recording_json === null) {
        expect(recording).toBeUndefined();
      } else {
        expect(recording?.referenceTime).toBe(
          fixture.recording_json.reference_time,
        );
        expect(recording?.session).toEqual(fixture.recording_json.session);
      }
    });
  }
});
