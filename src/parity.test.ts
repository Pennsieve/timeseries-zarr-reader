/**
 * Reads the windows recorded in `test-data/parity.json` through the public API and
 * checks each result against what the Python reader returned for the same window.
 *
 * `scripts/generate-parity-golden.py` regenerates the golden file from
 * `timeseries-zarr-py`. A window that the reader does not yet match falls under one of
 * `REASONS` and runs with `test.fails`, so fixing the reader turns the case red until it
 * leaves its group.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collect } from "./test-utils.js";
import type { ChannelInfo, EventColumn, Segment } from "./index.js";
import { openBundle, StreamingClient } from "./index.js";

const DATA = fileURLToPath(new URL("../test-data", import.meta.url));

/** Columns of a recorded window. A null number stands for NaN. */
type Columns = Record<string, unknown[]>;

interface GoldenWindow {
  id: string;
  label: string;
  start_us: number;
  end_us: number;
  len: number;
  rows: Columns;
  tail?: Columns;
}

interface GoldenGridWindow extends GoldenWindow {
  level: number;
  first: number;
  period_us: number;
  time_us0: number | null;
  spec_start_us: number;
}

interface GoldenSpans {
  id: string;
  start_us: number;
  end_us: number;
  gap_us: number;
  spans: Array<[number, number]>;
}

interface GoldenContinuous {
  index: number;
  id: string;
  kind: "continuous";
  rate_hz: number;
  offset_us: number;
  num_samples: number;
  end_us: number;
  runs: Array<[number, number, number]> | null;
  levels: Array<{ level: number; period_us: number; bins: number }>;
  cases: GoldenGridWindow[];
  spans: GoldenSpans[];
}

interface GoldenEvent {
  index: number;
  id: string;
  kind: "event";
  columns: EventColumn[];
  num_labels: number;
  count_levels: Array<{
    level: number;
    period_us: number;
    offset_us: number;
    bins: number;
  }>;
  cases: Array<GoldenWindow | GoldenGridWindow>;
}

interface Golden {
  bundles: Record<
    string,
    { path: string; channels: Array<GoldenContinuous | GoldenEvent> }
  >;
}

const golden = JSON.parse(
  readFileSync(join(DATA, "parity.json"), "utf8"),
) as Golden;

/** A recorded number, where null stands for NaN. */
const number = (value: unknown): number =>
  value === null ? NaN : (value as number);

const isGrid = (
  window: GoldenWindow | GoldenGridWindow,
): window is GoldenGridWindow => "first" in window;

/**
 * Why a window does not match yet. Each reason has a predicate over the golden window
 * that selects the cases the reader fails for it. Those cases run with `test.fails`, so
 * a fix turns the group red and the reason leaves the list.
 */
const REASONS = {
  runs: "a raw read of a channel with runs delivers grid times and the pause samples",
  binRange:
    "a window bound on a bin edge maps to a different bin range in binary64",
  startTime:
    "the segment start is computed as offset + index * period, not in the spec's order",
  spansEnd: "data spans end at the last bin edge, past the end of the channel",
} as const;

type Reason = keyof typeof REASONS;

/** The bin range that binary64 division of the window bounds gives. */
function floatRange(
  window: GoldenGridWindow,
  offsetUs: number,
  bins: number,
): { start: number; end: number } {
  const clamp = (bin: number): number => Math.min(Math.max(bin, 0), bins);
  return {
    start: clamp(Math.floor((window.start_us - offsetUs) / window.period_us)),
    end: clamp(Math.ceil((window.end_us - offsetUs) / window.period_us)),
  };
}

/** The reason the reader fails a grid window, if it does. */
function gridReason(
  window: GoldenGridWindow,
  offsetUs: number,
  bins: number,
): Reason | undefined {
  const range = floatRange(window, offsetUs, bins);
  if (range.start !== window.first || range.end !== window.first + window.len) {
    return "binRange";
  }
  if (
    window.len > 0 &&
    offsetUs + window.first * window.period_us !== window.spec_start_us
  ) {
    return "startTime";
  }
  return undefined;
}

/**
 * The reason the reader fails a data-span window, if it does. The reader ends the last
 * span at the edge of the coarsest bin, which is past the channel's end when the last
 * bin is short.
 */
