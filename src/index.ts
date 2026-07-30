import type {
  BundleCatalog,
  ChannelEntry,
  LevelInfo,
  UnitArrays,
} from "./catalog.js";
import { binRange, readCatalog, selectLevel } from "./catalog.js";
import { FILTER_MAX_BYTES, RESAMPLE_PIXEL_RATIO } from "./constants.js";
import type { FetchLimit } from "./fetch.js";
import { createFetchLimit } from "./fetch.js";
import type { FilterSession } from "./filter.js";
import { createFilterSession } from "./filter.js";
import { compoundKey, subtract } from "./montage.js";
import { resampleToPixels } from "./resample.js";
import type {
  ChannelInfo,
  Event,
  FilterSpec,
  MontagePair,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";
import { queryUnitChannel } from "./unit.js";
import { readBins } from "./zarr.js";

export type {
  ByteRange,
  ChannelInfo,
  Event,
  FilterSpec,
  MontagePair,
  Segment,
  Store,
  StoreOptions,
} from "./types.js";
export { openBundle } from "./stores/open-bundle.js";
export { FetchStore } from "./stores/open-bundle.js";

/** On-disk width of one raw sample, for sizing a read before it is issued. */
const BYTES_PER_RAW_SAMPLE = 4;

/**
 * A raw read was refused because it would fetch more than the byte cap allows.
 *
 * Raised before anything is fetched. The consumer chooses what happens next: narrow the
 * window, or re-issue the same query with a higher `filterMaxBytes` to spend the bandwidth
 * knowingly. `requestedBytes` and `maxBytes` are carried so the choice can be put to the user
 * in concrete terms.
 */
export class FilterWindowTooWide extends Error {
  readonly requestedBytes: number;
  readonly maxBytes: number;

  constructor(requestedBytes: number, maxBytes: number) {
    super(
      `a raw read of ${requestedBytes} bytes exceeds the ${maxBytes}-byte cap; ` +
        `narrow the window or raise filterMaxBytes on the query`,
    );
    this.name = "FilterWindowTooWide";
    this.requestedBytes = requestedBytes;
    this.maxBytes = maxBytes;
  }
}

/** How to construct a client: the store to read from, and an optional byte-cap default. */
export type StreamingClientOptions = {
  store: Store;
  /** Default cap on forced-raw reads, overridable per query. */
  filterMaxBytes?: number;
};

/** One continuous query. Times are UTC microseconds; `endUs` is exclusive. */
export type QueryParams = {
  /** Channel ids to read. Ignored when `montage` is present. */
  channels: string[];
  startUs: number;
  endUs: number;
  /** Time one pixel column covers; drives level selection and the final resample. */
  pixelWidthUs: number;
  /**
   * Accept decimated output. Defaults to true. False forces a raw read - subject to the byte
   * cap - and disables the final resample, so samples arrive exactly as stored.
   */
  minMax?: boolean;
  /** Bipolar pairs to render. When present, the pairs are the query's traces. */
  montage?: MontagePair[];
  /** Butterworth filter applied to every trace. Forces a raw read. */
  filter?: FilterSpec;
  /** Cap override for this query's forced-raw read. */
  filterMaxBytes?: number;
  signal?: AbortSignal;
};

/** One unit query. Times are UTC microseconds; `endUs` is exclusive. */
export type UnitQueryParams = {
  channels: string[];
  startUs: number;
  endUs: number;
  /** Time one pixel column covers; gates whether waveforms are fetched. */
  pixelWidthUs: number;
  signal?: AbortSignal;
};

/** Data-availability parameters for one channel's scrubber view. */
export type SegmentSpanParams = {
  channel: string;
  startUs: number;
  endUs: number;
  /** Gaps no wider than this are bridged into one span. Defaults to 0: every gap splits. */
  gapThresholdUs?: number;
};

/** One planned array read: which level, which bins, and where the result starts in time. */
type PlannedRead = {
  level: LevelInfo;
  range: { start: number; end: number };
  startUs: number;
};

/** One output trace: its name, rate, and the read (or pair of reads) behind it. */
type PlannedTrace = {
  channel: string;
  rateHz: number;
  reads: PlannedRead[];
};

/** A settled read, so an abandoned generator leaves no unhandled rejection behind. */
type SettledRead =
  { ok: true; data: Float64Array } | { ok: false; error: unknown };

/**
 * The reader's front door: one bundle, addressed by channel id, queried by time window.
 *
 * Construction is free of I/O. The catalog is read once, on the first call that needs it, and
 * cached for the client's lifetime. Filter state is also client-lifetime: consecutive queries
 * over adjacent windows filter as one continuous signal, and a jump or a gap resets the state
 * per channel.
 *
 * A query fans its array reads through a shared in-flight cap, so a wide multi-channel request
 * does not open a connection per chunk.
 */
export class StreamingClient {
  readonly #store: Store;
  readonly #filterMaxBytes: number;
  readonly #limit: FetchLimit;
  readonly #filters: FilterSession;
  #catalog: Promise<BundleCatalog> | undefined;

  constructor(options: StreamingClientOptions) {
    this.#store = options.store;
    this.#filterMaxBytes = options.filterMaxBytes ?? FILTER_MAX_BYTES;
    this.#limit = createFetchLimit();
    this.#filters = createFilterSession();
  }

  /**
   * Per-channel info for every channel in the bundle, from the catalog's single metadata
   * read. Returned objects are copies; the catalog stays private.
   */
  async channelInfo(): Promise<ChannelInfo[]> {
    const catalog = await this.#load();
    return catalog.channels.map((entry) => ({ ...entry.info }));
  }

  /**
   * Read continuous channels over a window, one segment per trace, in request order.
   *
   * The pipeline per trace: pick a pyramid level, read its bins, subtract for a montage pair,
   * filter, then resample onto the pixel grid. The level is the coarsest whose bins fit within
   * one pixel; an active filter, a montage, or `minMax: false` forces the raw level instead,
   * because pre-decimated envelopes cannot be filtered or differenced exactly.
   *
   * A forced-raw read is sized before it is issued and refused with {@link FilterWindowTooWide}
   * when it would exceed the byte cap; nothing is fetched on refusal. The final resample runs
   * only when decimated output is accepted and one pixel spans more than
   * `RESAMPLE_PIXEL_RATIO` source bins - below that the data is already at pixel resolution
   * and arrives as fetched.
   *
   * A window with no overlap yields a segment with empty data, keeping every requested trace
   * present in the output. Throws for an unknown channel id, a unit channel, a montage pair
   * whose rates differ, or a `pixelWidthUs` that is not above zero.
   */
  async *query(params: QueryParams): AsyncGenerator<Segment, void, undefined> {
    if (!(params.pixelWidthUs > 0)) {
      throw new RangeError(
        `pixelWidthUs must be greater than 0 (got ${params.pixelWidthUs})`,
      );
    }

    const minMax = params.minMax ?? true;
    const montage = params.montage ?? [];
    const forceRaw =
      params.filter !== undefined || montage.length > 0 || !minMax;
    const catalog = await this.#load();
    const opts = toStoreOptions(params.signal);

    const traces: PlannedTrace[] =
      montage.length > 0
        ? montage.map((pair) => this.#planMontage(catalog, pair, params))
        : params.channels.map((id) => {
            const entry = continuousEntry(catalog, id);
            const level = forceRaw
              ? rawLevel(entry)
              : selectLevel(entry.levels, params.pixelWidthUs);
            return {
              channel: id,
              rateHz: entry.info.rateHz,
              reads: [planRead(entry, level, params)],
            };
          });

    if (forceRaw) {
      const cap = params.filterMaxBytes ?? this.#filterMaxBytes;
      const requested =
        traces
          .flatMap((trace) => trace.reads)
          .reduce((sum, read) => sum + (read.range.end - read.range.start), 0) *
        BYTES_PER_RAW_SAMPLE;
      if (requested > cap) {
        throw new FilterWindowTooWide(requested, cap);
      }
    }

    // Every read starts now, capped by the in-flight limit, and settles into a value or an
    // error. Settling keeps an abandoned generator from leaving rejections unhandled.
    const settled = traces.map((trace) =>
      trace.reads.map((read): Promise<SettledRead> =>
        this.#limit(() =>
          readBins(this.#store, read.level.path, read.range, opts),
        )
          .then((data): SettledRead => ({ ok: true, data }))
          .catch((error: unknown): SettledRead => ({ ok: false, error })),
      ),
    );

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i] as PlannedTrace;
      const parts: Float64Array[] = [];
      for (const pending of settled[i] as Promise<SettledRead>[]) {
        const result = await pending;
        if (!result.ok) {
          throw result.error;
        }
        parts.push(result.data);
      }

      const lead = trace.reads[0] as PlannedRead;
      let segment: Segment = {
        channel: trace.channel,
        startUs: lead.startUs,
        samplePeriodUs: lead.level.periodUs,
        isMinMax: lead.level.isMinMax,
        data:
          parts.length === 2
            ? subtract(parts[0] as Float64Array, parts[1] as Float64Array)
            : (parts[0] as Float64Array),
      };

      if (params.filter) {
        segment = this.#filters.apply(segment, params.filter, trace.rateHz);
      }
      if (
        minMax &&
        params.pixelWidthUs > RESAMPLE_PIXEL_RATIO * segment.samplePeriodUs
      ) {
        segment = resampleToPixels(segment, params.pixelWidthUs);
      }
      yield segment;
    }
  }

  /**
   * Read unit channels over a window, one event batch per channel, in request order.
   *
   * Channels are read sequentially: each is dominated by its binary search over the events
   * array, which is inherently serial. Throws for an unknown channel id, a channel that is not
   * a unit channel, or a `pixelWidthUs` that is not above zero.
   */
  async *queryUnits(
    params: UnitQueryParams,
  ): AsyncGenerator<Event, void, undefined> {
    if (!(params.pixelWidthUs > 0)) {
      throw new RangeError(
        `pixelWidthUs must be greater than 0 (got ${params.pixelWidthUs})`,
      );
    }
    const catalog = await this.#load();
    const opts = toStoreOptions(params.signal);

    for (const id of params.channels) {
      const unit = unitArrays(catalog, id);
      yield await queryUnitChannel(this.#store, id, unit, params, opts);
    }
  }

  /**
   * Where a channel has data, as `[startUs, endUs)` spans clamped to the window.
   *
   * Reads the coarsest pyramid level - the cheapest view of the whole recording - and treats a
   * bin as having data when any of its values is finite. Runs of such bins become spans, and
   * gaps no wider than `gapThresholdUs` are bridged. Span edges land on that level's bin
   * boundaries, so they are as coarse as the level read.
   *
   * Throws for an unknown channel id or a unit channel, whose extent lives in its events
   * rather than in any pyramid.
   */
  async getSegmentSpans(
    params: SegmentSpanParams,
  ): Promise<Array<[number, number]>> {
    const catalog = await this.#load();
    const entry = continuousEntry(catalog, params.channel);
    const level = entry.levels[entry.levels.length - 1] as LevelInfo;

    const read = planRead(entry, level, params);
    const data = await this.#limit(() =>
      readBins(this.#store, level.path, read.range),
    );

    const gapThresholdUs = params.gapThresholdUs ?? 0;
    const valuesPerBin = level.isMinMax ? 2 : 1;
    const binCount = data.length / valuesPerBin;
    const spans: Array<[number, number]> = [];

    for (let bin = 0; bin < binCount; bin++) {
      let hasData = false;
      for (let v = bin * valuesPerBin; v < (bin + 1) * valuesPerBin; v++) {
        if (Number.isFinite(data[v] as number)) {
          hasData = true;
          break;
        }
      }
      if (!hasData) {
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

  #load(): Promise<BundleCatalog> {
    return (this.#catalog ??= readCatalog(this.#store).catch(
      (error: unknown) => {
        // A failed read is not a catalog: forget it so the next call retries.
        this.#catalog = undefined;
        throw error;
      },
    ));
  }

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

    // Subtraction pairs samples by index, so the two channels must sample the same
    // instants: equal periods, and start times a whole number of periods apart.
    const leadRaw = rawLevel(lead);
    const secondaryRaw = rawLevel(secondary);
    const offsetUs = lead.info.startUs - secondary.info.startUs;
    if (
      leadRaw.periodUs !== secondaryRaw.periodUs ||
      offsetUs % leadRaw.periodUs !== 0
    ) {
      throw new Error(
        `montage pair ${pair.lead}/${pair.secondary} samples different instants; ` +
          `their sample grids cannot be aligned`,
      );
    }

    // Reading the window both channels can serve keeps the two reads index-aligned even
    // when one channel starts or ends inside the other's extent.
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
      channel: compoundKey(lead.info, secondary.info),
      rateHz: lead.info.rateHz,
      reads: [
        planRead(lead, leadRaw, shared),
        planRead(secondary, secondaryRaw, shared),
      ],
    };
  }
}

