import type { Segment, Store } from "./types.js";

/** Collects an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Creates a `Store` backed by an object literal.
 *
 * String values are encoded as UTF-8. Reads return a copy, though the stored arrays are
 * not copied on construction. An absent key resolves to `undefined`, and an empty file is
 * distinct from an absent one. An already-aborted signal rejects the read.
 */
export function createMemoryStore(
  files: Record<`/${string}`, string | Uint8Array>,
): Store {
  const encoder = new TextEncoder();
  const bytes = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(files)) {
    bytes.set(key, typeof value === "string" ? encoder.encode(value) : value);
  }

  return {
    get: async (key, opts) => {
      opts?.signal?.throwIfAborted();
      return bytes.get(key)?.slice();
    },
    getRange: async (key, range, opts) => {
      opts?.signal?.throwIfAborted();
      const stored = bytes.get(key);
      if (stored === undefined) {
        return undefined;
      }
      return "suffixLength" in range
        ? stored.slice(stored.length - range.suffixLength)
        : stored.slice(range.offset, range.offset + range.length);
    },
  };
}

/** A store that tallies the reads reaching it, keyed by store key. */
export interface CountingStore {
  readonly store: Store;
  /** Reads per key, counting whole-key and ranged reads together. */
  readonly reads: Map<string, number>;
  /** Total reads across every key. */
  total(): number;
}

/** Wraps a store so tests can count the reads it does not serve from elsewhere. */
export function createCountingStore(inner: Store): CountingStore {
  const reads = new Map<string, number>();
  const tally = (key: string): void => {
    reads.set(key, (reads.get(key) ?? 0) + 1);
  };

  return {
    store: {
      get: (key, opts) => {
        tally(key);
        return inner.get(key, opts);
      },
      getRange: (key, range, opts) => {
        tally(key);
        return inner.getRange(key, range, opts);
      },
    },
    reads,
    total: () => [...reads.values()].reduce((sum, n) => sum + n, 0),
  };
}

/** The Zarr v3 dtypes the fixtures write. */
export type FixtureDtype =
  "float32" | "float64" | "int64" | "uint8" | "uint16" | "uint32";

const BYTES_PER_VALUE: Record<FixtureDtype, number> = {
  float32: 4,
  float64: 8,
  int64: 8,
  uint8: 1,
  uint16: 2,
  uint32: 4,
};

/** Encodes values as one chunk of little-endian bytes of `dtype`. */
export function encodeChunk(
  values: ArrayLike<number | bigint>,
  dtype: FixtureDtype,
): Uint8Array {
  const width = BYTES_PER_VALUE[dtype];
  const bytes = new Uint8Array(values.length * width);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const offset = i * width;
    switch (dtype) {
      case "float32":
        view.setFloat32(offset, Number(value), true);
        break;
      case "float64":
        view.setFloat64(offset, Number(value), true);
        break;
      case "int64":
        view.setBigInt64(offset, BigInt(value), true);
        break;
      case "uint8":
        view.setUint8(offset, Number(value));
        break;
      case "uint16":
        view.setUint16(offset, Number(value), true);
        break;
      case "uint32":
        view.setUint32(offset, Number(value), true);
        break;
    }
  }
  return bytes;
}

/** Encodes values as one chunk of little-endian float32 bytes. */
export const float32Chunk = (values: number[]): Uint8Array =>
  encodeChunk(values, "float32");

/** Encodes values as one chunk of little-endian float64 bytes. */
export const float64Chunk = (values: number[]): Uint8Array =>
  encodeChunk(values, "float64");

/** Encodes values as one chunk of little-endian int64 bytes. Accepts bigint for values beyond Number's safe range. */
export const int64Chunk = (values: Array<number | bigint>): Uint8Array =>
  encodeChunk(values, "int64");

/** The fill value the format requires: NaN for floats, 0 for integers. */
function fillValueOf(dtype: FixtureDtype): "NaN" | 0 {
  return dtype.startsWith("float") ? "NaN" : 0;
}