function spansReason(
  channel: GoldenContinuous,
  window: GoldenSpans,
): Reason | undefined {
  const coarsest = channel.levels[channel.levels.length - 1];
  const binsEndUs =
    channel.offset_us +
    (coarsest === undefined
      ? channel.num_samples * (1e6 / channel.rate_hz)
      : coarsest.bins * coarsest.period_us);
  const lastEndUs = window.spans[window.spans.length - 1]?.[1];
  return lastEndUs === channel.end_us &&
    window.end_us > channel.end_us &&
    binsEndUs > channel.end_us
    ? "spansEnd"
    : undefined;
}

function continuousReason(
  channel: GoldenContinuous,
  window: GoldenGridWindow,
): Reason | undefined {
  if (window.level === 0 && channel.runs !== null && window.len > 0) {
    const [only, ...more] = runSegments(channel, window);
    if (
      more.length > 0 ||
      only?.startUs !== window.spec_start_us ||
      only.length !== window.len
    ) {
      return "runs";
    }
  }
  const bins =
    window.level === 0
      ? channel.num_samples
      : channel.levels.find((level) => level.level === window.level)!.bins;
  return gridReason(window, channel.offset_us, bins);
}

const clients = new Map<string, Promise<StreamingClient>>();

function clientFor(name: string, path: string): Promise<StreamingClient> {
  let client = clients.get(name);
  if (client === undefined) {
    client = openBundle(join(DATA, path)).then(
      (store) => new StreamingClient({ store }),
    );
    clients.set(name, client);
  }
  return client;
}

/**
 * Recorded value at window index `at` of a column, or undefined where the golden file
 * keeps no row: a long window records only its first and last rows.
 */
function recorded(window: GoldenWindow, column: string, at: number): unknown {
  const head = window.rows[column];
  if (head === undefined) {
    return undefined;
  }
  if (at < head.length) {
    return head[at];
  }
  const tail = window.tail?.[column];
  const from = window.len - (tail?.length ?? 0);
  return tail !== undefined && at >= from ? tail[at - from] : undefined;
}

/**
 * Compares every recorded row of `column` with `actual(at)`, bit for bit, and returns a
 * description of the first difference, or an empty string.
 */
function firstDifference(
  window: GoldenWindow,
  column: string,
  actual: (at: number) => unknown,
  decode: (value: unknown) => unknown = number,
): string {
  for (let at = 0; at < window.len; at++) {
    const value = recorded(window, column, at);
    if (value === undefined) {
      continue;
    }
    const expected = decode(value);
    const got = actual(at);
    if (!Object.is(got, expected)) {
      return `${column}[${at}]: expected ${String(expected)}, got ${String(got)}`;
    }
  }
  return "";
}

const nonEmpty = (segments: Segment[]): Segment[] =>
  segments.filter((segment) => segment.data.length > 0);

/** The segments a raw read of a channel with runs delivers: one per run it overlaps. */
function runSegments(
  channel: GoldenContinuous,
  window: GoldenGridWindow,
): Array<{ startUs: number; length: number; from: number }> {
  const segments = [];
  const stop = window.first + window.len;
  for (const [first, count, timeUs] of channel.runs ?? []) {
    const low = Math.max(window.first, first);
    const high = Math.min(stop, first + count);
    if (high > low) {
      segments.push({
        startUs: timeUs + ((low - first) * 1e6) / channel.rate_hz,
        length: high - low,
        from: low - window.first,
      });
    }
  }
  return segments;
}

async function checkContinuous(
  client: StreamingClient,
  channel: GoldenContinuous,
  window: GoldenGridWindow,
): Promise<void> {
  const raw = window.level === 0;
  const segments = nonEmpty(
    await collect(
      client.query({
        channels: [channel.id],
        startUs: window.start_us,
        endUs: window.end_us,
        pixelWidthUs: raw ? 1e6 / channel.rate_hz : window.period_us,
        raw,
      }),
    ),
  );
  const width = raw ? 1 : 2;
  const expected =
    raw && channel.runs !== null
      ? runSegments(channel, window)
      : window.len === 0
        ? []
        : [{ startUs: window.spec_start_us, length: window.len, from: 0 }];
  expect(segments.map((segment) => segment.startUs)).toEqual(
    expected.map((segment) => segment.startUs),
  );
  expect(segments.map((segment) => segment.data.length / width)).toEqual(
    expected.map((segment) => segment.length),
  );
  const columns = raw ? ["values"] : ["min", "max"];
  segments.forEach((segment, row) => {
    expect(segment.isMinMax).toBe(!raw);
    const { from } = expected[row]!;
    columns.forEach((column, offset) => {
      expect(
        firstDifference(
          window,
          column,
          (at) => segment.data[(at - from) * width + offset],
        ),
      ).toBe("");
    });
  });
}

