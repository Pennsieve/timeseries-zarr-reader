import { channelEndUs, levelBins, samplesPerBin } from "./grid.js";
import type {
  ContinuousChannelInfo,
  EventChannelInfo,
  EventColumn,
  Mutable,
  Store,
} from "./types.js";

/** Major version of the TS-Zarr specification this reader implements. */
export const SPEC_MAJOR_VERSION = 1;

/** One pyramid level of a continuous channel: the raw samples, or a level's min/max pairs. */
export interface LevelInfo {
  /** Absolute store path of the array a trace is read from: `raw`, or a level's `minmax`. */
  readonly path: `/${string}`;
  readonly periodUs: number;
  /** Samples each bin folds: 1 for the raw samples, at least 2 for a level. */
  readonly samplesPerBin: number;
  /** Number of bins along the time axis. */
  readonly binCount: number;
  /** True when each bin holds a `[min, max]` pair. */
  readonly isMinMax: boolean;
  /** Absolute store path of the level's `count` member, when it has one. */
  readonly countPath?: `/${string}`;
  /** Absolute store path of the level's `mean` member, when it has one. */
  readonly meanPath?: `/${string}`;
  /** Absolute store path of the level's `var` member, when it has one. */
  readonly variancePath?: `/${string}`;
}

/** A per-event column with one value per event: `durations`, `labels`, or `values`. */
export interface ColumnArray {
  readonly path: `/${string}`;
}

/** A per-event column with a trailing width: `text` or `channels`. */
export interface RowArray {
  readonly path: `/${string}`;
  /** Bytes per row. */
  readonly width: number;
}

/** A snippet array: `waveforms` with one row per event, or `waveform_mean` with one per label. */
export interface WaveformArray {
  readonly path: `/${string}`;
  readonly rows: number;
  readonly pointsPerEvent: number;
  /** Sample period within one snippet, in microseconds. */
  readonly periodUs: number;
  /** Index of the snippet sample recorded at the event time. */
  readonly eventSample: number;
}

/** One count level of an event channel. */
export interface CountLevelInfo {
  /** Absolute store path of the level's `count` array. */
  readonly path: `/${string}`;
  /** The level number, from 1. */
  readonly level: number;
  readonly periodUs: number;
  /** Time of bin 0. */
  readonly offsetUs: number;
  readonly binCount: number;
  readonly labelCount: number;
}

/** Store paths and shapes of an event channel's arrays. */
export interface EventArrays {
  readonly events: { readonly path: `/${string}`; readonly count: number };
  readonly durations?: ColumnArray & { readonly maxDurationUs?: number };
  readonly labels?: ColumnArray;
  readonly values?: ColumnArray;
  readonly text?: RowArray;
  readonly channels?: RowArray;
  readonly waveforms?: WaveformArray;
  readonly waveformMean?: WaveformArray;
  /** Count levels, finest first. Empty when the channel stores none. */
  readonly countLevels: readonly CountLevelInfo[];
}

/** One continuous channel of a bundle: its store path, info, and pyramid levels. */
export interface ContinuousEntry {
  readonly kind: "continuous";
  /** Absolute store path of the channel group. */
  readonly path: `/${string}`;
  readonly info: ContinuousChannelInfo;
  /** Finest first. The raw level is always present. */
  readonly levels: LevelInfo[];
  /** Length of `raw`. */
  readonly sampleCount: number;
  /** The `runs` table, when the channel stores one: its path and row count. */
  readonly runs?: { readonly path: `/${string}`; readonly rows: number };
}

/** One event channel of a bundle: its store path, info, and arrays. */
export interface EventEntry {
  readonly kind: "event";
  /** Absolute store path of the channel group. */
  readonly path: `/${string}`;
  readonly info: EventChannelInfo;
  readonly arrays: EventArrays;
}

export type ChannelEntry = ContinuousEntry | EventEntry;

/**
 * A bundle's channels plus two indexes.
 *
 * `byId` holds the same entry objects as `channels`, keyed by channel id. The format
 * does not require ids to be unique, so each id maps to every channel that carries it,
 * in channel index order. `idByIndex` maps a channel index to its id, which is how an
 * event's `channels` column names the channels it applies to.
 */
