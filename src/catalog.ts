import type { ChannelInfo, Store } from "./types.js";

/**
 * The bin period and how many samples it holds.
 *
 * The only part of a continuous channel's metadata that fixes where its data ends.
 */
export type Level0Geometry = {
  periodUs: number;
  sampleCount: number;
};

/**
 * Map one channel group's stored attributes to `ChannelInfo`.
 *
 * This is the boundary where the bundle's snake_case attribute names become the camelCase
 * the rest of the reader uses: `rate_hz` -> `rateHz`, `start_us` -> `startUs`. Attributes
 * arrive as parsed JSON of unknown shape and are validated here, so a malformed bundle fails
 * at catalog time naming the attribute at fault rather than surfacing later as NaN samples.
 * Unrecognised attributes are ignored, leaving room for the format to grow.
 *
 * `endUs` is derived rather than stored: for a continuous channel it is the exclusive end,
 * one period past the last sample, from `level0`.
 *
 * **A unit channel reports `endUs` equal to `startUs`.** Its true extent is the last event's
 * timestamp, which lives in the `events` array's data rather than in any metadata, so no
 * metadata-only derivation exists. Reporting the start rather than inventing an end keeps the
 * gap visible; a unit channel's real extent comes from querying its events.
 *
 * Throws a TypeError for a missing or wrong-typed attribute, an unrecognised `kind`, or a
 * continuous channel with no `level0` to end it. Throws a RangeError for a `rate_hz` that is
 * not above zero.
 */
export function toChannelInfo(
  attrs: unknown,
  level0?: Level0Geometry,
): ChannelInfo {
  if (typeof attrs !== "object" || attrs === null) {
    throw new TypeError("channel attributes must be an object");
  }
  const raw = attrs as Record<string, unknown>;

  const string = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") {
      throw new TypeError(`channel attribute ${key} must be a string`);
    }
    return value;
  };

  const finite = (key: string): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`channel attribute ${key} must be a finite number`);
    }
    return value;
  };

  const kind = string("kind");
  if (kind !== "continuous" && kind !== "unit") {
    throw new TypeError(
      `channel attribute kind must be "continuous" or "unit" (got "${kind}")`,
    );
  }

  const rateHz = finite("rate_hz");
  if (rateHz <= 0) {
    throw new RangeError(
      `channel attribute rate_hz must be above 0 (got ${rateHz})`,
    );
  }

  const startUs = finite("start_us");
  let endUs = startUs;
  if (kind === "continuous") {
    if (level0 === undefined) {
      throw new TypeError(
        `continuous channel ${string("id")} needs its level 0 geometry to derive endUs`,
      );
    }
    endUs = startUs + level0.sampleCount * level0.periodUs;
  }

  return {
    id: string("id"),
    name: string("name"),
    unit: string("unit"),
    rateHz,
    startUs,
    endUs,
    kind,
  };
}

/**
 * Pick the level to read for a given display resolution.
 *
 * The coarsest level whose bins are no wider than one pixel column. Anything coarser puts
 * fewer bins on screen than there are pixels and loses visible detail; anything finer fetches
 * data the display cannot show. A level whose period matches `pixelWidthUs` exactly qualifies.
 *
 * When every level is coarser than `pixelWidthUs` - zoomed in past the raw sample rate - the
 * finest level is the best available and is returned.
 *
 * Levels may arrive in any order. The returned level is the caller's own object, carrying
 * whatever else it holds. An active filter or montage forces the raw level instead; that
 * caller reads level 0 directly rather than asking here.
 *
 * Throws a RangeError for an empty list, or for a `pixelWidthUs` that is not above zero.
 */
