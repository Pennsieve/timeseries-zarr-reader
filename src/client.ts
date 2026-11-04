import type {
  BundleCatalog,
  ChannelEntry,
  ContinuousEntry,
  EventEntry,
  LevelInfo,
} from "./catalog.js";
import { readCatalog, selectLevel } from "./catalog.js";
import {
  binEdgeUs,
  binIndexRange,
  binStartUs,
  countBinRange,
  countBinStartUs,
  entryEdgeUs,
  entryTimeUs,
  runIndexRange,
  wholeSamples,
} from "./grid.js";
import {
  MAX_CACHE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_RAW_BYTES,
  RESAMPLE_PIXEL_RATIO,
} from "./constants.js";
import { queryEventChannel } from "./events.js";
import type { PriorityLimit } from "./fetch.js";
import { createPriorityLimit } from "./fetch.js";
import type { FilterSession } from "./filter.js";
import { assertFilterSpec, createFilterSession } from "./filter.js";
import { montageChannelKey, subtract } from "./montage.js";
import { readRecording } from "./recording.js";
import { resampleToPixels } from "./resample.js";
import { readRuns } from "./runs.js";
import {
  createCachingStore,
  createCoalescingStore,
  createConsolidatedStore,
  createDedupingStore,
  createThrottlingStore,
} from "./stores/cache.js";
import type {
  ChannelInfo,
  EventColumn,
  EventCounts,
  EventWindow,
  FilterSpec,
  LevelMember,
  MontagePair,
  ReadPriority,
  RecordingInfo,
  Run,
  Segment,
  Store,
  StoreOptions,
  Waveforms,
} from "./types.js";
import { readBins, readColumn, readRows, warmZstdCodec } from "./zarr.js";

/** Bytes per raw sample on disk. */
const BYTES_PER_RAW_SAMPLE = 4;

/**
 * Thrown when a query's reads of the raw level would exceed the byte cap.
 *
 * Raised before any data is fetched. `requestedBytes` is the size the reads would have
 * fetched, and `maxBytes` is the cap in effect.
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
  /**
   * Cap in bytes on a query's reads of the raw level, whether a filter, a montage, or
   * `raw` forced them or the pixel width selected them. Overridable per query. Defaults
   * to `MAX_RAW_BYTES`.
   */
  readonly maxRawBytes?: number;
  /**
   * Cap in bytes on the cache of store responses. Defaults to `MAX_CACHE_BYTES`. Zero
   * disables the cache, and the bundle root is then read twice on open.
   */
  readonly maxCacheBytes?: number;
  /**
   * Cap on level reads in flight at once. Defaults to `MAX_INFLIGHT_FETCHES`. Raise it
   * for a high-latency store.
   */
  readonly maxInflightFetches?: number;
  /**
   * Cap on transport requests in flight at once, counted after identical reads collapse
   * and adjacent ranges merge. Defaults to `MAX_CONCURRENT_REQUESTS`. Lower it for a
   * store that throttles; a value under the level-read cap adds a round trip per extra
   * round.
   */
  readonly maxConcurrentRequests?: number;
}

/** Options for one continuous query. Times are bundle microseconds, `endUs` exclusive. */
export interface QueryOptions {
  /**
   * Channel ids to read. Exactly one of `channels` and `montage` carries the query's
   * traces. Supplying both or neither throws.
   */
  readonly channels?: readonly string[];
  readonly startUs: number;
  readonly endUs: number;
  /** Time one pixel column covers. Drives level selection and the final resample. */
  readonly pixelWidthUs: number;
  /**
   * When true, the query returns raw samples with no decimation or resampling. Defaults to
   * false. Forces a read of the raw level, subject to the byte cap.
   */
  readonly raw?: boolean;
  /** Bipolar pairs to render, in place of `channels`. Each pair is one trace. */
  readonly montage?: readonly MontagePair[];
  /**
   * Per-bin statistics to read beside the envelope. Each lands on {@link Segment} as
   * `mean`, `variance`, or `count`, and only when the level read stores it. The reads
   * start with the min/max read under the same cap. A segment resampled onto pixels
   * carries them folded per pixel, and a resampled raw segment computes them from its
   * finite samples. A montage, a filter, or an unresampled raw read carries none.
   */
  readonly members?: readonly LevelMember[];
  /** Butterworth filter applied to every trace. Forces a raw read. */
  readonly filter?: FilterSpec;
  /** Cap override in bytes for this query's reads of the raw level. */
  readonly maxRawBytes?: number;
  /**
   * How early this query's reads are admitted. Defaults to `"viewport"`.
   */
  readonly priority?: ReadPriority;
  /**
   * Aborts this query's reads. An already-aborted signal rejects before any I/O. A catalog
   * load in flight for another query is shared and runs to completion.
   */
  readonly signal?: AbortSignal;
}

