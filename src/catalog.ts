import type { ChannelInfo, Store } from "./types.js";

/** Level-0 bin period and sample count, used to derive a continuous channel's end time. */
export interface Level0Geometry {
  readonly periodUs: number;
  readonly sampleCount: number;
}

/**
 * Maps a channel group's stored attributes to `ChannelInfo`.
 *
 * The bundle's snake_case attribute names become camelCase here: `rate_hz` -> `rateHz`,
 * `start_us` -> `startUs`. Unrecognized attributes are ignored.
 *
 * For a continuous channel, `endUs` is the exclusive end derived from `level0`: one period
 * past the last sample. For a unit channel, `endUs` equals `startUs`; its true extent is the
 * last event's timestamp, available only from the `events` array.
 *
 * Throws a TypeError for a missing or wrong-typed attribute, an unrecognized `kind`, or a
 * continuous channel without `level0`. Throws a RangeError for a `rate_hz` that is not
 * greater than zero.
 */
export function toChannelInfo(
  attrs: unknown,
  level0?: Level0Geometry,
): ChannelInfo {
  const raw = asObject(attrs);
  if (raw === undefined) {
    throw new TypeError("channel attributes must be an object");
  }

  const requireString = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") {
      throw new TypeError(`channel attribute ${key} must be a string`);
    }
    return value;
  };

  const requireNumber = (key: string): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`channel attribute ${key} must be a finite number`);
    }
    return value;
  };

  const kind = requireString("kind");
  if (kind !== "continuous" && kind !== "unit") {
    throw new TypeError(
      `channel attribute kind must be "continuous" or "unit" (got "${kind}")`,
    );
  }

  const rateHz = requireNumber("rate_hz");
  if (rateHz <= 0) {
    throw new RangeError(
      `channel attribute rate_hz must be greater than 0 (got ${rateHz})`,
    );
  }

  const startUs = requireNumber("start_us");
  let endUs = startUs;
  if (kind === "continuous") {
    if (level0 === undefined) {
      throw new TypeError(
        `continuous channel ${requireString("id")} requires level0 geometry to derive endUs`,
      );
    }
    endUs = startUs + level0.sampleCount * level0.periodUs;
  }

  return {
    id: requireString("id"),
    name: requireString("name"),
    unit: requireString("unit"),
    rateHz,
    startUs,
    endUs,
    kind,
  };
}

/**
 * Selects the coarsest level whose `periodUs` is at most `pixelWidthUs`.
 *
 * Returns the finest level when no level qualifies. Levels may be in any order.
 *
 * Throws a RangeError when `levels` is empty or `pixelWidthUs` is not greater than zero.
 */