export interface BundleCatalog {
  /** The bundle's `tsz.version`. */
  readonly version: string;
  readonly channels: ChannelEntry[];
  readonly byId: Map<string, ChannelEntry[]>;
  readonly idByIndex: Map<number, string>;
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

type Json = Record<string, unknown>;

/** Narrows parsed JSON to an object. Returns undefined for non-objects, including null. */
function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null
    ? (value as Json)
    : undefined;
}

/** Returns the length of a `[n]` shape, or undefined for any other shape. */
function rank1Length(shape: unknown): number | undefined {
  return Array.isArray(shape) &&
    shape.length === 1 &&
    typeof shape[0] === "number"
    ? shape[0]
    : undefined;
}

/** Returns the dimensions of a `[rows, width]` shape, or undefined for any other shape. */
function rank2(shape: unknown): [number, number] | undefined {
  return Array.isArray(shape) &&
    shape.length === 2 &&
    typeof shape[0] === "number" &&
    typeof shape[1] === "number"
    ? [shape[0], shape[1]]
    : undefined;
}

/** Smallest width of a level in samples. */
const MIN_SAMPLES_PER_BIN = 2;

/** Exclusive upper bound on the width of a level in samples. */
const MAX_SAMPLES_PER_BIN = 2 ** 32;

/** Relative tolerance of a level's `period_us` against its width in samples. */
const LEVEL_PERIOD_TOLERANCE = 1e-12;

/** Level groups are named by positive integers. */
const LEVEL_NAME = /^[1-9]\d*$/;

/** Channel groups carry an integer name: a decimal integer with no leading zeros. */
const INTEGER_NAME = /^(?:0|[1-9]\d*)$/;

/** Returns a node's `tsz` attribute object. Throws when the node has none. */
function tszOf(node: Json, where: string): Json {
  const tsz = asObject(asObject(node.attributes)?.tsz);
  if (tsz === undefined) {
    throw new TypeError(`${where} has no tsz attributes`);
  }
  return tsz;
}

/**
 * Reads typed values out of a node's `tsz` object. Every error names the node and
 * the key. Keys the format does not define are never read.
 */
function tszReader(fields: Json, where: string) {
  const invalid = (key: string, expectation: string): TypeError =>
    new TypeError(
      `${where}: tsz.${key} must be ${expectation} (got ${JSON.stringify(fields[key])})`,
    );
  const missing = (key: string, expectation: string): TypeError =>
    new TypeError(`${where}: tsz.${key} is missing; it must be ${expectation}`);

  const optionalString = (key: string): string | undefined => {
    const value = fields[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw invalid(key, "a string");
    }
    return value;
  };

  const optionalInteger = (key: string): number | undefined => {
    const value = fields[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw invalid(key, "an integer");
    }
    return value;
  };

  return {
    string: (key: string): string => {
      const value = optionalString(key);
      if (value === undefined) {
        throw missing(key, "a string");
      }
      return value;
    },
    optionalString,
    positiveNumber: (key: string): number => {
      const value = fields[key];
      if (value === undefined) {
        throw missing(key, "a number greater than 0");
      }
      if (
        typeof value !== "number" ||
        !(value > 0) ||
        !Number.isFinite(value)
      ) {
        throw invalid(key, "a number greater than 0");
      }
      return value;
    },
    optionalInteger,
    integer: (key: string, fallback: number): number =>
      optionalInteger(key) ?? fallback,
    positiveInteger: (key: string): number => {
      const value = optionalInteger(key);
      if (value === undefined) {
        throw missing(key, "an integer greater than 0");
      }
      if (value <= 0) {
        throw invalid(key, "an integer greater than 0");
      }
      return value;
    },
    optionalStringArray: (key: string): string[] | undefined => {
      const value = fields[key];
      if (value === undefined) {
        return undefined;
      }
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        throw invalid(key, "an array of strings");
      }
      return value as string[];
    },
    optionalObject: (key: string): Json | undefined => {
      const value = fields[key];
      if (value === undefined) {
        return undefined;
      }
      const object = asObject(value);
      if (object === undefined || Array.isArray(object)) {
        throw invalid(key, "an object");
      }
      return object;
    },
  };
}

/** The nodes found under one channel group, by name. */
interface ChannelNodes {
  /** Arrays directly under the channel: `raw`, `events`, `text`, ... */
  readonly arrays: ReadonlyMap<string, Json>;
  /** Level groups directly under the channel, by level name. */
  readonly levelGroups: ReadonlyMap<string, Json>;
  /** Member arrays of each level group, by level name then member name. */
  readonly members: ReadonlyMap<string, ReadonlyMap<string, Json>>;
}