/** Options for one event query. Times are bundle microseconds, `endUs` exclusive. */
export interface EventQueryOptions {
  /** Event channel ids to read, one window each. */
  readonly channels: readonly string[];
  readonly startUs: number;
  readonly endUs: number;
  /**
   * Time one pixel column covers. Gates the waveform read: snippets are fetched only
   * when one spans more than `MIN_WAVEFORM_PIXELS` pixels. Omit it to fetch them
   * whenever the channel stores them.
   */
  readonly pixelWidthUs?: number;
  /** The per-event columns to read. Defaults to every column the channel stores. */
  readonly columns?: readonly EventColumn[];
  /**
   * How early this query's reads are admitted. Defaults to `"viewport"`.
   */
  readonly priority?: ReadPriority;
  readonly signal?: AbortSignal;
}

/** Options for one count-level read over an event channel. */
export interface EventCountOptions {
  readonly channel: string;
  readonly startUs: number;
  readonly endUs: number;
  /** Time one pixel column covers. Picks the count level. */
  readonly pixelWidthUs: number;
  /**
   * How early this read is admitted. Defaults to `"viewport"`.
   */
  readonly priority?: ReadPriority;
  readonly signal?: AbortSignal;
}

/** Options for reading an event channel's mean waveforms. */
export interface WaveformMeanOptions {
  readonly channel: string;
  /**
   * How early this read is admitted. Defaults to `"viewport"`.
   */
  readonly priority?: ReadPriority;
  readonly signal?: AbortSignal;
}

/** Options for reading a continuous channel's runs. */
export interface RunOptions {
  readonly channel: string;
  /**
   * How early this read is admitted. Defaults to `"viewport"`.
   */
  readonly priority?: ReadPriority;
  readonly signal?: AbortSignal;
}

/** Options for a data-availability query over one channel. */
export interface DataSpanOptions {
  readonly channel: string;
  readonly startUs: number;
  readonly endUs: number;
  /**
   * Gaps no wider than this are bridged into one span. Defaults to 0, so every gap
   * splits.
   */
  readonly gapThresholdUs?: number;
  /**
   * How early this read is admitted. Defaults to `"background"`: an availability scan
   * covers the whole recording and none of it is on screen.
   */
  readonly priority?: ReadPriority;
  readonly signal?: AbortSignal;
}

/** One planned level read. */
interface PlannedRead {
  readonly level: LevelInfo;
  /** Bin index range within the level, clamped to the bins it has. */
  readonly range: { start: number; end: number };
  /** Bundle time of the first bin in `range`. */
  readonly startUs: number;
}

/** One planned output trace. */
interface PlannedTrace {
  readonly channel: string;
  readonly rateHz: number;
  /**
   * Channel start time, the origin of the resample bucket grid. A montage carries the
   * lead channel's.
   */
  readonly channelStartUs: number;
  /**
   * The reads that make the trace, in time order, one segment each. A trace has one
   * read, except a raw read of a channel with runs: that has one per run in the window,
   * or one empty read when no run overlaps it.
   */
  readonly reads: readonly PlannedRead[];
  /**
   * Second read of a montage pair. Its samples are subtracted from the trace's only
   * read.
   */
  readonly secondaryRead?: PlannedRead;
}

/** A continuous channel and the level a query reads from it. */
interface Target {
  readonly entry: ContinuousEntry;
  readonly level: LevelInfo;
}

/** A read settled to a value or an error. */
type SettledRead =
  | { ok: true; data: Float64Array; members: MemberArrays }
  | { ok: false; error: unknown };

/** The statistics a level read returned, by their {@link Segment} field. */
interface MemberArrays {
  mean?: Float64Array;
  variance?: Float64Array;
  count?: Float64Array;
}

/** A bundle opened for reading. */
interface Bundle {
  readonly catalog: BundleCatalog;
  /**
   * The store the bundle's arrays are read through. Array metadata comes from the
   * root's consolidated metadata, and responses are cached.
   */
  readonly store: Store;
  /** The cached store beneath it, for files that are not Zarr nodes. */
  readonly files: Store;
}

/**
 * Reads one bundle by channel id and time window.
 *
 * Every time in and out of the client is microseconds from the bundle's origin.
 * {@link recording} gives the origin's wall-clock time when the bundle records one.
 *
 * The constructor reads nothing from the store. It starts loading the codec that
 * decompresses chunks. The catalog is read on first use and cached for the client's
 * lifetime.
 *
 * Filter state also lives for the client's lifetime. Queries over adjacent windows filter as
 * one continuous signal, whether or not their seam falls on a sample. A jump backwards or a
 * gap wider than `FILTER_GAP_RESET_SAMPLES` sample periods restarts the filter for that
 * channel.
 *
 * Every read shares an in-flight concurrency cap, admitted by the priority its query
 * carries, and passes through a second cap on transport requests.
 *
 * Store responses are cached for the client's lifetime, bounded by `maxCacheBytes`.
 */
export class StreamingClient {
  readonly #store: Store;
  readonly #maxRawBytes: number;
  readonly #maxCacheBytes: number;
  readonly #maxConcurrentRequests: number;
  readonly #limit: PriorityLimit;
  readonly #filters: FilterSession;
  #bundle: Promise<Bundle> | undefined;
  #recording: Promise<RecordingInfo | undefined> | undefined;
  /** Each channel's runs by channel index, read once per client lifetime. */
  readonly #runs = new Map<number, Promise<Run[]>>();