export function selectLevel<T extends { periodUs: number }>(
  levels: readonly T[],
  pixelWidthUs: number,
): T {
  if (levels.length === 0) {
    throw new RangeError("levels must not be empty");
  }
  if (!(pixelWidthUs > 0)) {
    throw new RangeError(
      `pixelWidthUs must be greater than 0 (got ${pixelWidthUs})`,
    );
  }

  let finest = levels[0] as T;
  let coarsestThatFits: T | undefined;
  for (const level of levels) {
    if (level.periodUs < finest.periodUs) {
      finest = level;
    }
    if (
      level.periodUs <= pixelWidthUs &&
      (coarsestThatFits === undefined ||
        level.periodUs > coarsestThatFits.periodUs)
    ) {
      coarsestThatFits = level;
    }
  }

  return coarsestThatFits ?? finest;
}

/**
 * The half-open bin index range covering a time window.
 *
 * `start` is the first bin the window touches and `end` is one past the last.
 * `end - start` is how many bins to read and `start === end` means the window misses the
 * level. Both are clamped to the bins the level actually has.
 *
 * A bin overlapping the window only in part is included, and `endUs` is exclusive, so a bin
 * starting exactly there is not. Whole bins come back and the fine trim happens later: this
 * is the same rule `trimToBounds` applies, and the two must agree or every chunk boundary
 * drops or repeats bins.
 *
 * `grid` is the level's geometry - the absolute time of bin 0, the bin period, and the number
 * of bins.
 *
 * Throws a RangeError for an `endUs` before `startUs`, or a `periodUs` not above zero.
 */
export function binRange(
  grid: { startUs: number; periodUs: number; binCount: number },
  startUs: number,
  endUs: number,
): { start: number; end: number } {
  if (!(grid.periodUs > 0)) {
    throw new RangeError(
      `grid.periodUs must be greater than 0 (got ${grid.periodUs})`,
    );
  }
  if (endUs < startUs) {
    throw new RangeError(
      `endUs must not precede startUs (got ${startUs} and ${endUs})`,
    );
  }

  const clampToLevel = (bin: number): number =>
    Math.min(Math.max(bin, 0), grid.binCount);

  return {
    start: clampToLevel(Math.floor((startUs - grid.startUs) / grid.periodUs)),
    end: clampToLevel(Math.ceil((endUs - grid.startUs) / grid.periodUs)),
  };
}

/** One pyramid level of one channel. */
export type LevelInfo = {
  /** Absolute store path of the level array, ready to read. */
  path: `/${string}`;
  periodUs: number;
  /** Bins along the time axis, whatever each bin holds. */
  binCount: number;
  /** True when each bin is a `[min, max]` pair rather than a single sample. */
  isMinMax: boolean;
};

/** Where a unit channel's event data lives, read from the same consolidated metadata. */
export type UnitArrays = {
  /** Event timestamps: rank-1 int64 microseconds, ascending. */
  events: { path: `/${string}`; count: number };
  /** Spike waveforms: one row of `pointsPerEvent` samples per event. */
  waveforms: {
    path: `/${string}`;
    pointsPerEvent: number;
    /** Sample period within one waveform, in microseconds. */
    periodUs: number;
  };
};

/** One channel: where it lives, what it is, and the levels available for it. */
export type ChannelEntry = {
  /** Absolute store path of the channel group. Opaque - not the channel id. */
  path: `/${string}`;
  info: ChannelInfo;
  /** Finest level first. Empty for a unit channel, which has no pyramid. */
  levels: LevelInfo[];
  /** Event and waveform arrays. Present only when `info.kind` is "unit". */
  unit?: UnitArrays;
};

/**
 * Everything the reader needs to address a bundle's contents.
 *
 * `byId` holds the same entry objects as `channels`, keyed by channel id, since queries name
 * channels by id while the bundle stores them under opaque digit paths.
 */
export type BundleCatalog = {
  channels: ChannelEntry[];
  byId: Map<string, ChannelEntry>;
};