/** Reads a continuous channel: its attributes, raw array, runs, and level groups. */
function readContinuous(
  index: number,
  tsz: Json,
  nodes: ChannelNodes,
): ContinuousEntry {
  const where = `channel /${index}`;
  const attrs = tszReader(tsz, where);
  const name = attrs.string("name");
  const unit = attrs.string("unit");
  const rateHz = attrs.positiveNumber("rate_hz");
  const offsetUs = attrs.integer("offset_us", 0);
  const id = attrs.optionalString("id") ?? String(index);
  const provenance = attrs.optionalObject("provenance");

  // 1. The raw samples. Their period comes from the rate; the format defines no
  //    attributes on `raw`.
  const sampleCount = rank1Length(nodes.arrays.get("raw")?.shape);
  if (sampleCount === undefined) {
    throw new Error(`${where} must have a raw array of shape [n]`);
  }
  const periodUs = 1e6 / rateHz;
  const levels: LevelInfo[] = [
    {
      path: `/${index}/raw`,
      periodUs,
      samplesPerBin: 1,
      binCount: sampleCount,
      isMinMax: false,
    },
  ];

  // 2. The runs table, one row per run, when the recording paused. Its rows are
  //    read on demand; only the shape is checked here.
  const runsNode = nodes.arrays.get("runs");
  let runs: ContinuousEntry["runs"];
  if (runsNode !== undefined) {
    const dims = rank2(runsNode.shape);
    if (dims === undefined || dims[1] !== 3 || dims[0] < 1) {
      throw new Error(
        `${where} runs must have shape [runs, 3] with at least one run (got ${JSON.stringify(runsNode.shape)})`,
      );
    }
    runs = { path: `/${index}/runs`, rows: dims[0] };
  }

  // 3. One level per numbered group. `minmax` is what a trace reads; `count`, `mean`,
  //    and `var` describe the finite samples of each bin. A level's width
  //    in samples follows from its `period_us`, and each level nests over the one
  //    before it. The factor between levels is whatever their widths say; nothing
  //    assumes 4.
  const numbers = [...nodes.levelGroups.keys()].map(Number);
  numbers.sort((a, b) => a - b);
  if (numbers.some((number, position) => number !== position + 1)) {
    throw new Error(
      `${where}: levels must be numbered from 1 with no gap (got ${numbers.join(", ")})`,
    );
  }
  if (sampleCount === 0 && numbers.length > 0) {
    throw new Error(`${where} has no samples, so it must have no levels`);
  }
  let previousWidth = 0;
  for (const number of numbers) {
    const level = String(number);
    const group = nodes.levelGroups.get(level)!;
    const levelWhere = `level /${index}/${level}`;
    const levelPeriodUs = tszReader(
      tszOf(group, levelWhere),
      levelWhere,
    ).positiveNumber("period_us");

    const width = samplesPerBin(levelPeriodUs, rateHz);
    const exactPeriodUs = (width * 1e6) / rateHz;
    if (
      width < MIN_SAMPLES_PER_BIN ||
      width >= MAX_SAMPLES_PER_BIN ||
      Math.abs(levelPeriodUs - exactPeriodUs) >
        LEVEL_PERIOD_TOLERANCE * Math.abs(exactPeriodUs)
    ) {
      throw new Error(
        `${levelWhere}: tsz.period_us must be a whole number of samples from ${MIN_SAMPLES_PER_BIN} to ${MAX_SAMPLES_PER_BIN - 1} at rate_hz ${rateHz}, within ${LEVEL_PERIOD_TOLERANCE} relative (got ${levelPeriodUs})`,
      );
    }
    if (
      previousWidth > 0 &&
      (width % previousWidth !== 0 ||
        width < MIN_SAMPLES_PER_BIN * previousWidth)
    ) {
      throw new Error(
        `${levelWhere}: tsz.period_us must be a multiple of the level before it, at least ${MIN_SAMPLES_PER_BIN} times it (${width} samples after ${previousWidth})`,
      );
    }
    previousWidth = width;

    const binCount = levelBins(sampleCount, width);
    const members = nodes.members.get(level);
    const minmax = rank2(members?.get("minmax")?.shape);
    if (minmax === undefined || minmax[1] !== 2) {
      throw new Error(`${levelWhere} must have a minmax array of shape [n, 2]`);
    }
    if (minmax[0] !== binCount) {
      throw new Error(
        `${levelWhere} has ${binCount} bins but minmax has shape ${JSON.stringify(members?.get("minmax")?.shape)}`,
      );
    }
    for (const member of ["count", "mean", "var"]) {
      const node = members?.get(member);
      if (node !== undefined && rank1Length(node.shape) !== binCount) {
        throw new Error(
          `${levelWhere} has ${binCount} bins but ${member} has shape ${JSON.stringify(node.shape)}`,
        );
      }
    }
    const info: Mutable<LevelInfo> = {
      path: `/${index}/${level}/minmax`,
      periodUs: levelPeriodUs,
      samplesPerBin: width,
      binCount,
      isMinMax: true,
    };
    if (members?.has("count")) {
      info.countPath = `/${index}/${level}/count`;
    }
    if (members?.has("mean")) {
      info.meanPath = `/${index}/${level}/mean`;
    }
    if (members?.has("var")) {
      info.variancePath = `/${index}/${level}/var`;
    }
    levels.push(info);
  }

  const info: Mutable<ContinuousChannelInfo> = {
    kind: "continuous",
    index,
    id,
    name,
    unit,
    rateHz,
    startUs: offsetUs,
    endUs: channelEndUs(offsetUs, sampleCount, rateHz),
    runs: runs?.rows ?? (sampleCount > 0 ? 1 : 0),
  };
  if (provenance !== undefined) {
    info.provenance = provenance;
  }
  const entry: Mutable<ContinuousEntry> = {
    kind: "continuous",
    path: `/${index}`,
    info,
    levels,
    sampleCount,
  };
  if (runs !== undefined) {
    entry.runs = runs;
  }
  return entry;
}