/** The metadata node for one unsharded, uncompressed little-endian array. */
function arrayNode(
  shape: number[],
  chunkShape: number[],
  attributes: Record<string, unknown>,
  dataType: FixtureDtype,
): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: fillValueOf(dataType),
    attributes,
  };
}

/**
 * Builds `zarr.json` metadata for one unsharded, uncompressed little-endian array.
 *
 * Chunk bytes for this layout can be written by hand, with no encoder or Zarr writer.
 */
export function arrayMetadata(
  shape: number[],
  chunkShape: number[] = shape,
  attributes: Record<string, unknown> = {},
  dataType: FixtureDtype = "float32",
): string {
  return JSON.stringify(arrayNode(shape, chunkShape, attributes, dataType));
}

type Files = Record<`/${string}`, string | Uint8Array>;

/**
 * Writes one array into `files`: its `zarr.json` and one chunk per `chunkLength` rows
 * along the first axis, trailing axes unchunked. A trailing partial chunk is padded
 * with the fill value, as Zarr stores it. Returns the array's metadata node for the
 * consolidated map.
 */
function writeArray(
  files: Files,
  path: string,
  values: ArrayLike<number | bigint>,
  shape: number[],
  dtype: FixtureDtype,
  attributes: Record<string, unknown> = {},
  chunkLength = shape[0],
): Record<string, unknown> {
  const rows = shape[0]!;
  const rowWidth = shape.slice(1).reduce((product, dim) => product * dim, 1);
  const chunkRows = Math.max(1, chunkLength ?? rows);
  const chunkShape = [chunkRows, ...shape.slice(1)];
  const node = arrayNode(shape, chunkShape, attributes, dtype);
  files[`/${path}/zarr.json`] = JSON.stringify(node);

  const fill = dtype.startsWith("float") ? NaN : 0;
  const trailing = shape
    .slice(1)
    .map(() => "/0")
    .join("");
  for (let chunk = 0; chunk * chunkRows < rows; chunk++) {
    const padded: Array<number | bigint> = [];
    for (let i = 0; i < chunkRows * rowWidth; i++) {
      const index = chunk * chunkRows * rowWidth + i;
      padded.push(index < values.length ? values[index]! : fill);
    }
    files[`/${path}/c/${chunk}${trailing}`] = encodeChunk(padded, dtype);
  }
  return node;
}

/** One level of a fixture continuous channel, numbered 1, 2, ... in list order. */
export interface FixtureLevel {
  periodUs: number;
  /** Flattened `[min, max, ...]` pairs. */
  pairs: number[];
  /** Bins per chunk. Defaults to one chunk for the level. */
  chunkLength?: number;
  mean?: number[];
  var?: number[];
  count?: number[];
}

/** One continuous channel of a fixture bundle. */
export interface FixtureContinuous {
  /** The channel index: the integer name of its group. */
  index: number;
  /** The channel group's `tsz` object. */
  tsz: Record<string, unknown>;
  raw: number[];
  /** Samples per raw chunk. Defaults to one chunk. */
  rawChunkLength?: number;
  levels?: FixtureLevel[];
  /** Rows of the `runs` table: `[firstSample, sampleCount, startUs]` each. */
  runs?: number[][];
}

/** A snippet array: `samples` is rows flattened, one row of `pointsPerEvent` values each. */
export interface FixtureSnippets {
  periodUs: number;
  pointsPerEvent: number;
  samples: number[];
  eventSample?: number;
}

/** One count level of a fixture event channel, numbered 1, 2, ... in list order. */
export interface FixtureCountLevel {
  periodUs: number;
  offsetUs?: number;
  labelCount: number;
  /** Flattened `(bins, labelCount)` counts. */
  counts: number[];
}