  constructor(options: StreamingClientOptions) {
    this.#store = options.store;
    this.#maxRawBytes = options.maxRawBytes ?? MAX_RAW_BYTES;
    this.#maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
    this.#maxConcurrentRequests =
      options.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS;
    this.#limit = createPriorityLimit(options.maxInflightFetches);
    this.#filters = createFilterSession();
    void warmZstdCodec();
  }

  /**
   * Returns info for every channel in the bundle, continuous and event alike, in the
   * bundle's order. Narrow on `kind`. Returned objects are copies.
   *
   * A channel with a `runs` table has its table read, concurrently with the others,
   * for the exact `endUs` of its last run. Rejects when a table breaks the format's
   * rules.
   */
  async channelInfo(): Promise<ChannelInfo[]> {
    const { catalog } = await this.#loadBundle();
    return Promise.all(
      catalog.channels.map(async (entry): Promise<ChannelInfo> => {
        if (entry.kind !== "continuous" || entry.runs === undefined) {
          return { ...entry.info };
        }
        const runs = await this.#runsOf(entry, "viewport");
        return { ...entry.info, endUs: runs[runs.length - 1]!.endUs };
      }),
    );
  }

  /**
   * Returns the bundle's `recording.json`, or undefined when it has none.
   *
   * Read once and cached for the client's lifetime. A viewer adds `startUs` to a
   * bundle time to label an axis with wall-clock time. Rejects when the file does
   * not parse; the next call retries.
   */
  recording(): Promise<RecordingInfo | undefined> {
    return (this.#recording ??= this.#loadBundle()
      .then(({ files }) => readRecording(files))
      .catch((error: unknown) => {
        this.#recording = undefined;
        throw error;
      }));
  }