/** Reads an event channel: its attributes, event columns, snippets, and count levels. */
function readEvent(index: number, tsz: Json, nodes: ChannelNodes): EventEntry {
  const where = `event channel /${index}`;
  const attrs = tszReader(tsz, where);
  const name = attrs.string("name");
  const id = attrs.optionalString("id") ?? String(index);
  const unit = attrs.optionalString("unit");
  const labelNames = attrs.optionalStringArray("label_names");
  if (labelNames?.length === 0) {
    throw new TypeError(
      `${where}: tsz.label_names must name at least one label`,
    );
  }
  const maxDurationUs = attrs.optionalInteger("max_duration_us");
  const provenance = attrs.optionalObject("provenance");

  // 1. The event times, which every column is indexed against.
  const count = rank1Length(nodes.arrays.get("events")?.shape);
  if (count === undefined) {
    throw new Error(`${where} must have an events array of shape [n]`);
  }
  const path = (leaf: string): `/${string}` => `/${index}/${leaf}`;

  // 2. The optional per-event columns. Each has one row per event.
  const column = (leaf: string): ColumnArray | undefined => {
    const node = nodes.arrays.get(leaf);
    if (node === undefined) {
      return undefined;
    }
    if (rank1Length(node.shape) !== count) {
      throw new Error(
        `${where} has ${count} events but ${leaf} has shape ${JSON.stringify(node.shape)}`,
      );
    }
    return { path: path(leaf) };
  };
  const rows = (leaf: string): RowArray | undefined => {
    const node = nodes.arrays.get(leaf);
    if (node === undefined) {
      return undefined;
    }
    const dims = rank2(node.shape);
    if (dims === undefined || dims[0] !== count) {
      throw new Error(
        `${where} has ${count} events but ${leaf} has shape ${JSON.stringify(node.shape)}`,
      );
    }
    return { path: path(leaf), width: dims[1] };
  };
  const snippets = (
    leaf: string,
    expectedRows?: number,
  ): WaveformArray | undefined => {
    const node = nodes.arrays.get(leaf);
    if (node === undefined) {
      return undefined;
    }
    const dims = rank2(node.shape);
    if (dims === undefined) {
      throw new Error(
        `${where} ${leaf} must have shape [rows, points] (got ${JSON.stringify(node.shape)})`,
      );
    }
    if (expectedRows !== undefined && dims[0] !== expectedRows) {
      throw new Error(
        `${where} has ${expectedRows} events but ${leaf} has ${dims[0]} rows`,
      );
    }
    const snippetWhere = `${where} ${leaf}`;
    const snippetAttrs = tszReader(tszOf(node, snippetWhere), snippetWhere);
    const eventSample = snippetAttrs.integer("event_sample", 0);
    if (eventSample < 0 || eventSample >= dims[1]) {
      throw new RangeError(
        `${snippetWhere}: tsz.event_sample must be in [0, ${dims[1]}) (got ${eventSample})`,
      );
    }
    return {
      path: path(leaf),
      rows: dims[0],
      pointsPerEvent: dims[1],
      periodUs: snippetAttrs.positiveNumber("period_us"),
      eventSample,
    };
  };

  const durations = column("durations");
  const labels = column("labels");
  const values = column("values");
  const text = rows("text");
  const channels = rows("channels");
  const waveforms = snippets("waveforms", count);
  const waveformMean = snippets("waveform_mean");

  // 3. Count levels. A level's period is a whole number of microseconds, and bin 0
  //    starts at offset_us, which defaults to 0.
  const countLevels: CountLevelInfo[] = [];
  for (const [level, group] of nodes.levelGroups) {
    const levelWhere = `count level /${index}/${level}`;
    const levelAttrs = tszReader(tszOf(group, levelWhere), levelWhere);
    const dims = rank2(nodes.members.get(level)?.get("count")?.shape);
    if (dims === undefined) {
      throw new Error(
        `${levelWhere} must have a count array of shape [bins, labels]`,
      );
    }
    countLevels.push({
      path: `/${index}/${level}/count`,
      level: Number(level),
      periodUs: levelAttrs.positiveInteger("period_us"),
      offsetUs: levelAttrs.integer("offset_us", 0),
      binCount: dims[0],
      labelCount: dims[1],
    });
  }
  countLevels.sort((a, b) => a.periodUs - b.periodUs);

  const arrays: Mutable<EventArrays> = {
    events: { path: path("events"), count },
    countLevels,
  };
  const columns: EventColumn[] = [];
  if (durations !== undefined) {
    arrays.durations =
      maxDurationUs === undefined ? durations : { ...durations, maxDurationUs };
    columns.push("durations");
  }
  if (labels !== undefined) {
    arrays.labels = labels;
    columns.push("labels");
  }
  if (values !== undefined) {
    arrays.values = values;
    columns.push("values");
  }
  if (text !== undefined) {
    arrays.text = text;
    columns.push("text");
  }
  if (channels !== undefined) {
    arrays.channels = channels;
    columns.push("channels");
  }
  if (waveforms !== undefined) {
    arrays.waveforms = waveforms;
    columns.push("waveforms");
  }
  if (waveformMean !== undefined) {
    arrays.waveformMean = waveformMean;
  }

  const info: Mutable<EventChannelInfo> = {
    kind: "event",
    index,
    id,
    name,
    eventCount: count,
    columns,
    hasWaveformMean: waveformMean !== undefined,
    countLevels: countLevels.length,
  };
  if (unit !== undefined) {
    info.unit = unit;
  }
  if (labelNames !== undefined) {
    info.labelNames = labelNames;
  }
  if (maxDurationUs !== undefined) {
    info.maxDurationUs = maxDurationUs;
  }
  if (provenance !== undefined) {
    info.provenance = provenance;
  }
  return { kind: "event", path: `/${index}`, info, arrays };
}

