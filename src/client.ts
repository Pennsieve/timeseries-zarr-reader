import type {
  BundleCatalog,
  ChannelEntry,
  LevelInfo,
  UnitArrays,
} from "./catalog.js";
import { binRange, readCatalog, selectLevel } from "./catalog.js";
import { MAX_RAW_BYTES, RESAMPLE_PIXEL_RATIO } from "./constants.js";
import type { FetchLimit } from "./fetch.js";
import { createFetchLimit } from "./fetch.js";
import type { FilterSession } from "./filter.js";
import { createFilterSession } from "./filter.js";
import { montageChannelKey, subtract } from "./montage.js";
import { resampleToPixels } from "./resample.js";
import type {
  ChannelInfo,
  EventBatch,
  FilterSpec,
  MontagePair,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";
import { queryUnitChannel } from "./unit.js";
import { readBins } from "./zarr.js";

/** Bytes per raw sample on disk. */
const BYTES_PER_RAW_SAMPLE = 4;

/**
 * Thrown when a forced-raw read would exceed the byte cap.
 *
 * Raised before any data is fetched. `requestedBytes` is the size the read would have
 * fetched; `maxBytes` is the cap in effect. Retry with a narrower window or a higher
 * `maxRawBytes`.
 */
export class RawReadTooLargeError extends Error {
  readonly requestedBytes: number;
  readonly maxBytes: number;

  constructor(requestedBytes: number, maxBytes: number) {
    super(
      `a raw read of ${requestedBytes} bytes exceeds the ${maxBytes}-byte cap; ` +
        `narrow the window or raise maxRawBytes on the query`,
    );
    this.name = "RawReadTooLargeError";
    this.requestedBytes = requestedBytes;
    this.maxBytes = maxBytes;
  }
}

/** Constructor options for {@link StreamingClient}. */
export interface StreamingClientOptions {
  readonly store: Store;
  /** Default cap in bytes on forced-raw reads (15 MB). Overridable per query. */
  readonly maxRawBytes?: number;
}

/** Options for one continuous query. Times are UTC microseconds; `endUs` is exclusive. */
export interface QueryOptions {
  /**
   * Channel ids to read. Exactly one of `channels` and `montage` carries the query's
   * traces; supplying both or neither throws.
   */
  readonly channels?: readonly string[];
  readonly startUs: number;
  readonly endUs: number;
  /** Time one pixel column covers. Drives level selection and the final resample. */
  readonly pixelWidthUs: number;
  /**
   * Returns raw samples with no decimation or resampling. Defaults to false. Forces a read
   * of the raw level, subject to the byte cap.
   */
  readonly raw?: boolean;
  /** Bipolar pairs to render, in place of `channels`. Each pair is one trace. */
  readonly montage?: readonly MontagePair[];
  /** Butterworth filter applied to every trace. Forces a raw read. */
  readonly filter?: FilterSpec;
  /** Cap override in bytes for this query's forced-raw read. */
  readonly maxRawBytes?: number;
  /**
   * Aborts this query's reads. An already-aborted signal rejects before any I/O. A catalog
   * load in flight for another query is shared and runs to completion.
   */
  readonly signal?: AbortSignal;
}

/** Options for one unit-channel query. Times are UTC microseconds; `endUs` is exclusive. */
export interface UnitQueryOptions {
  readonly channels: readonly string[];
  readonly startUs: number;
  readonly endUs: number;
  /** Time one pixel column covers. Gates whether waveforms are fetched. */
  readonly pixelWidthUs: number;
  readonly signal?: AbortSignal;
}

/** Options for a data-availability query over one channel. */
export interface DataSpanOptions {
  readonly channel: string;
  readonly startUs: number;
  readonly endUs: number;
  /** Gaps no wider than this are bridged into one span. Defaults to 0: every gap splits. */
  readonly gapThresholdUs?: number;
  readonly signal?: AbortSignal;
}

/** One planned level read. */
interface PlannedRead {
  readonly level: LevelInfo;
  /** Bin index range within the level, clamped to the bins it has. */
  readonly range: { start: number; end: number };
  /** Absolute time of the first bin in `range`. */
  readonly startUs: number;
}

/** One planned output trace. */
interface PlannedTrace {
  readonly channel: string;
  readonly rateHz: number;
  readonly read: PlannedRead;
  /** Second read of a montage pair. Its samples are subtracted from `read`'s. */
  readonly secondaryRead?: PlannedRead;
}

/** A read settled to a value or an error. */
type SettledRead =
  { ok: true; data: Float64Array } | { ok: false; error: unknown };

/**
 * Reads one bundle by channel id and time window.
 *
 * The constructor performs no I/O; the catalog is read on first use and cached for the
 * client's lifetime.
 *
 * Filter state also lives for the client's lifetime: queries over adjacent windows filter as
 * one continuous signal, whether or not their seam falls on a sample. A jump backwards or a
 * gap wider than a hundred samples restarts the filter for that channel.
 *
 * Reads of pyramid levels share an in-flight concurrency cap. Unit-channel reads do not.
 */
export class StreamingClient {
  readonly #store: Store;
  readonly #maxRawBytes: number;
  readonly #limit: FetchLimit;
  readonly #filters: FilterSession;
  #catalog: Promise<BundleCatalog> | undefined;

  constructor(options: StreamingClientOptions) {
    this.#store = options.store;
    this.#maxRawBytes = options.maxRawBytes ?? MAX_RAW_BYTES;
    this.#limit = createFetchLimit();
    this.#filters = createFilterSession();
  }

  /** Returns per-channel info for every channel in the bundle. Returned objects are copies. */
  async channelInfo(): Promise<ChannelInfo[]> {
    const catalog = await this.#loadCatalog();
    return catalog.channels.map((entry) => ({ ...entry.info }));
  }

  /**
   * Reads continuous channels over a window, yielding one segment per trace in request
   * order.
   *
   * Each trace reads the coarsest pyramid level whose bins fit within one pixel. A filter,
   * a montage, or `raw: true` forces the raw level. A forced-raw read that would exceed the
   * byte cap throws {@link RawReadTooLargeError} before any data is fetched. Unless `raw` is
   * set, output is resampled onto the pixel grid when one pixel spans more than three
   * source bins.
   *
   * Segments are delivered on bin boundaries, so one may begin before `startUs` or end after
   * `endUs` by less than one of its own bins; clipping to the exact window is the caller's
   * concern. The exception is a filtered segment continuing from the previous query, which
   * begins at the first sample that query did not already return. A window with no overlap
   * yields empty data, with `startUs` clamped to the channel's extent.
   *
   * Rejects when `channels` and `montage` are both supplied or both empty, and for an
   * unknown channel id, a unit channel, a montage pair whose rates or sample grids differ,
   * a non-positive `pixelWidthUs`, or an `endUs` before `startUs`. Being a generator, it
   * reports these on the first iteration rather than on the call.
   */
  async *query(params: QueryOptions): AsyncGenerator<Segment, void, undefined> {
    params.signal?.throwIfAborted();
    requirePixelWidth(params.pixelWidthUs);
    requireWindow(params.startUs, params.endUs);

    const raw = params.raw ?? false;
    const channels = params.channels ?? [];
    const montage = params.montage ?? [];
    requireOneTraceSource(channels, montage);

    const forceRaw = params.filter !== undefined || montage.length > 0 || raw;
    const catalog = await this.#loadCatalog();
    const opts = toStoreOptions(params.signal);

    const traces =
      montage.length > 0
        ? montage.map((pair) => this.#planMontage(catalog, pair, params))
        : channels.map((id) =>
            this.#planChannel(catalog, id, params, forceRaw),
          );

    if (forceRaw) {
      assertWithinByteCap(traces, params.maxRawBytes ?? this.#maxRawBytes);
    }

    // Settling each read up front avoids unhandled rejections when iteration stops early.
    const started = traces.map((trace) => ({
      trace,
      lead: this.#startRead(trace.read, opts),
      secondary:
        trace.secondaryRead === undefined
          ? undefined
          : this.#startRead(trace.secondaryRead, opts),
    }));

    for (const { trace, lead, secondary } of started) {
      const first = unwrapRead(await lead);
      const second =
        secondary === undefined ? undefined : unwrapRead(await secondary);

      let segment: Segment = {
        channel: trace.channel,
        startUs: trace.read.startUs,
        samplePeriodUs: trace.read.level.periodUs,
        isMinMax: trace.read.level.isMinMax,
        data: second === undefined ? first : subtract(first, second),
      };

      if (params.filter) {
        segment = this.#filters.apply(segment, params.filter, trace.rateHz);
      }
      if (
        !raw &&
        params.pixelWidthUs > RESAMPLE_PIXEL_RATIO * segment.samplePeriodUs
      ) {
        segment = resampleToPixels(segment, params.pixelWidthUs);
      }
      yield segment;
    }
  }

  /**
   * Reads unit channels over a window, yielding one event batch per channel in request
   * order.
   *
   * Channels are read sequentially. Throws for an unknown channel id, a continuous
   * channel, or a non-positive `pixelWidthUs`.
   */
  async *queryUnits(
    params: UnitQueryOptions,
  ): AsyncGenerator<EventBatch, void, undefined> {
    params.signal?.throwIfAborted();
    requirePixelWidth(params.pixelWidthUs);
    requireWindow(params.startUs, params.endUs);
    const catalog = await this.#loadCatalog();
    const opts = toStoreOptions(params.signal);

    for (const id of params.channels) {
      const unit = unitArrays(catalog, id);
      yield await queryUnitChannel(this.#store, id, unit, params, opts);
    }
  }

  /**
   * Returns the spans where a channel has data, as `[startUs, endUs)` pairs clamped to the
   * window.
   *
   * Reads the coarsest pyramid level and treats a bin as populated when any of its values
   * is finite. Consecutive populated bins merge into one span; gaps no wider than
   * `gapThresholdUs` are bridged. Span edges align to that level's bin boundaries. Throws
   * for an unknown channel id, a unit channel, or an `endUs` before `startUs`.
   */
  async dataSpans(
    params: DataSpanOptions,
  ): Promise<Array<[startUs: number, endUs: number]>> {
    params.signal?.throwIfAborted();
    requireWindow(params.startUs, params.endUs);
    const catalog = await this.#loadCatalog();
    const opts = toStoreOptions(params.signal);
    const entry = continuousEntry(catalog, params.channel);
    // Levels are sorted finest-first, and a continuous channel has at least one.
    const level = entry.levels[entry.levels.length - 1]!;

    const read = planRead(entry, level, params);
    const data = await this.#limit(() =>
      readBins(this.#store, level.path, read.range, opts),
    );

    const gapThresholdUs = params.gapThresholdUs ?? 0;
    const valuesPerBin = level.isMinMax ? 2 : 1;
    const binCount = data.length / valuesPerBin;
    const spans: Array<[startUs: number, endUs: number]> = [];

    for (let bin = 0; bin < binCount; bin++) {
      const firstValue = bin * valuesPerBin;
      const binValues = data.subarray(firstValue, firstValue + valuesPerBin);
      if (!binValues.some((value) => Number.isFinite(value))) {
        continue;
      }

      const binStartUs = Math.max(
        read.startUs + bin * level.periodUs,
        params.startUs,
      );
      const binEndUs = Math.min(
        read.startUs + (bin + 1) * level.periodUs,
        params.endUs,
      );
      const last = spans[spans.length - 1];
      if (last !== undefined && binStartUs - last[1] <= gapThresholdUs) {
        last[1] = binEndUs;
      } else {
        spans.push([binStartUs, binEndUs]);
      }
    }

    return spans;
  }

  #loadCatalog(): Promise<BundleCatalog> {
    return (this.#catalog ??= readCatalog(this.#store).catch(
      (error: unknown) => {
        // Clear the cached promise on failure so the next call retries.
        this.#catalog = undefined;
        throw error;
      },
    ));
  }

  /** Plans the trace for one channel. */
  #planChannel(
    catalog: BundleCatalog,
    id: string,
    params: QueryOptions,
    forceRaw: boolean,
  ): PlannedTrace {
    const entry = continuousEntry(catalog, id);
    const level = forceRaw
      ? rawLevel(entry)
      : selectLevel(entry.levels, params.pixelWidthUs);
    return {
      channel: id,
      rateHz: entry.info.rateHz,
      read: planRead(entry, level, params),
    };
  }

  /** Plans the trace for a montage pair: two raw reads over the pair's shared window. */
  #planMontage(
    catalog: BundleCatalog,
    pair: MontagePair,
    window: { startUs: number; endUs: number },
  ): PlannedTrace {
    const lead = continuousEntry(catalog, pair.lead);
    const secondary = continuousEntry(catalog, pair.secondary);
    if (lead.info.rateHz !== secondary.info.rateHz) {
      throw new Error(
        `montage pair ${pair.lead}/${pair.secondary} mixes rates ` +
          `(${lead.info.rateHz} Hz and ${secondary.info.rateHz} Hz)`,
      );
    }

    // Subtraction pairs samples by index: the channels must share a sample grid, with
    // equal periods and starts a whole number of periods apart.
    const leadRaw = rawLevel(lead);
    const secondaryRaw = rawLevel(secondary);
    const offsetUs = lead.info.startUs - secondary.info.startUs;
    if (
      leadRaw.periodUs !== secondaryRaw.periodUs ||
      offsetUs % leadRaw.periodUs !== 0
    ) {
      throw new Error(
        `montage pair ${pair.lead}/${pair.secondary} cannot be aligned: ` +
          `sample periods differ or the start offset is not a whole number of periods`,
      );
    }

    // Reading the window both channels can serve keeps the two reads index-aligned when
    // one channel starts or ends inside the other's extent.
    const sharedStartUs = Math.max(
      window.startUs,
      lead.info.startUs,
      secondary.info.startUs,
    );
    const sharedEndUs = Math.max(
      Math.min(window.endUs, lead.info.endUs, secondary.info.endUs),
      sharedStartUs,
    );
    const shared = { startUs: sharedStartUs, endUs: sharedEndUs };

    return {
      channel: montageChannelKey(lead.info, secondary.info),
      rateHz: lead.info.rateHz,
      read: planRead(lead, leadRaw, shared),
      secondaryRead: planRead(secondary, secondaryRaw, shared),
    };
  }

  /** Starts one read under the in-flight cap. The returned promise never rejects. */
  #startRead(
    read: PlannedRead,
    opts: StoreOptions | undefined,
  ): Promise<SettledRead> {
    return this.#limit(() =>
      readBins(this.#store, read.level.path, read.range, opts),
    )
      .then((data): SettledRead => ({ ok: true, data }))
      .catch((error: unknown): SettledRead => ({ ok: false, error }));
  }
}

