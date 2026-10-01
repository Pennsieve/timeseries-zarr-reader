import { describe, expect, test } from "vitest";
import { StreamingClient } from "./client.js";
import {
  arrayMetadata,
  createMemoryStore,
  float32Chunk,
  int64Chunk,
} from "./test-utils.js";

// An EEG channel plus an annotation channel of three marks:
//   0: point at 1000, "spike", on ch-1
//   1: interval [5000, 8000), "seizure", whole recording
//   2: point at 9000, "spike", whole recording
const EVENTS = [1000, 5000, 9000];
const DURATIONS = [0, 3000, 0];
const LABELS = [0, 1, 0];
const BODIES = ["a\n", "bb\n", "c\n"];

function uintChunk(values: number[], bytes: 1 | 2 | 8): Uint8Array {
  const out = new Uint8Array(values.length * bytes);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    if (bytes === 1) view.setUint8(i, value);
    if (bytes === 2) view.setUint16(i * 2, value, true);
    if (bytes === 8) view.setBigUint64(i * 8, BigInt(value), true);
  });
  return out;
}

function eventStore(options: { bare?: boolean } = {}) {
  const bodyBytes = new TextEncoder().encode(BODIES.join(""));
  const bodyOffsets = [0, 2, 5, 7];
  const arrays: Record<
    string,
    { shape: number[]; type: string; chunk: Uint8Array }
  > = {
    "1/events": { shape: [3], type: "int64", chunk: int64Chunk(EVENTS) },
  };
  if (!options.bare) {
    Object.assign(arrays, {
      "1/durations": {
        shape: [3],
        type: "int64",
        chunk: int64Chunk(DURATIONS),
      },
      "1/labels": { shape: [3], type: "uint16", chunk: uintChunk(LABELS, 2) },
      "1/bodies": {
        shape: [bodyBytes.length],
        type: "uint8",
        chunk: bodyBytes,
      },
      "1/body_offsets": {
        shape: [4],
        type: "uint64",
        chunk: uintChunk(bodyOffsets, 8),
      },
      "1/channel_refs": {
        shape: [1],
        type: "uint16",
        chunk: uintChunk([0], 2),
      },
      "1/channel_ref_offsets": {
        shape: [4],
        type: "uint64",
        chunk: uintChunk([0, 1, 1, 1], 8),
      },
    });
  }

  const metadata: Record<string, unknown> = {
    "0": {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        id: "ch-1",
        name: "RP08",
        unit: "uV",
        rate_hz: 1000,
        offset_us: 0,
        kind: "continuous",
      },
    },
    "0/raw": JSON.parse(arrayMetadata([4])),
    "1": {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        id: "marks",
        name: "Clinical marks",
        offset_us: 1000,
        kind: "event",
        label_names: ["spike", "seizure"],
        body_media_type: "text/plain",
        max_duration_us: 3000,
      },
    },
  };
  const files: Record<`/${string}`, string | Uint8Array> = {
    "/0/raw/zarr.json": arrayMetadata([4]),
    "/0/raw/c/0": float32Chunk([0, 0, 0, 0]),
  };
  for (const [path, spec] of Object.entries(arrays)) {
    const meta = arrayMetadata(spec.shape, spec.shape, {}, spec.type);
    metadata[path] = JSON.parse(meta);
    files[`/${path}/zarr.json`] = meta;
    files[`/${path}/c/0`] = spec.chunk;
  }
  files["/zarr.json"] = JSON.stringify({
    zarr_format: 3,
    node_type: "group",
    attributes: {},
    consolidated_metadata: { kind: "inline", must_understand: false, metadata },
  });
  return createMemoryStore(files);
}