/** Parses the root `zarr.json` and checks it is a Zarr v3 group. */
async function readRoot(store: Store): Promise<Json> {
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
  return root;
}

/**
 * Returns the root's `tsz.version`. Throws when it is absent or malformed, or when
 * its major version is not the one this reader implements.
 */
function readVersion(root: Json): string {
  const version = asObject(asObject(root.attributes)?.tsz)?.version;
  if (version === undefined) {
    throw new Error(
      "/zarr.json has no tsz.version; a bundle written before TS-Zarr 1.0 has none, " +
        "and this reader does not read that layout",
    );
  }
  const match = typeof version === "string" && /^(\d+)\.\d+$/.exec(version);
  if (!match) {
    throw new Error(
      `/zarr.json tsz.version must be "major.minor" (got ${JSON.stringify(version)})`,
    );
  }
  if (Number(match[1]) !== SPEC_MAJOR_VERSION) {
    throw new Error(
      `bundle is TS-Zarr ${version}; this reader implements ${SPEC_MAJOR_VERSION}.x`,
    );
  }
  return version;
}

/**
 * Reads a bundle's root metadata and enumerates its channels.
 *
 * The bundle is read in one request to `/zarr.json`, whose `consolidated_metadata`
 * inlines every descendant's metadata. The store tree is never walked.
 *
 * Every child group of the root with an integer name whose `tsz.kind` is `continuous`
 * or `event` is a channel. Other groups, arrays, and kinds are ignored, as are `tsz`
 * keys and child nodes the format does not define, so a bundle from a later 1.x
 * release still opens. A continuous channel's levels are returned finest first, the
 * raw samples before any `minmax` level. An event channel's arrays are read into
 * {@link EventArrays}.
 *
 * Throws for a missing `/zarr.json`, invalid JSON, a root that is not a Zarr v3 group,
 * a missing or non-1.x `tsz.version`, missing `consolidated_metadata`, a channel or
 * level missing an array or attribute its kind requires, a column whose length is
 * not the channel's event count. Channels may share an id.
 */