/** One event channel of a fixture bundle. */
export interface FixtureEvent {
  index: number;
  tsz: Record<string, unknown>;
  /** Event times in microseconds, written as int64. */
  events: number[];
  durations?: number[];
  labels?: number[];
  values?: number[];
  text?: string[];
  /** Channel indices each event applies to. The row width covers the bundle's largest index. */
  channels?: number[][];
  waveforms?: FixtureSnippets;
  waveformMean?: FixtureSnippets;
  countLevels?: FixtureCountLevel[];
  /** Further arrays under the channel, which a reader must ignore. */
  extraArrays?: Record<string, { shape: number[]; dataType?: FixtureDtype }>;
}

export type FixtureChannel = FixtureContinuous | FixtureEvent;

/** Options of {@link bundleFiles}. */
export interface FixtureOptions {
  /** The root `tsz` object. `null` writes a root with no `tsz` at all. Defaults to version 1.0. */
  rootTsz?: Record<string, unknown> | null;
  /** Content of `recording.json`. An object is serialized; a string is written as is. */
  recording?: Record<string, unknown> | string;
}

/** Encodes strings as rows of UTF-8 zero-padded to the longest, at least one byte wide. */
function textRows(strings: string[]): { bytes: number[]; width: number } {
  const encoded = strings.map((text) => new TextEncoder().encode(text));
  const width = Math.max(1, ...encoded.map((row) => row.length));
  const bytes: number[] = [];
  for (const row of encoded) {
    bytes.push(...row, ...new Array<number>(width - row.length).fill(0));
  }
  return { bytes, width };
}

/** Encodes channel index lists as bitmask rows, bit `k mod 8` of byte `floor(k / 8)`. */
function maskRows(indexLists: number[][], width: number): number[] {
  const bytes: number[] = [];
  for (const indices of indexLists) {
    const row = new Array<number>(width).fill(0);
    for (const index of indices) {
      row[index >> 3]! |= 1 << (index & 7);
    }
    bytes.push(...row);
  }
  return bytes;
}

/**
 * Builds every file of a readable in-memory TS-Zarr 1.0 bundle: the consolidated root,
 * each group's and array's own `zarr.json`, and each array's chunks.
 *
 * Mirrors a real bundle. Paths in the consolidated map are flat and relative (`"0"`,
 * `"0/1/minmax"`), and each group carries its own empty `consolidated_metadata`, as
 * zarr-python writes it. Arrays are unsharded and uncompressed.
 */