describe("event channels", () => {
  test("lists event channels apart from signal channels", async () => {
    const client = new StreamingClient({ store: eventStore() });
    expect((await client.channelInfo()).map((c) => c.id)).toEqual(["ch-1"]);
    expect(await client.eventChannels()).toEqual([
      {
        id: "marks",
        name: "Clinical marks",
        count: 3,
        labelNames: ["spike", "seizure"],
        bodyMediaType: "text/plain",
        maxDurationUs: 3000,
      },
    ]);
  });

  test("reads every column of the events in a window", async () => {
    const client = new StreamingClient({ store: eventStore() });
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 0,
      endUs: 10_000,
    });
    expect(window.events).toEqual([
      {
        index: 0,
        timeUs: 1000,
        durationUs: 0,
        label: "spike",
        body: "a",
        channels: ["ch-1"],
      },
      {
        index: 1,
        timeUs: 5000,
        durationUs: 3000,
        label: "seizure",
        body: "bb",
        channels: [],
      },
      {
        index: 2,
        timeUs: 9000,
        durationUs: 0,
        label: "spike",
        body: "c",
        channels: [],
      },
    ]);
  });

  test("includes an interval still running at the window start and excludes one at its end", async () => {
    const client = new StreamingClient({ store: eventStore() });
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 6000,
      endUs: 9000,
    });
    expect(window.events.map((e) => e.index)).toEqual([1]);
  });

  test("returns no events for a window between them", async () => {
    const client = new StreamingClient({ store: eventStore() });
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 1500,
      endUs: 4000,
    });
    expect(window.events).toEqual([]);
  });

  test("reads a channel that has only event times", async () => {
    const client = new StreamingClient({ store: eventStore({ bare: true }) });
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 0,
      endUs: 2000,
    });
    expect(window.events).toEqual([
      {
        index: 0,
        timeUs: 1000,
        durationUs: 0,
        label: undefined,
        body: undefined,
        channels: [],
      },
    ]);
  });

  test("rejects an unknown event channel", async () => {
    const client = new StreamingClient({ store: eventStore() });
    await expect(
      client.queryEvents({ channel: "ch-1", startUs: 0, endUs: 1 }),
    ).rejects.toThrow(/no event channel/);
  });

  test("leaves bodies out when asked", async () => {
    const client = new StreamingClient({ store: eventStore() });
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 0,
      endUs: 10_000,
      bodies: false,
    });
    expect(window.events.map((e) => e.timeUs)).toEqual([1000, 5000, 9000]);
    expect(window.events.map((e) => e.body)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(window.events[1]!.label).toBe("seizure");
  });

  test("a limit ends the window where the first event left out starts", async () => {
    const client = new StreamingClient({ store: eventStore() });
    const first = await client.queryEvents({
      channel: "marks",
      startUs: 0,
      endUs: 10_000,
      limit: 1,
    });
    expect(first.events.map((e) => e.timeUs)).toEqual([1000]);
    expect(first.endUs).toBe(5000);

    // Reading on from there picks up exactly where the first read stopped.
    const next = await client.queryEvents({
      channel: "marks",
      startUs: first.endUs,
      endUs: 10_000,
      limit: 1,
    });
    expect(next.events.map((e) => e.timeUs)).toEqual([5000]);
    expect(next.endUs).toBe(9000);
  });

  test("a limit counts only events starting inside the window", async () => {
    const client = new StreamingClient({ store: eventStore() });
    // The seizure started at 5000 and is still running at 6000; it comes back on top
    // of the one event the limit allows.
    const window = await client.queryEvents({
      channel: "marks",
      startUs: 6000,
      endUs: 10_000,
      limit: 1,
    });
    expect(window.events.map((e) => e.timeUs)).toEqual([5000, 9000]);
    expect(window.endUs).toBe(10_000);
  });

  test("rejects a limit that is not a positive integer", async () => {
    const client = new StreamingClient({ store: eventStore() });
    await expect(
      client.queryEvents({ channel: "marks", startUs: 0, endUs: 1, limit: 0 }),
    ).rejects.toThrow(RangeError);
  });

  test("reads one event's body on its own", async () => {
    const client = new StreamingClient({ store: eventStore() });
    expect(await client.eventBody({ channel: "marks", index: 1 })).toBe("bb");
    await expect(
      client.eventBody({ channel: "marks", index: 3 }),
    ).rejects.toThrow(RangeError);
  });

  test("a channel without bodies has no body to read", async () => {
    const client = new StreamingClient({ store: eventStore({ bare: true }) });
    expect(await client.eventBody({ channel: "marks", index: 0 })).toBe(
      undefined,
    );
  });
});
