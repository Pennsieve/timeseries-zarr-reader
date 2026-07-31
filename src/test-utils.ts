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

/**
 * Builds `zarr.json` metadata for one unsharded, uncompressed little-endian array.
 *
 * Chunk bytes for this layout can be written by hand, with no encoder or Zarr writer.
 */
export function arrayMetadata(
  shape: number[],
  chunkShape: number[] = shape,
  attributes: Record<string, unknown> = {},
  dataType = "float32",
): string {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dataType,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunkShape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: 0,
    attributes,
  });
}

/** Encodes values as one chunk of little-endian float32 bytes. */
export function float32Chunk(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

/** Encodes values as one chunk of little-endian float64 bytes. */
export function float64Chunk(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat64(index * 8, value, true);
  });
  return bytes;
}

/** Encodes values as one chunk of little-endian int64 bytes. Accepts bigint for values beyond Number's safe range. */
export function int64Chunk(values: Array<number | bigint>): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setBigInt64(index * 8, BigInt(value), true);
  });
  return bytes;
}

/** One pyramid level of a fixture channel: rank 1 is raw, rank 2 with a trailing 2 is min/max. */
export interface FixtureLevel {
  shape: number[];
  periodUs: number;
}

/** A non-level child array of a fixture channel. */
export interface FixtureArray {
  shape: number[];
  dataType?: string;
  attributes?: Record<string, unknown>;
}

/** One channel group of a fixture bundle, at digit path `path`. */
export interface FixtureChannel {
  path: string;
  attributes: Record<string, unknown>;
  /** Pyramid levels, named by index under the channel: `0/0`, `0/1`, ... */
  levels?: FixtureLevel[];
  /** Non-level child arrays by name. A bare number[] is a float32 shape with no attributes. */
  extraArrays?: Record<string, number[] | FixtureArray>;
}

/**
 * Builds a bundle's root `zarr.json` as a JSON string, with `consolidated_metadata` inlining
 * every descendant.
 *
 * Mirrors a real bundle. Paths in `metadata` are flat and relative (`"0"`, `"0/1"`), and each
 * channel group carries its own empty `consolidated_metadata`, as the writer emits.
 *
 * `root` shallow-merges over the root object, for building malformed bundles.
 * `{ zarr_format: 2 }` breaks the format. `{ consolidated_metadata: undefined }` drops the
 * key, since `JSON.stringify` omits undefined values.
 */
export function bundleMetadata(
  channels: FixtureChannel[],
  root: Record<string, unknown> = {},
): string {
  const metadata: Record<string, unknown> = {};

  for (const channel of channels) {
    metadata[channel.path] = {
      attributes: channel.attributes,
      zarr_format: 3,
      node_type: "group",
      consolidated_metadata: {
        kind: "inline",
        must_understand: false,
        metadata: {},
      },
    };

    (channel.levels ?? []).forEach((level, index) => {
      metadata[`${channel.path}/${index}`] = {
        attributes: { period_us: level.periodUs },
        zarr_format: 3,
        node_type: "array",
        shape: level.shape,
        data_type: "float32",
      };
    });

    for (const [name, spec] of Object.entries(channel.extraArrays ?? {})) {
      const array = Array.isArray(spec) ? { shape: spec } : spec;
      metadata[`${channel.path}/${name}`] = {
        attributes: array.attributes ?? {},
        zarr_format: 3,
        node_type: "array",
        shape: array.shape,
        data_type: array.dataType ?? "float32",
      };
    }
  }

  return JSON.stringify({
    attributes: {},
    zarr_format: 3,
    node_type: "group",
    consolidated_metadata: {
      kind: "inline",
      must_understand: false,
      metadata,
    },
    ...root,
  });
}

/** One pyramid level with its data: raw samples, or flattened [min, max, ...] pairs. */
export type BundleLevel =
  | { periodUs: number; samples: number[] }
  | { periodUs: number; pairs: number[] };

/** One channel of a complete in-memory bundle. */
export interface BundleChannel {
  path: string;
  attributes: Record<string, unknown>;
  levels?: BundleLevel[];
  /** Event timestamps in microseconds, written as int64. */
  events?: number[];
  /** Spike waveforms: `samples` is rows flattened, one row of `pointsPerEvent` per event. */
  waveforms?: { periodUs: number; pointsPerEvent: number; samples: number[] };
}

/**
 * Builds every file of a readable in-memory bundle: the consolidated root plus each array's
 * own `zarr.json` and single chunk. Root entries and per-array metadata are generated from
 * the same description.
 */
export function bundleFiles(
  channels: BundleChannel[],
): Record<`/${string}`, string | Uint8Array> {
  const files: Record<`/${string}`, string | Uint8Array> = {};
  const rootChannels: FixtureChannel[] = [];

  for (const channel of channels) {
    const levels: FixtureLevel[] = [];
    (channel.levels ?? []).forEach((level, index) => {
      const raw = "samples" in level;
      const values = raw ? level.samples : level.pairs;
      const shape = raw ? [values.length] : [values.length / 2, 2];
      levels.push({ shape, periodUs: level.periodUs });
      files[`/${channel.path}/${index}/zarr.json`] = arrayMetadata(
        shape,
        shape,
        { period_us: level.periodUs },
      );
      files[`/${channel.path}/${index}/c/${raw ? "0" : "0/0"}`] =
        float32Chunk(values);
    });

    const extraArrays: Record<string, FixtureArray> = {};
    if (channel.events) {
      const shape = [channel.events.length];
      extraArrays.events = { shape, dataType: "int64" };
      files[`/${channel.path}/events/zarr.json`] = arrayMetadata(
        shape,
        shape,
        {},
        "int64",
      );
      files[`/${channel.path}/events/c/0`] = int64Chunk(channel.events);
    }
    if (channel.waveforms) {
      const { periodUs, pointsPerEvent, samples } = channel.waveforms;
      const shape = [samples.length / pointsPerEvent, pointsPerEvent];
      extraArrays.waveforms = {
        shape,
        attributes: { period_us: periodUs },
      };
      files[`/${channel.path}/waveforms/zarr.json`] = arrayMetadata(
        shape,
        shape,
        {
          period_us: periodUs,
        },
      );
      files[`/${channel.path}/waveforms/c/0/0`] = float32Chunk(samples);
    }

    rootChannels.push({
      path: channel.path,
      attributes: channel.attributes,
      levels,
      extraArrays,
    });
  }

  files["/zarr.json"] = bundleMetadata(rootChannels);
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