  /**
   * Returns a continuous channel's runs in time order: the exact start and end of
   * every span of samples recorded one period apart.
   *
   * A channel that never paused has one run covering its extent, and an empty channel
   * has none. A raw read of a channel with runs delivers one segment per run at these
   * times. Read once per channel and cached for the client's lifetime. Rejects for an unknown
   * channel id, an event channel, or a `runs` table that breaks the format's rules;
   * the next call retries. An aborted caller is rejected and the read finishes for
   * the others.
   */
  async runs(params: RunOptions): Promise<Run[]> {
    params.signal?.throwIfAborted();
    const pending = this.#loadBundle().then(({ catalog }) =>
      this.#runsOf(
        continuousEntry(catalog, params.channel),
        params.priority ?? "viewport",
      ),
    );
    return params.signal === undefined
      ? pending
      : abortable(pending, params.signal);
  }

  /**
   * Reads continuous channels over a window, yielding one segment per trace in request
   * order.
   *
   * Each trace reads the coarsest pyramid level whose bins fit within one pixel. A filter,
   * a montage, or `raw: true` forces the raw level. Reads of the raw level totaling more
   * than the byte cap throw {@link RawReadTooLargeError}, whether forced or selected by
   * the pixel width. The cap counts the samples read. Unless `raw` is set, output is
   * resampled onto the pixel grid when one pixel spans more than `RESAMPLE_PIXEL_RATIO`
   * source bins. That grid is anchored at the channel start, so every window over a
   * channel resamples onto the same buckets.
   *
   * A trace yields one segment. The exception is a read of the raw level of a channel
   * with a `runs` table, whether forced or selected by the pixel width: it yields one
   * segment per run that overlaps the window, in time order, and each starts at the exact
   * time of its first sample. The samples of a pause are not delivered. A montage trace
   * and a read of a pyramid level stay on the sample grid.
   *
   * Segments are delivered on sample or bin boundaries, so one may begin before `startUs`
   * or end after `endUs` by less than one of its own bins. A filtered segment continuing
   * from the previous segment begins at the first sample that segment did not return. A
   * window with no overlap yields one segment with empty data, whose `startUs` is clamped
   * to the channel's extent.
   *
   * Rejects when `channels` and `montage` are both supplied or both empty, and for an
   * unknown channel id, an event channel, a montage pair whose rates or sample grids
   * differ, a filter spec outside a trace's Nyquist range, a non-positive `pixelWidthUs`,
   * or an `endUs` before `startUs`. Every rejection of the request itself happens before
   * any read starts. Calling `query` does not throw; rejections arrive on the first
   * iteration.
   *
   * A read that fails rejects the iteration and cancels the reads of the traces not yet
   * yielded, as does a consumer that stops iterating early.
   */
  async *query(params: QueryOptions): AsyncGenerator<Segment, void, undefined> {
    params.signal?.throwIfAborted();
    requirePixelWidth(params.pixelWidthUs);
    requireWindow(params.startUs, params.endUs);

    const raw = params.raw ?? false;
    const channels = params.channels ?? [];
    const montage = params.montage ?? [];
    requireOneTraceSource(channels, montage);

    const requested = requireMembers(params.members);
    // A montage trace and a filtered trace carry no statistics.
    const wanted =
      params.filter === undefined && montage.length === 0 ? requested : [];
    const resamples = (level: LevelInfo): boolean =>
      !raw && params.pixelWidthUs > RESAMPLE_PIXEL_RATIO * level.periodUs;

    const forceRaw = params.filter !== undefined || montage.length > 0 || raw;
    const { catalog, store } = await this.#loadBundle();

    const montageTraces = montage.map((pair) =>
      this.#planMontage(catalog, pair, params),
    );
    const targets = channels.map((id) => {
      const entry = continuousEntry(catalog, id);
      const level = forceRaw
        ? rawLevel(entry)
        : selectLevel(entry.levels, params.pixelWidthUs);
      return { entry, level };
    });

    // Every check of the request runs before the first read starts. A spec the filter
    // would reject on the first segment would otherwise leave every other trace's read
    // running with nothing to await it.
    if (params.filter !== undefined) {
      const rates = [
        ...montageTraces.map((trace) => trace.rateHz),
        ...targets.map(({ entry }) => entry.info.rateHz),
      ];
      for (const rateHz of new Set(rates)) {
        assertFilterSpec(params.filter, rateHz);
      }
    }
    const traces =
      montage.length > 0
        ? montageTraces
        : await this.#planChannels(targets, params);
    assertWithinByteCap(traces, params.maxRawBytes ?? this.#maxRawBytes);

    // One signal for every read of the query: the caller's abort reaches it, and so
    // does the query ending before every read was awaited.
    const reads = new AbortController();
    const forwardAbort = (): void => {
      reads.abort(params.signal?.reason);
    };
    params.signal?.addEventListener("abort", forwardAbort, { once: true });
    const opts: StoreOptions = { signal: reads.signal };

    const priority = params.priority ?? "viewport";
    // Settling each read up front avoids unhandled rejections when iteration stops early.
    const started = traces.map((trace) => ({
      trace,
      leads: trace.reads.map((read) =>
        this.#startRead(
          store,
          read,
          opts,
          priority,
          membersToRead(read.level, wanted, resamples(read.level)),
        ),
      ),
      secondary:
        trace.secondaryRead === undefined
          ? undefined
          : this.#startRead(store, trace.secondaryRead, opts, priority),
    }));

    let drained = false;
    try {
      for (const { trace, leads, secondary } of started) {
        for (const [piece, lead] of leads.entries()) {
          const read = trace.reads[piece]!;
          const first = unwrapRead(await lead);
          const second =
            secondary === undefined ? undefined : unwrapRead(await secondary);

          let segment: Segment = {
            channel: trace.channel,
            startUs: read.startUs,
            samplePeriodUs: read.level.periodUs,
            isMinMax: read.level.isMinMax,
            data:
              second === undefined
                ? first.data
                : subtract(first.data, second.data),
            ...first.members,
          };

          if (params.filter) {
            segment = this.#filters.apply(segment, params.filter, trace.rateHz);
          }
          if (resamples(read.level)) {
            segment = resampleToPixels(
              segment,
              params.pixelWidthUs,
              trace.channelStartUs,
              wanted,
            );
          }
          yield segment;
        }
      }
      drained = true;
    } finally {
      params.signal?.removeEventListener("abort", forwardAbort);
      if (!drained) {
        // A failed read, or a consumer that stopped iterating: the reads of the traces
        // not yet yielded have no one left to await them.
        reads.abort();
      }
    }
  }

  /**
   * Reads event channels over a window, yielding one window per channel in request
   * order.
   *
   * An event is in the window when it starts before `endUs` and ends at or after
   * `startUs`, so an interval that opened before the window and is still running is
   * included. Every column the channel stores is read unless `columns` narrows the
   * list; `text` can be most of a channel's bytes. Waveforms are read only when
   * `pixelWidthUs` is omitted or one snippet spans more than `MIN_WAVEFORM_PIXELS`
   * pixels.
   *
   * Channels are read sequentially. Rejects for an unknown channel id, a continuous
   * channel, a non-positive `pixelWidthUs`, or an `endUs` before `startUs`.
   */
  async *queryEvents(
    params: EventQueryOptions,
  ): AsyncGenerator<EventWindow, void, undefined> {
    params.signal?.throwIfAborted();
    if (params.pixelWidthUs !== undefined) {
      requirePixelWidth(params.pixelWidthUs);
    }
    requireWindow(params.startUs, params.endUs);
    const { catalog, store } = await this.#loadBundle();
    const opts = toStoreOptions(params.signal);

    const priority = params.priority ?? "viewport";
    for (const id of params.channels) {
      const entry = eventEntry(catalog, id);
      yield await this.#limit(priority, () =>
        queryEventChannel(
          store,
          id,
          entry.arrays,
          catalog.idByIndex,
          params,
          opts,
        ),
      );
    }
  }

  /**
   * Reads per-bin event counts over a window from the coarsest count level whose bins
   * fit within one pixel, falling back to the finest.
   *
   * Bins are delivered whole, so the first may start before `startUs` and the last
   * run past `endUs`. Rejects for an unknown channel id, a continuous channel, a
   * channel with no count levels, a non-positive `pixelWidthUs`, or an `endUs` before
   * `startUs`.
   */
  async eventCounts(params: EventCountOptions): Promise<EventCounts> {
    params.signal?.throwIfAborted();
    requirePixelWidth(params.pixelWidthUs);
    requireWindow(params.startUs, params.endUs);
    const { catalog, store } = await this.#loadBundle();
    const entry = eventEntry(catalog, params.channel);
    const levels = entry.arrays.countLevels;
    if (levels.length === 0) {
      throw new Error(
        `event channel ${params.channel} has no count levels; read its events with queryEvents()`,
      );
    }

    const level = selectLevel(levels, params.pixelWidthUs);
    const range = countBinRange(
      params,
      level.offsetUs,
      level.periodUs,
      level.binCount,
    );
    const { data } = await this.#limit(params.priority ?? "viewport", () =>
      readRows(
        store,
        level.path,
        range,
        ["uint32"],
        toStoreOptions(params.signal),
      ),
    );
    return {
      channel: params.channel,
      level: level.level,
      startUs: countBinStartUs(range.start, level.offsetUs, level.periodUs),
      periodUs: level.periodUs,
      labelCount: level.labelCount,
      counts: Uint32Array.from(data),
    };
  }

  /**
   * Reads an event channel's mean waveform per label category, one row per label, or
   * resolves undefined when the channel stores none.
   *
   * Rejects for an unknown channel id or a continuous channel.
   */
  async waveformMean(
    params: WaveformMeanOptions,
  ): Promise<Waveforms | undefined> {
    params.signal?.throwIfAborted();
    const { catalog, store } = await this.#loadBundle();
    const mean = eventEntry(catalog, params.channel).arrays.waveformMean;
    if (mean === undefined) {
      return undefined;
    }
    const { data } = await this.#limit(params.priority ?? "viewport", () =>
      readRows(
        store,
        mean.path,
        { start: 0, end: mean.rows },
        ["float32", "float64"],
        toStoreOptions(params.signal),
      ),
    );
    return {
      pointsPerEvent: mean.pointsPerEvent,
      periodUs: mean.periodUs,
      eventSample: mean.eventSample,
      data: Float64Array.from(data),
    };
  }

  /**
   * Returns the spans where a channel has data, as `[startUs, endUs)` pairs clamped to the
   * window.
   *
   * Reads the coarsest pyramid level. A bin is populated when its `count` is above zero,
   * or, on a level without `count`, when its min/max is finite. Consecutive populated
   * bins merge into one span, and gaps no wider than `gapThresholdUs` are bridged. Span
   * edges align to that level's bin boundaries, rounded outward to whole microseconds,
   * and stay inside the channel's `startUs` and `endUs`.
   *
   * A channel without levels reads its raw samples, and a sample is populated when it is
   * finite. A channel with runs then places each sample at its exact time. Throws for an
   * unknown channel id, an event channel, or an `endUs` before `startUs`.
   */
  async dataSpans(
    params: DataSpanOptions,
  ): Promise<Array<[startUs: number, endUs: number]>> {
    params.signal?.throwIfAborted();
    requireWindow(params.startUs, params.endUs);
    const { catalog, store } = await this.#loadBundle();
    const opts = toStoreOptions(params.signal);
    const entry = continuousEntry(catalog, params.channel);
    // Levels are sorted finest-first, and a continuous channel has at least one.
    const level = entry.levels[entry.levels.length - 1]!;

    const priority = params.priority ?? "background";
    const pendingRuns =
      entry.runs === undefined ? undefined : this.#runsOf(entry, priority);
    const runs =
      pendingRuns === undefined || params.signal === undefined
        ? await pendingRuns
        : await abortable(pendingRuns, params.signal);
    // Samples of a channel with runs sit at the times the table gives. A level is on
    // the grid.
    const exactRuns = level.isMinMax ? undefined : runs;
    const { startUs: offsetUs, rateHz } = entry.info;
    const range =
      exactRuns === undefined
        ? planRead(entry, level, params).range
        : runIndexRange(params, exactRuns, offsetUs, rateHz, level.binCount);
    const populated = await this.#limit(priority, () =>
      readCoverage(store, level, range, opts),
    );

    const gapThresholdUs = params.gapThresholdUs ?? 0;
    const lowUs = Math.max(params.startUs, entry.info.startUs);
    const highUs = Math.min(
      params.endUs,
      runs === undefined ? entry.info.endUs : runs[runs.length - 1]!.endUs,
    );
    const spans: Array<[startUs: number, endUs: number]> = [];

    // Each run of populated bins is one span: the floor of its first bin's start to
    // the ceiling of its last bin's end, kept inside the window and the channel.
    const addSpan = (firstBin: number, stopBin: number): void => {
      const spanStartUs = Math.max(
        lowUs,
        exactRuns === undefined
          ? binEdgeUs(
              range.start + firstBin,
              offsetUs,
              rateHz,
              level.samplesPerBin,
              "floor",
            )
          : entryEdgeUs(
              range.start + firstBin,
              offsetUs,
              rateHz,
              exactRuns,
              "start",
            ),
      );
      const spanEndUs = Math.min(
        highUs,
        exactRuns === undefined
          ? binEdgeUs(
              range.start + stopBin,
              offsetUs,
              rateHz,
              level.samplesPerBin,
              "ceil",
            )
          : entryEdgeUs(
              range.start + stopBin - 1,
              offsetUs,
              rateHz,
              exactRuns,
              "end",
            ),
      );
      if (spanStartUs >= spanEndUs) {
        return;
      }
      const last = spans[spans.length - 1];
      if (last !== undefined && spanStartUs - last[1] <= gapThresholdUs) {
        last[1] = Math.max(last[1], spanEndUs);
      } else {
        spans.push([spanStartUs, spanEndUs]);
      }
    };

    let runStart: number | undefined;
    for (let bin = 0; bin < populated.length; bin++) {
      if (populated[bin] === 0) {
        if (runStart !== undefined) {
          addSpan(runStart, bin);
          runStart = undefined;
        }
      } else {
        runStart ??= bin;
      }
    }
    if (runStart !== undefined) {
      addSpan(runStart, populated.length);
    }

    return spans;
  }

  #loadBundle(): Promise<Bundle> {
    return (this.#bundle ??= this.#openBundle().catch((error: unknown) => {
      // Clear the cached promise on failure so the next call retries.
      this.#bundle = undefined;
      throw error;
    }));
  }

  /** Reads the catalog and layers the store the bundle's arrays are read through. */
  async #openBundle(): Promise<Bundle> {
    // Identical concurrent reads collapse before adjacent distinct ones merge, so the
    // coalescer only ever sees one request per distinct range. The throttle sits under
    // both, where the requests it counts are the ones the transport sends.
    const deduped = createDedupingStore(
      createCoalescingStore(
        createThrottlingStore(this.#store, this.#maxConcurrentRequests),
      ),
    );
    const cached =
      this.#maxCacheBytes > 0
        ? createCachingStore(deduped, this.#maxCacheBytes)
        : deduped;
    // The catalog needs the root group's consolidated_metadata block, which the
    // consolidated store replaces with a plain group. Both read `/zarr.json`, and the
    // cache makes the second read free.
    const catalog = await readCatalog(cached);
    return {
      catalog,
      store: await createConsolidatedStore(cached),
      files: cached,
    };
  }

  /**
   * Returns a channel's runs, reading them on first use. Callers share one read, so it
   * carries no signal: one caller giving up must not reject the rest, and the table is
   * small enough to let it finish. A failed read is dropped so the next call retries.
   */
  #runsOf(entry: ContinuousEntry, priority: ReadPriority): Promise<Run[]> {
    const { index } = entry.info;
    let pending = this.#runs.get(index);
    if (pending === undefined) {
      const read: Promise<Run[]> = this.#loadBundle()
        .then(({ store }) =>
          this.#limit(priority, () => readRuns(store, entry)),
        )
        .catch((error: unknown) => {
          if (this.#runs.get(index) === read) {
            this.#runs.delete(index);
          }
          throw error;
        });
      pending = read;
      this.#runs.set(index, pending);
    }
    return pending;
  }

  /**
   * Plans the traces of channel reads. A read of the raw level of a channel with runs
   * waits for the runs, which place its samples.
   */
  async #planChannels(
    targets: readonly Target[],
    params: QueryOptions,
  ): Promise<PlannedTrace[]> {
    const priority = params.priority ?? "viewport";
    const tables = await Promise.all(
      targets.map(({ entry, level }) => {
        if (level.isMinMax || entry.runs === undefined) {
          return undefined;
        }
        const pending = this.#runsOf(entry, priority);
        return params.signal === undefined
          ? pending
          : abortable(pending, params.signal);
      }),
    );
    return targets.map(({ entry, level }, position) => ({
      channel: entry.info.id,
      rateHz: entry.info.rateHz,
      channelStartUs: entry.info.startUs,
      reads: planReads(entry, level, params, tables[position]),
    }));
  }

  /** Plans the trace for a montage pair: two raw reads over the pair's shared window. */
  #planMontage(
    catalog: BundleCatalog,
    pair: MontagePair,
    params: { startUs: number; endUs: number },
  ): PlannedTrace {
    const lead = continuousEntry(catalog, pair.lead);
    const secondary = continuousEntry(catalog, pair.secondary);
    if (lead.info.rateHz !== secondary.info.rateHz) {
      throw new Error(
        `montage pair ${pair.lead}/${pair.secondary} mixes rates ` +
          `(${lead.info.rateHz} Hz and ${secondary.info.rateHz} Hz)`,
      );
    }

    // Subtraction pairs samples by index, so the channels must share a sample grid:
    // equal rates, and starts a whole number of samples apart.
    const leadRaw = rawLevel(lead);
    const secondaryRaw = rawLevel(secondary);
    const shift = wholeSamples(
      lead.info.startUs - secondary.info.startUs,
      lead.info.rateHz,
    );
    if (shift === undefined) {
      throw new Error(
        `montage pair ${pair.lead}/${pair.secondary} cannot be aligned: ` +
          `the start offset is not a whole number of samples`,
      );
    }

    // Lead sample `i` is secondary sample `i + shift`. Both reads must cover the same
    // samples, even when one channel starts or ends inside the other's extent.
    const window = planRead(lead, leadRaw, params).range;
    const start = Math.max(window.start, -shift);
    const end = Math.max(
      Math.min(window.end, secondaryRaw.binCount - shift),
      start,
    );
    const readOf = (
      entry: ContinuousEntry,
      level: LevelInfo,
      first: number,
    ): PlannedRead => ({
      level,
      range: { start: first, end: first + (end - start) },
      startUs: binStartUs(first, entry.info.startUs, entry.info.rateHz, 1),
    });

    return {
      channel: montageChannelKey(lead.info, secondary.info),
      rateHz: lead.info.rateHz,
      channelStartUs: lead.info.startUs,
      reads: [readOf(lead, leadRaw, start)],
      secondaryRead: readOf(secondary, secondaryRaw, start + shift),
    };
  }

  /**
   * Starts one read under the in-flight cap, with a read of each of `members` beside
   * it. The returned promise never rejects.
   */
  #startRead(
    store: Store,
    read: PlannedRead,
    opts: StoreOptions | undefined,
    priority: ReadPriority,
    members: readonly LevelMember[] = [],
  ): Promise<SettledRead> {
    const { level, range } = read;
    const data = this.#limit(priority, () =>
      readBins(store, level.path, range, opts),
    );
    const statistics = members.map((member) =>
      this.#limit(priority, () =>
        readMember(store, level, member, range, opts),
      ),
    );
    return Promise.all([data, Promise.all(statistics)])
      .then(([bins, arrays]): SettledRead => {
        const found: MemberArrays = {};
        arrays.forEach((array, position) => {
          if (array !== undefined) {
            found[memberField(members[position]!)] = array;
          }
        });
        return { ok: true, data: bins, members: found };
      })
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