export async function readCatalog(store: Store): Promise<BundleCatalog> {
  const root = await readRoot(store);
  const version = readVersion(root);

  const nodes = asObject(asObject(root.consolidated_metadata)?.metadata);
  if (nodes === undefined) {
    throw new Error("/zarr.json has no consolidated_metadata");
  }

  // 1. Index every node by the channel it sits under. Consolidated paths are flat and
  //    relative: "0" a channel group, "0/raw" an array, "0/1" a level group, and
  //    "0/1/minmax" a level member. Deeper nodes belong to nothing the format defines.
  //    A root child without an integer name is not a channel group.
  const channelGroups = new Map<string, Json>();
  const arraysByChannel = new Map<string, Map<string, Json>>();
  const levelGroupsByChannel = new Map<string, Map<string, Json>>();
  const membersByChannel = new Map<string, Map<string, Map<string, Json>>>();
  const under = <V>(index: Map<string, Map<string, V>>, key: string) => {
    let entry = index.get(key);
    if (entry === undefined) {
      entry = new Map();
      index.set(key, entry);
    }
    return entry;
  };

  for (const [nodePath, value] of Object.entries(nodes)) {
    const node = asObject(value);
    const [key, leaf, member, ...rest] = nodePath.split("/");
    if (node === undefined || key === undefined || key === "") {
      continue;
    }
    if (leaf === undefined) {
      if (node.node_type === "group" && INTEGER_NAME.test(key)) {
        channelGroups.set(key, node);
      }
    } else if (member === undefined) {
      if (node.node_type === "group" && LEVEL_NAME.test(leaf)) {
        under(levelGroupsByChannel, key).set(leaf, node);
      } else if (node.node_type === "array") {
        under(arraysByChannel, key).set(leaf, node);
      }
    } else if (
      rest.length === 0 &&
      node.node_type === "array" &&
      LEVEL_NAME.test(leaf)
    ) {
      under(under(membersByChannel, key), leaf).set(member, node);
    }
  }

  // 2. Read each channel group by its kind.
  const channels: ChannelEntry[] = [];
  const byId = new Map<string, ChannelEntry[]>();
  const idByIndex = new Map<number, string>();

  for (const [name, group] of channelGroups) {
    const tsz = asObject(asObject(group.attributes)?.tsz);
    const kind = tsz?.kind;
    if (tsz === undefined || (kind !== "continuous" && kind !== "event")) {
      continue;
    }
    const index = Number(name);
    const channelNodes: ChannelNodes = {
      arrays: arraysByChannel.get(name) ?? new Map(),
      levelGroups: levelGroupsByChannel.get(name) ?? new Map(),
      members: membersByChannel.get(name) ?? new Map(),
    };
    const entry =
      kind === "continuous"
        ? readContinuous(index, tsz, channelNodes)
        : readEvent(index, tsz, channelNodes);

    channels.push(entry);
    const sharing = byId.get(entry.info.id);
    if (sharing === undefined) {
      byId.set(entry.info.id, [entry]);
    } else {
      sharing.push(entry);
    }
    idByIndex.set(index, entry.info.id);
  }

  return { version, channels, byId, idByIndex };
}