/** StoreOptions for a query, or undefined when no signal was given. */
const toStoreOptions = (signal?: AbortSignal): StoreOptions | undefined =>
  signal === undefined ? undefined : { signal };

/** The entry for a channel id, insisting it is continuous. */
const continuousEntry = (catalog: BundleCatalog, id: string): ChannelEntry => {
  const entry = catalog.byId.get(id);
  if (entry === undefined) {
    throw new Error(`no channel with id ${id}`);
  }
  if (entry.info.kind !== "continuous") {
    throw new Error(
      `channel ${id} is a unit channel; query() and getSegmentSpans() read continuous channels`,
    );
  }
  return entry;
};

/** The unit arrays for a channel id, insisting it is a unit channel. */
const unitArrays = (catalog: BundleCatalog, id: string): UnitArrays => {
  const entry = catalog.byId.get(id);
  if (entry === undefined) {
    throw new Error(`no channel with id ${id}`);
  }
  if (entry.unit === undefined) {
    throw new Error(`channel ${id} is not a unit channel; use query()`);
  }
  return entry.unit;
};

/** Level 0 of a continuous channel: the one raw level the catalog guarantees. */
const rawLevel = (entry: ChannelEntry): LevelInfo =>
  entry.levels.find((level) => !level.isMinMax) as LevelInfo;

/** Plan one level read over a window: the clamped bin range and its absolute start time. */
const planRead = (
  entry: ChannelEntry,
  level: LevelInfo,
  window: { startUs: number; endUs: number },
): PlannedRead => {
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
};