/** Throws a RangeError unless `pixelWidthUs` is positive. */
function requirePixelWidth(pixelWidthUs: number): void {
  if (!(pixelWidthUs > 0)) {
    throw new RangeError(
      `pixelWidthUs must be greater than 0 (got ${pixelWidthUs})`,
    );
  }
}

/**
 * Throws a RangeError for a window that ends before it starts.
 *
 * Checked up front because a montage clamps its window to the pair's shared extent, which
 * would otherwise repair the inversion and read an empty window instead of reporting it.
 */
function requireWindow(startUs: number, endUs: number): void {
  if (endUs < startUs) {
    throw new RangeError(
      `endUs must not precede startUs (got ${startUs} and ${endUs})`,
    );
  }
}

/** Throws unless exactly one of `channels` and `montage` is non-empty. */
function requireOneTraceSource(
  channels: readonly string[],
  montage: readonly MontagePair[],
): void {
  if (channels.length > 0 && montage.length > 0) {
    throw new Error(
      "a query takes either channels or montage, not both; supply one and omit the other",
    );
  }
  if (channels.length === 0 && montage.length === 0) {
    throw new Error(
      "a query has no traces; supply at least one channel id or one montage pair",
    );
  }
}

/** Throws {@link RawReadTooLargeError} when the planned reads total more than `cap` bytes. */
function assertWithinByteCap(
  traces: readonly PlannedTrace[],
  cap: number,
): void {
  const requestedBytes = traces.reduce(
    (sum, trace) =>
      sum +
      readBytes(trace.read) +
      (trace.secondaryRead === undefined ? 0 : readBytes(trace.secondaryRead)),
    0,
  );
  if (requestedBytes > cap) {
    throw new RawReadTooLargeError(requestedBytes, cap);
  }
}

