import type { Segment, Store } from "./types";

/**
 * A `Store` backed by an object literal, for tests that need bundle bytes without a
 * filesystem or a network.
 *
 * String values are encoded as UTF-8, bundle metadata being JSON. Reads return a copy, so a
 * test that mutates what it read cannot corrupt the fixture. The stored arrays themselves are
 * held as given, not copied on the way in.
 *
 * An absent key resolves to `undefined` rather than throwing, matching the `Store` contract,
 * and an empty file stays distinct from an absent one.
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
    get: (key) => Promise.resolve(bytes.get(key)?.slice()),
    getRange: (key, range) => {
      const stored = bytes.get(key);
      if (stored === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(
        "suffixLength" in range
          ? stored.slice(stored.length - range.suffixLength)
          : stored.slice(range.offset, range.offset + range.length),
      );
    },
  };
}

/**
 * Metadata for one unsharded, uncompressed little-endian float32 array.
 *
 * Deliberately plainer than a real bundle, whose arrays are sharded and Zstd-compressed: chunk
 * bytes for this layout can be written by hand, so a test needs no encoder and no Zarr writer.
 */
export function arrayMetadata(
  shape: number[],
  chunkShape: number[] = shape,
  attributes: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "float32",
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

/** One pyramid level of a fixture channel: rank 1 is raw, rank 2 with a trailing 2 is minmax. */
export type FixtureLevel = { shape: number[]; periodUs: number };

/** One channel group of a fixture bundle, at digit path `path`. */
export type FixtureChannel = {
  path: string;
  attributes: Record<string, unknown>;
  /** Pyramid levels, named by index under the channel: `0/0`, `0/1`, ... */
  levels?: FixtureLevel[];
  /** Non-level child arrays by name, e.g. `{ events: [128] }`, given as shapes. */
  extraArrays?: Record<string, number[]>;
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

    for (const [name, shape] of Object.entries(channel.extraArrays ?? {})) {
      metadata[`${channel.path}/${name}`] = {
        attributes: {},
        zarr_format: 3,
        node_type: "array",
        shape,
        data_type: "float32",
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