/** Narrow parsed JSON to an object, or undefined for anything else including null. */
const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/** Read one level array's metadata, or throw naming what the bundle got wrong. */
const readLevel = (
  path: `/${string}`,
  node: Record<string, unknown>,
): LevelInfo => {
  const shape: unknown = node.shape;
  const dims = Array.isArray(shape) ? (shape as unknown[]) : undefined;
  const binCount = dims?.[0];
  const layoutOk =
    dims !== undefined &&
    (dims.length === 1 || (dims.length === 2 && dims[1] === 2));
  if (!layoutOk || typeof binCount !== "number") {
    throw new Error(
      `level ${path} has a shape the reader cannot read: ${JSON.stringify(shape)} (expected [n] or [n, 2])`,
    );
  }

  const periodUs: unknown = asObject(node.attributes)?.period_us;
  if (typeof periodUs !== "number" || !(periodUs > 0)) {
    throw new Error(
      `level ${path} has no usable period_us (got ${JSON.stringify(periodUs)})`,
    );
  }

  return { path, periodUs, binCount, isMinMax: dims.length === 2 };
};

/** Read a unit channel's events and waveforms arrays, or throw naming what is wrong. */
const readUnitArrays = (
  channelPath: string,
  named: Map<string, Record<string, unknown>>,
): UnitArrays => {
  const dims = (name: string): unknown[] | undefined => {
    const shape = named.get(name)?.shape;
    return Array.isArray(shape) ? (shape as unknown[]) : undefined;
  };

  const eventDims = dims("events");
  const count = eventDims?.[0];
  if (eventDims?.length !== 1 || typeof count !== "number") {
    throw new Error(
      `unit channel /${channelPath} needs an events array of shape [n]`,
    );
  }

  const waveformDims = dims("waveforms");
  const rows = waveformDims?.[0];
  const pointsPerEvent = waveformDims?.[1];
  if (
    waveformDims?.length !== 2 ||
    typeof rows !== "number" ||
    typeof pointsPerEvent !== "number"
  ) {
    throw new Error(
      `unit channel /${channelPath} needs a waveforms array of shape [n, points_per_event]`,
    );
  }
  if (rows !== count) {
    throw new Error(
      `unit channel /${channelPath} has ${count} events but ${rows} waveform rows`,
    );
  }

  const periodUs: unknown = asObject(
    named.get("waveforms")?.attributes,
  )?.period_us;
  if (typeof periodUs !== "number" || !(periodUs > 0)) {
    throw new Error(
      `unit channel /${channelPath} waveforms has no usable period_us (got ${JSON.stringify(periodUs)})`,
    );
  }

  return {
    events: { path: `/${channelPath}/events`, count },
    waveforms: {
      path: `/${channelPath}/waveforms`,
      pointsPerEvent,
      periodUs,
    },
  };
};

/**
 * Read a bundle's root metadata and enumerate its channels and levels.
 *
 * One read of `/zarr.json`. Zarr's `consolidated_metadata` inlines every descendant's metadata
 * there, so the whole bundle is described by that single request and no per-channel round trips
 * are needed. Its entries are flat, relative paths - `"0"` for a channel group, `"0/1"` for a
 * level array - and depth is what distinguishes them.
 *
 * A missing `consolidated_metadata` is an error rather than a signal to walk the tree: a walk
 * costs one sequential request per node, and the writer always consolidates.
 *
 * A unit channel's `events` and `waveforms` arrays are read into {@link UnitArrays}; its
 * `units` cluster-id array is not consumed and stays unread. Other unrecognised nodes are
 * ignored, leaving room for the format to grow. A channel group's own (empty)
 * `consolidated_metadata` is likewise ignored.
 *
 * Levels come back finest first. A level's layout is read from its rank, per the bundle format:
 * rank 1 is raw, rank 2 with a trailing dimension of 2 is a min/max envelope.
 *
 * Throws when the bundle cannot be addressed: no `/zarr.json`, unparseable JSON, a root that is
 * not a Zarr v3 group, no `consolidated_metadata`, a level whose shape is neither of the two
 * layouts, a level with no usable `period_us`, a continuous channel with no raw level to end it,
 * a unit channel whose events or waveforms are missing or malformed, or two channels claiming
 * one id. A malformed channel attribute surfaces the naming error from {@link toChannelInfo}
 * unchanged.
 */