async function checkCounts(
  client: StreamingClient,
  channel: GoldenEvent,
  window: GoldenGridWindow,
): Promise<void> {
  const counts = await client.eventCounts({
    channel: channel.id,
    startUs: window.start_us,
    endUs: window.end_us,
    pixelWidthUs: window.period_us,
  });
  expect(counts.level).toBe(window.level);
  expect(counts.periodUs).toBe(window.period_us);
  expect(counts.counts.length).toBe(window.len * channel.num_labels);
  if (window.len > 0) {
    expect(counts.startUs).toBe(window.spec_start_us);
  }
  expect(
    firstDifference(
      window,
      "count",
      (at) =>
        Array.from(
          counts.counts.subarray(
            at * channel.num_labels,
            (at + 1) * channel.num_labels,
          ),
        ).join(","),
      (row) => (row as number[]).join(","),
    ),
  ).toBe("");
}

async function checkEvents(
  client: StreamingClient,
  infos: ChannelInfo[],
  channel: GoldenEvent,
  window: GoldenWindow,
): Promise<void> {
  const [events] = await collect(
    client.queryEvents({
      channels: [channel.id],
      startUs: window.start_us,
      endUs: window.end_us,
      columns: channel.columns.filter((name) => name !== "waveforms"),
    }),
  );
  expect(events!.times.length).toBe(window.len);
  const idOf = (index: number): string =>
    infos.find((info) => info.index === index)?.id ?? String(index);
  const column = (
    name: string,
    values: ArrayLike<unknown> | undefined,
    decode?: (value: unknown) => unknown,
  ): void => {
    if (window.rows[name] === undefined) {
      expect(values).toBeUndefined();
      return;
    }
    expect(values?.length).toBe(window.len);
    expect(firstDifference(window, name, (at) => values![at], decode)).toBe("");
  };
  column("time_us", events!.times);
  column("duration_us", events!.durations);
  column("label", events!.labels);
  column("value", events!.values);
  column("text", events!.text, (value) => value);
  column(
    "channel_indices",
    events!.channels?.map((ids) => ids.join(",")),
    (indices) => (indices as number[]).map(idOf).join(","),
  );
}

describe("parity with the Python reader", () => {
  interface Runner {
    title: string;
    reason: Reason | undefined;
    run: () => Promise<void>;
  }
  const runners: Runner[] = [];

  for (const [name, bundle] of Object.entries(golden.bundles)) {
    for (const channel of bundle.channels) {
      const prefix = `${name}/${channel.id}`;
      const open = () => clientFor(name, bundle.path);
      if (channel.kind === "continuous") {
        for (const window of channel.cases) {
          runners.push({
            title: `reads ${prefix} window ${window.id}`,
            reason: continuousReason(channel, window),
            run: async () => checkContinuous(await open(), channel, window),
          });
        }
        for (const spans of channel.spans) {
          runners.push({
            title: `reads ${prefix} data spans ${spans.id}`,
            reason: spansReason(channel, spans),
            run: async () => {
              const client = await open();
              expect(
                await client.dataSpans({
                  channel: channel.id,
                  startUs: spans.start_us,
                  endUs: spans.end_us,
                  gapThresholdUs: spans.gap_us,
                }),
              ).toEqual(spans.spans);
            },
          });
        }
      } else {
        for (const window of channel.cases) {
          const level = isGrid(window)
            ? channel.count_levels.find((entry) => entry.level === window.level)
            : undefined;
          runners.push({
            title: `reads ${prefix} window ${window.id}`,
            reason:
              isGrid(window) && level !== undefined
                ? gridReason(window, level.offset_us, level.bins)
                : undefined,
            run: async () => {
              const client = await open();
              if (isGrid(window)) {
                await checkCounts(client, channel, window);
              } else {
                await checkEvents(
                  client,
                  await client.channelInfo(),
                  channel,
                  window,
                );
              }
            },
          });
        }
      }
    }
  }

  for (const { title, reason, run } of runners) {
    if (reason === undefined) {
      test(title, run);
    }
  }
  for (const [reason, description] of Object.entries(REASONS)) {
    describe(`known failure: ${description}`, () => {
      for (const runner of runners) {
        if (runner.reason === reason) {
          test.fails(runner.title, runner.run);
        }
      }
    });
  }
});