/** Returns the size of a planned read in bytes. */
function readBytes(read: PlannedRead): number {
  return (read.range.end - read.range.start) * BYTES_PER_RAW_SAMPLE;
}

/** Returns a settled read's data, or rethrows its error. */
function unwrapRead(result: SettledRead): Float64Array {
  if (!result.ok) {
    throw result.error;
  }
  return result.data;
}

function toStoreOptions(signal?: AbortSignal): StoreOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

/** Returns the catalog entry for a channel id. Throws for an unknown id. */
function channelEntry(catalog: BundleCatalog, id: string): ChannelEntry {
  const entry = catalog.byId.get(id);
  if (entry === undefined) {
    throw new Error(`no channel with id ${id}`);
  }
  return entry;
}

/** Returns the entry for a continuous channel. Throws for an unknown id or a unit channel. */
function continuousEntry(catalog: BundleCatalog, id: string): ChannelEntry {
  const entry = channelEntry(catalog, id);
  if (entry.info.kind !== "continuous") {
    throw new Error(`channel ${id} is a unit channel; use queryUnits()`);
  }
  return entry;
}

/** Returns the unit arrays for a channel. Throws for an unknown id or a continuous channel. */
function unitArrays(catalog: BundleCatalog, id: string): UnitArrays {
  const entry = channelEntry(catalog, id);
  if (entry.unit === undefined) {
    throw new Error(`channel ${id} is not a unit channel; use query()`);
  }
  return entry.unit;
}

/** Returns the raw (level 0) entry of a continuous channel. */
function rawLevel(entry: ChannelEntry): LevelInfo {
  // readCatalog rejects a continuous channel that has no raw level.
  return entry.levels.find((level) => !level.isMinMax)!;
}

/** Plans a read of one level, clamped to a window. */
function planRead(
  entry: ChannelEntry,
  level: LevelInfo,
  window: { startUs: number; endUs: number },
): PlannedRead {
  const grid = {
    startUs: entry.info.startUs,
    periodUs: level.periodUs,
    binCount: level.binCount,
  };
  const range = binRange(grid, window.startUs, window.endUs);
  return {
    level,
    range,
    startUs: grid.startUs + range.start * level.periodUs,
  };
}