/** Throws a RangeError for a window that ends before it starts. */
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

/**
 * Throws {@link RawReadTooLargeError} when the planned reads of the raw level total more
 * than `cap` bytes. Min/max levels are bounded by the pixel width and do not count.
 */
function assertWithinByteCap(
  traces: readonly PlannedTrace[],
  cap: number,
): void {
  const requestedBytes = traces.reduce(
    (sum, trace) =>
      sum +
      trace.reads.reduce((bytes, read) => bytes + readBytes(read), 0) +
      (trace.secondaryRead === undefined ? 0 : readBytes(trace.secondaryRead)),
    0,
  );
  if (requestedBytes > cap) {
    throw new RawReadTooLargeError(requestedBytes, cap);
  }
}

/** Returns the size of a planned raw-level read in bytes, and 0 for a min/max level. */
function readBytes(read: PlannedRead): number {
  if (read.level.isMinMax) {
    return 0;
  }
  return (read.range.end - read.range.start) * BYTES_PER_RAW_SAMPLE;
}

/** Returns a settled read, or rethrows its error. */
function unwrapRead(result: SettledRead): Extract<SettledRead, { ok: true }> {
  if (!result.ok) {
    throw result.error;
  }
  return result;
}

const LEVEL_MEMBERS: readonly LevelMember[] = ["mean", "var", "count"];