export function bundleFiles(
  channels: FixtureChannel[],
  options: FixtureOptions = {},
): Files {
  const files: Files = {};
  const metadata: Record<string, unknown> = {};
  const maxIndex = Math.max(0, ...channels.map((channel) => channel.index));
  const maskWidth = Math.ceil((maxIndex + 1) / 8);

  const group = (path: string, attributes: Record<string, unknown>): void => {
    metadata[path] = {
      attributes,
      zarr_format: 3,
      node_type: "group",
      consolidated_metadata: {
        kind: "inline",
        must_understand: false,
        metadata: {},
      },
    };
    files[`/${path}/zarr.json`] = JSON.stringify({
      attributes,
      zarr_format: 3,
      node_type: "group",
    });
  };
  const array = (
    path: string,
    values: ArrayLike<number | bigint>,
    shape: number[],
    dtype: FixtureDtype,
    attributes?: Record<string, unknown>,
    chunkLength?: number,
  ): void => {
    metadata[path] = writeArray(
      files,
      path,
      values,
      shape,
      dtype,
      attributes,
      chunkLength,
    );
  };
  const snippetAttrs = (
    snippets: FixtureSnippets,
  ): Record<string, unknown> => ({
    tsz: {
      period_us: snippets.periodUs,
      ...(snippets.eventSample === undefined
        ? {}
        : { event_sample: snippets.eventSample }),
    },
  });

  for (const channel of channels) {
    const key = String(channel.index);
    group(key, { tsz: channel.tsz });

    if ("raw" in channel) {
      array(
        `${key}/raw`,
        channel.raw,
        [channel.raw.length],
        "float32",
        {},
        channel.rawChunkLength,
      );
      if (channel.runs) {
        array(
          `${key}/runs`,
          channel.runs.flat(),
          [channel.runs.length, 3],
          "int64",
        );
      }
      (channel.levels ?? []).forEach((level, index) => {
        const name = `${key}/${index + 1}`;
        const bins = level.pairs.length / 2;
        group(name, { tsz: { period_us: level.periodUs } });
        array(
          `${name}/minmax`,
          level.pairs,
          [bins, 2],
          "float32",
          {},
          level.chunkLength,
        );
        if (level.mean) {
          array(
            `${name}/mean`,
            level.mean,
            [bins],
            "float32",
            {},
            level.chunkLength,
          );
        }
        if (level.var) {
          array(
            `${name}/var`,
            level.var,
            [bins],
            "float32",
            {},
            level.chunkLength,
          );
        }
        if (level.count) {
          array(
            `${name}/count`,
            level.count,
            [bins],
            "uint32",
            {},
            level.chunkLength,
          );
        }
      });
      continue;
    }

    const n = channel.events.length;
    array(`${key}/events`, channel.events, [n], "int64");
    if (channel.durations) {
      array(`${key}/durations`, channel.durations, [n], "int64");
    }
    if (channel.labels) {
      array(`${key}/labels`, channel.labels, [n], "uint16");
    }
    if (channel.values) {
      array(`${key}/values`, channel.values, [n], "float32");
    }
    if (channel.text) {
      const rows = textRows(channel.text);
      array(`${key}/text`, rows.bytes, [n, rows.width], "uint8");
    }
    if (channel.channels) {
      array(
        `${key}/channels`,
        maskRows(channel.channels, maskWidth),
        [n, maskWidth],
        "uint8",
      );
    }
    for (const [name, snippets] of [
      ["waveforms", channel.waveforms],
      ["waveform_mean", channel.waveformMean],
    ] as const) {
      if (snippets) {
        array(
          `${key}/${name}`,
          snippets.samples,
          [
            snippets.samples.length / snippets.pointsPerEvent,
            snippets.pointsPerEvent,
          ],
          "float32",
          snippetAttrs(snippets),
        );
      }
    }
    (channel.countLevels ?? []).forEach((level, index) => {
      const name = `${key}/${index + 1}`;
      group(name, {
        tsz: {
          period_us: level.periodUs,
          ...(level.offsetUs === undefined
            ? {}
            : { offset_us: level.offsetUs }),
        },
      });
      array(
        `${name}/count`,
        level.counts,
        [level.counts.length / level.labelCount, level.labelCount],
        "uint32",
      );
    });
    for (const [name, extra] of Object.entries(channel.extraArrays ?? {})) {
      array(`${key}/${name}`, [], extra.shape, extra.dataType ?? "float32");
    }
  }

  const attributes =
    options.rootTsz === null
      ? {}
      : { tsz: options.rootTsz ?? { version: "1.0" } };
  files["/zarr.json"] = JSON.stringify({
    attributes,
    zarr_format: 3,
    node_type: "group",
    consolidated_metadata: {
      kind: "inline",
      must_understand: false,
      metadata,
    },
  });
  if (options.recording !== undefined) {
    files["/recording.json"] =
      typeof options.recording === "string"
        ? options.recording
        : JSON.stringify(options.recording);
  }
  return files;
}

/**
 * Builds a `Segment` for tests: by default an empty raw segment on channel "c" starting at 0
 * with a 1000 us period.
 */
export function makeSegment(overrides: Partial<Segment> = {}): Segment {
  return {
    channel: "c",
    startUs: 0,
    samplePeriodUs: 1000,
    isMinMax: false,
    data: new Float64Array(0),
    ...overrides,
  };
}