export function selectLevel<T extends { periodUs: number }>(
  levels: readonly T[],
  pixelWidthUs: number,
): T {
  const [firstLevel] = levels;
  if (firstLevel === undefined) {
    throw new RangeError("levels must not be empty");
  }
  if (!(pixelWidthUs > 0)) {
    throw new RangeError(
      `pixelWidthUs must be greater than 0 (got ${pixelWidthUs})`,
    );
  }

  let finest = firstLevel;
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
 * Returns the half-open bin index range covering the window `[startUs, endUs)`.
 *
 * `start` is the first overlapped bin; `end` is one past the last. Both are clamped to
 * `[0, grid.binCount]`. A bin that partially overlaps the window is included; a bin
 * starting exactly at the exclusive `endUs` is not. The inclusion rule matches
 * `trimToBounds`.
 *
 * `grid.startUs` is the absolute time of bin 0.
 *
 * Throws a RangeError when `endUs` precedes `startUs` or `grid.periodUs` is not greater
 * than zero.
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
export interface LevelInfo {
  /** Absolute store path of the level array. */
  readonly path: `/${string}`;
  readonly periodUs: number;
  /** Number of bins along the time axis. */
  readonly binCount: number;
  /** True when each bin holds a `[min, max]` pair. */
  readonly isMinMax: boolean;
}

/** Store paths and shapes of a unit channel's event data. */
export interface UnitArrays {
  /** Event timestamps: rank-1 int64 microseconds, ascending. */
  readonly events: { readonly path: `/${string}`; readonly count: number };
  /** Spike waveforms: one row of `pointsPerEvent` samples per event. */
  readonly waveforms: {
    readonly path: `/${string}`;
    readonly pointsPerEvent: number;
    /** Sample period within one waveform, in microseconds. */
    readonly periodUs: number;
  };
}

/** One channel of a bundle: its store path, info, and pyramid levels. */
export interface ChannelEntry {
  /** Absolute store path of the channel group; not the channel id. */
  readonly path: `/${string}`;
  readonly info: ChannelInfo;
  /** Finest first. Empty for a unit channel. */
  readonly levels: LevelInfo[];
  /** Present only when `info.kind` is "unit". */
  readonly unit?: UnitArrays;
}

/**
 * A bundle's channels plus an id index.
 *
 * `byId` holds the same entry objects as `channels`, keyed by channel id.
 */
export interface BundleCatalog {
  readonly channels: ChannelEntry[];
  readonly byId: Map<string, ChannelEntry>;
}

/** Narrows parsed JSON to an object. Returns undefined for non-objects, including null. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrows an array node's `shape` metadata to a list of dimensions. */
function asDims(shape: unknown): unknown[] | undefined {
  return Array.isArray(shape) ? shape : undefined;
}

/** Reads one level array's metadata. Throws on an unsupported shape or a missing `period_us`. */
function readLevel(
  path: `/${string}`,
  node: Record<string, unknown>,
): LevelInfo {
  const dims = asDims(node.shape);
  const binCount = dims?.[0];
  const layoutOk =
    dims !== undefined &&
    (dims.length === 1 || (dims.length === 2 && dims[1] === 2));
  if (!layoutOk || typeof binCount !== "number") {
    throw new Error(
      `level ${path} has unsupported shape ${JSON.stringify(node.shape)} (expected [n] or [n, 2])`,
    );
  }

  const periodUs: unknown = asObject(node.attributes)?.period_us;
  if (typeof periodUs !== "number" || !(periodUs > 0)) {
    throw new Error(
      `level ${path} must have a positive period_us (got ${JSON.stringify(periodUs)})`,
    );
  }

  return { path, periodUs, binCount, isMinMax: dims.length === 2 };
}

/** Reads a unit channel's events and waveforms metadata. Throws when either is missing or malformed. */
function readUnitArrays(
  channelPath: string,
  named: ReadonlyMap<string, Record<string, unknown>>,
): UnitArrays {
  const eventDims = asDims(named.get("events")?.shape);
  const count = eventDims?.[0];
  if (eventDims?.length !== 1 || typeof count !== "number") {
    throw new Error(
      `unit channel /${channelPath} must have an events array of shape [n]`,
    );
  }

  const waveformDims = asDims(named.get("waveforms")?.shape);
  const rows = waveformDims?.[0];
  const pointsPerEvent = waveformDims?.[1];
  if (
    waveformDims?.length !== 2 ||
    typeof rows !== "number" ||
    typeof pointsPerEvent !== "number"
  ) {
    throw new Error(
      `unit channel /${channelPath} must have a waveforms array of shape [n, points_per_event]`,
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
      `unit channel /${channelPath} waveforms must have a positive period_us (got ${JSON.stringify(periodUs)})`,
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
}

/**
 * Reads a bundle's root metadata and enumerates its channels and levels.
 *
 * One read of `/zarr.json`; its `consolidated_metadata` inlines every descendant's
 * metadata. A missing `consolidated_metadata` is an error; the tree is never walked.
 *
 * Levels are returned finest first. A level's layout comes from its rank: rank 1 is raw,
 * rank 2 with a trailing dimension of 2 is a min/max envelope. A unit channel's `events`
 * and `waveforms` arrays are read into {@link UnitArrays}; its `units` array and other
 * unrecognized nodes are ignored.
 *
 * Throws for a missing `/zarr.json`, invalid JSON, a root that is not a Zarr v3 group,
 * missing `consolidated_metadata`, a malformed level, malformed channel attributes, a
 * continuous channel with no raw level, missing or malformed unit arrays, or a duplicate
 * channel id.
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
    throw new Error("/zarr.json has no consolidated_metadata");
  }

  // Consolidated paths are flat and relative: "0" is a channel group, "0/1" a level array.
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

    // A numbered array directly under a channel is a pyramid level; a named one is
    // unit-channel data. Deeper nodes are ignored.
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

    // `kind` is read here only to decide whether a raw level is required; toChannelInfo
    // validates the attributes.
    if (asObject(node.attributes)?.kind === "continuous" && raw === undefined) {
      throw new Error(`continuous channel /${channelPath} has no raw level`);
    }

    const info = toChannelInfo(
      node.attributes,
      raw && { periodUs: raw.periodUs, sampleCount: raw.binCount },
    );
    const unit =
      info.kind === "unit"
        ? readUnitArrays(
            channelPath,
            namedByChannel.get(channelPath) ?? new Map(),
          )
        : undefined;
    const entry: ChannelEntry = { path: `/${channelPath}`, info, levels, unit };

    const claimed = byId.get(info.id);
    if (claimed !== undefined) {
      throw new Error(
        `duplicate channel id ${info.id}: ${claimed.path} and ${entry.path}`,
      );
    }

    channels.push(entry);
    byId.set(info.id, entry);
  }

  return { channels, byId };
}