/** Returns `members` without duplicates. Throws for a name a level does not store. */
function requireMembers(
  members: readonly LevelMember[] | undefined,
): LevelMember[] {
  for (const member of members ?? []) {
    if (!LEVEL_MEMBERS.includes(member)) {
      throw new RangeError(
        `unknown member ${String(member)}; valid members are ${LEVEL_MEMBERS.join(", ")}`,
      );
    }
  }
  return [...new Set(members)];
}

/**
 * Returns the members to read from a level so that `wanted` can be delivered.
 *
 * A raw level stores none. Folding a level onto pixels takes the `count` and `mean`
 * of the bins beside whatever is asked for.
 */
function membersToRead(
  level: LevelInfo,
  wanted: readonly LevelMember[],
  resamples: boolean,
): LevelMember[] {
  if (!level.isMinMax || wanted.length === 0) {
    return [];
  }
  const needed = new Set(wanted);
  if (resamples) {
    if (needed.has("var")) needed.add("mean");
    if (needed.has("var") || needed.has("mean")) needed.add("count");
  }
  return [...needed];
}

/** Returns the {@link Segment} field that holds a member. */
function memberField(member: LevelMember): keyof MemberArrays {
  return member === "var" ? "variance" : member;
}

/**
 * Reads one member of a level over a bin range, widened to `Float64Array`. Resolves
 * to undefined when the level does not store the member.
 */
