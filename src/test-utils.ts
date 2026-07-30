import type { Segment, Store } from "./types.js";

/**
 * A `Store` backed by an object literal, for tests that need bundle bytes without a
 * filesystem or a network.
 *
 * String values are encoded as UTF-8, bundle metadata being JSON. Reads return a copy, so a
 * test that mutates what it read cannot corrupt the fixture. The stored arrays themselves are
 * held as given, not copied on the way in.
 *
 * An absent key resolves to `undefined` rather than throwing, matching the `Store` contract,
 * and an empty file stays distinct from an absent one. An already-aborted signal rejects the
 * read.
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
 * Metadata for one unsharded, uncompressed little-endian array.
 *
 * Deliberately plainer than a real bundle, whose arrays are sharded and Zstd-compressed: chunk
 * bytes for this layout can be written by hand, so a test needs no encoder and no Zarr writer.
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

/** One chunk's worth of float32 bytes, written little-endian whatever the host's byte order. */
export function float32Chunk(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return bytes;
}

/** One chunk's worth of int64 bytes, little-endian. Accepts bigint for out-of-range values. */
export function int64Chunk(values: Array<number | bigint>): Uint8Array {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setBigInt64(index * 8, BigInt(value), true);
  });
  return bytes;
}

/** One pyramid level of a fixture channel: rank 1 is raw, rank 2 with a trailing 2 is minmax. */
export type FixtureLevel = { shape: number[]; periodUs: number };

/** A non-level child array of a fixture channel. */
export type FixtureArray = {
  shape: number[];
  dataType?: string;
  attributes?: Record<string, unknown>;
};

/** One channel group of a fixture bundle, at digit path `path`. */
export type FixtureChannel = {
  path: string;
  attributes: Record<string, unknown>;
  /** Pyramid levels, named by index under the channel: `0/0`, `0/1`, ... */
  levels?: FixtureLevel[];
  /** Non-level child arrays by name; a bare number[] is a float32 shape with no attributes. */
  extraArrays?: Record<string, number[] | FixtureArray>;
};

/**
 * A bundle's root `zarr.json` as a JSON string, with `consolidated_metadata` inlining every
 * descendant.
 *
 * Mirrors a real bundle: paths in `metadata` are flat and relative (`"0"`, `"0/1"`), and each
 * channel group carries its own empty `consolidated_metadata`, as the writer emits.
 *
 * `root` shallow-merges over the root object, which is how a test produces a malformed bundle -
 * `{ zarr_format: 2 }` to break the format, or `{ consolidated_metadata: undefined }` to drop
 * it, since `JSON.stringify` omits undefined values.
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
export type BundleChannel = {
  path: string;
  attributes: Record<string, unknown>;
  levels?: BundleLevel[];
  /** Event timestamps in microseconds, written as int64. */
  events?: number[];
  /** Spike waveforms: `samples` is rows flattened, one row of `pointsPerEvent` per event. */
  waveforms?: { periodUs: number; pointsPerEvent: number; samples: number[] };
};

/**
 * Every file of a readable in-memory bundle: the consolidated root plus each array's own
 * `zarr.json` and single chunk. The root entries and the per-array metadata are generated
 * from one description, so they cannot drift apart the way hand-written pairs can.
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
 * A `Segment` for tests, defaulting to an empty raw segment on channel "c" starting at 0 with
 * a 1000 us period.
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