export async function readCatalog(store: Store): Promise<BundleCatalog> {
  const bytes = await store.get("/zarr.json");
  if (bytes === undefined) {
    throw new Error("no bundle root at /zarr.json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new Error("/zarr.json is not valid JSON", { cause });
  }

  const root = asObject(parsed);
  if (root === undefined) {
    throw new Error("/zarr.json must hold an object");
  }
  if (root.zarr_format !== 3) {
    throw new Error(
      `/zarr.json must declare zarr_format 3 (got ${JSON.stringify(root.zarr_format)})`,
    );
  }
  if (root.node_type !== "group") {
    throw new Error(
      `/zarr.json must declare node_type "group" (got ${JSON.stringify(root.node_type)})`,
    );
  }

  const nodes = asObject(asObject(root.consolidated_metadata)?.metadata);
  if (nodes === undefined) {
    throw new Error(
      "/zarr.json carries no consolidated_metadata, which the reader needs to enumerate a bundle in one read",
    );
  }

  // Paths are flat and relative: "0" is a channel group, "0/1" a level array. A group's own
  // consolidated_metadata is empty and contributes nothing, so only this map is walked.
  const groups = new Map<string, Record<string, unknown>>();
  const levelsByChannel = new Map<string, LevelInfo[]>();
  const namedByChannel = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();

  for (const [nodePath, value] of Object.entries(nodes)) {
    const node = asObject(value);
    if (node === undefined) {
      continue;
    }

    const slash = nodePath.indexOf("/");
    if (slash === -1) {
      if (node.node_type === "group") {
        groups.set(nodePath, node);
      }
      continue;
    }

    // A numbered array directly under a channel is a pyramid level; a named one is a unit
    // channel's data. Anything deeper or stranger is left alone.
    const channelPath = nodePath.slice(0, slash);
    const leaf = nodePath.slice(slash + 1);
    if (node.node_type !== "array" || leaf.includes("/")) {
      continue;
    }

    if (/^\d+$/.test(leaf)) {
      const levels = levelsByChannel.get(channelPath) ?? [];
      levels.push(readLevel(`/${nodePath}`, node));
      levelsByChannel.set(channelPath, levels);
    } else {
      const named = namedByChannel.get(channelPath) ?? new Map();
      named.set(leaf, node);
      namedByChannel.set(channelPath, named);
    }
  }

  const channels: ChannelEntry[] = [];
  const byId = new Map<string, ChannelEntry>();

  for (const [channelPath, node] of groups) {
    const levels = (levelsByChannel.get(channelPath) ?? []).sort(
      (a, b) => a.periodUs - b.periodUs,
    );
    const raw = levels.find((level) => !level.isMinMax);

    // Read `kind` only far enough to tell whether a raw level is required. Anything wrong with
    // the attributes themselves is toChannelInfo's to report, named.
    if (asObject(node.attributes)?.kind === "continuous" && raw === undefined) {
      throw new Error(
        `continuous channel /${channelPath} has no raw level to derive its end from`,
      );
    }

    const entry: ChannelEntry = {
      path: `/${channelPath}`,
      info: toChannelInfo(
        node.attributes,
        raw && { periodUs: raw.periodUs, sampleCount: raw.binCount },
      ),
      levels,
    };
    if (entry.info.kind === "unit") {
      entry.unit = readUnitArrays(
        channelPath,
        namedByChannel.get(channelPath) ?? new Map(),
      );
    }

    const claimed = byId.get(entry.info.id);
    if (claimed !== undefined) {
      throw new Error(
        `channels ${claimed.path} and ${entry.path} both claim id ${entry.info.id}`,
      );
    }

    channels.push(entry);
    byId.set(entry.info.id, entry);
  }

  return { channels, byId };
}