async function readMember(
  store: Store,
  level: LevelInfo,
  member: LevelMember,
  range: { start: number; end: number },
  opts: StoreOptions | undefined,
): Promise<Float64Array | undefined> {
  const path =
    member === "count"
      ? level.countPath
      : member === "mean"
        ? level.meanPath
        : level.variancePath;
  if (path === undefined) {
    return undefined;
  }
  const values =
    member === "count"
      ? await readColumn(store, path, range, ["uint32"], opts)
      : await readColumn(store, path, range, ["float32", "float64"], opts);
  return Float64Array.from(values);
}

function toStoreOptions(signal?: AbortSignal): StoreOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

/** Settles with `promise`, or rejects as soon as `signal` aborts. The work runs on. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Returns, for each bin of a level read, 1 when the bin recorded a sample and 0 when
 * it did not.
 *
 * `count` says how many samples a bin recorded, so a bin short by one sample still
 * counts as covered. Without it, a bin is covered when its min/max is finite, and one
 * bad sample makes the whole bin a gap.
 */
async function readCoverage(
  store: Store,
  level: LevelInfo,
  range: { start: number; end: number },
  opts: StoreOptions | undefined,
): Promise<Uint8Array> {
  if (level.countPath !== undefined) {
    const counts = await readColumn(
      store,
      level.countPath,
      range,
      ["uint32"],
      opts,
    );
    return Uint8Array.from(counts, (count) => (count > 0 ? 1 : 0));
  }
  const data = await readBins(store, level.path, range, opts);
  const valuesPerBin = level.isMinMax ? 2 : 1;
  const populated = new Uint8Array(data.length / valuesPerBin);
  for (let bin = 0; bin < populated.length; bin++) {
    const end = (bin + 1) * valuesPerBin;
    for (let i = bin * valuesPerBin; i < end; i++) {
      if (Number.isFinite(data[i]!)) {
        populated[bin] = 1;
        break;
      }
    }
  }
  return populated;
}

/**
 * Returns the catalog entry for a channel id. Throws for an unknown id and for an id
 * that more than one channel carries.
 */
function channelEntry(catalog: BundleCatalog, id: string): ChannelEntry {
  const [entry, ...others] = catalog.byId.get(id) ?? [];
  if (entry === undefined) {
    throw new Error(`no channel with id ${id}`);
  }
  if (others.length > 0) {
    const indices = [entry, ...others].map((e) => e.info.index).join(", ");
    throw new Error(
      `channel id ${id} is shared by channels ${indices}; ids must be unique to query`,
    );
  }
  return entry;
}

/** Returns the entry for a continuous channel. Throws for an unknown id or an event channel. */
function continuousEntry(catalog: BundleCatalog, id: string): ContinuousEntry {
  const entry = channelEntry(catalog, id);
  if (entry.kind !== "continuous") {
    throw new Error(`channel ${id} is an event channel; use queryEvents()`);
  }
  return entry;
}

/** Returns the entry for an event channel. Throws for an unknown id or a continuous channel. */
function eventEntry(catalog: BundleCatalog, id: string): EventEntry {
  const entry = channelEntry(catalog, id);
  if (entry.kind !== "event") {
    throw new Error(`channel ${id} is a continuous channel; use query()`);
  }
  return entry;
}

/** Returns a continuous channel's raw level. */
function rawLevel(entry: ContinuousEntry): LevelInfo {
  // readCatalog rejects a continuous channel that has no raw array.
  return entry.levels.find((level) => !level.isMinMax)!;
}

/**
 * Plans the reads of one level over a window, one segment each.
 *
 * `runs` is the channel's runs table, given for a read of the raw level of a channel
 * that has one. The reads are then one per run that overlaps the window, each at the
 * exact time of its first sample. The samples of a pause hold no data and are not read.
 * A window that overlaps no run plans one empty read.
 */
function planReads(
  entry: ContinuousEntry,
  level: LevelInfo,
  window: { startUs: number; endUs: number },
  runs: readonly Run[] | undefined,
): PlannedRead[] {
  if (runs === undefined) {
    return [planRead(entry, level, window)];
  }
  const { startUs: offsetUs, rateHz } = entry.info;
  const span = runIndexRange(window, runs, offsetUs, rateHz, level.binCount);
  const reads: PlannedRead[] = [];
  // Skip the runs that end before the range starts.
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle]!;
    if (run.firstSample + run.sampleCount <= span.start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (const run of runs.slice(low)) {
    if (run.firstSample >= span.end) {
      break;
    }
    const start = Math.max(span.start, run.firstSample);
    const end = Math.min(span.end, run.firstSample + run.sampleCount);
    if (end > start) {
      reads.push({
        level,
        range: { start, end },
        startUs: entryTimeUs(start, offsetUs, rateHz, runs),
      });
    }
  }
  return reads.length > 0
    ? reads
    : [
        {
          level,
          range: { start: span.start, end: span.start },
          startUs: entryTimeUs(span.start, offsetUs, rateHz, runs),
        },
      ];
}

/** Plans a read of one level, clamped to a window. */
function planRead(
  entry: ContinuousEntry,
  level: LevelInfo,
  window: { startUs: number; endUs: number },
): PlannedRead {
  const { startUs: offsetUs, rateHz } = entry.info;
  const range = binIndexRange(
    window,
    offsetUs,
    rateHz,
    level.samplesPerBin,
    level.binCount,
  );
  return {
    level,
    range,
    startUs: binStartUs(range.start, offsetUs, rateHz, level.samplesPerBin),
  };
}
