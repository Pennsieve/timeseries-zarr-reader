/**
 * A contiguous run of one trace's data over a queried window.
 *
 * Times are microseconds from the bundle's origin. Values are in physical units; the
 * reader does not negate them.
 */
export interface Segment {
  /** Channel id the segment belongs to (a compound key when montaged). */
  readonly channel: string;
  /** Start time of the first sample or bin. */
  readonly startUs: number;
  /** Time between consecutive samples (raw) or bins (envelope). */
  readonly samplePeriodUs: number;
  /** True when `data` holds min/max envelope pairs. */
  readonly isMinMax: boolean;
  /**
   * Raw samples, or interleaved `[min, max, min, max, ...]` pairs when
   * {@link Segment.isMinMax}. Always `Float64Array`, regardless of the on-disk
   * float width.
   */
  readonly data: Float64Array;
}

/** Fields every channel carries, whatever its kind. */
export interface ChannelBase {
  /**
   * The channel's index: the integer name of its group in the bundle, and the bit
   * that names it in an event's `channels` column.
   */
  readonly index: number;
  /**
   * Id used to address the channel in queries: the producer's id, or the index as a
   * string when the bundle records none.
   */
  readonly id: string;
  /** Human-readable channel label. */
  readonly name: string;
  /** What produced the channel, as the bundle records it. */
  readonly provenance?: Readonly<Record<string, unknown>>;
}

/**
 * Metadata of a regularly sampled channel.
 *
 * Times are microseconds from the bundle's origin.
 */
export interface ContinuousChannelInfo extends ChannelBase {
  readonly kind: "continuous";
  /** Physical unit of the samples (e.g. "uV"). */
  readonly unit: string;
  /** Native sampling rate, in hertz. */
  readonly rateHz: number;
  /** Time of the channel's first sample. */
  readonly startUs: number;
  /**
   * Exclusive end of the channel's sample grid: one sample period past the last
   * grid sample, rounded up to a whole microsecond. On a channel with more than
   * one run the last run ends within one sample period of this; `runs()` gives the
   * exact end.
   */
  readonly endUs: number;
  /**
   * Number of runs: spans of samples recorded one period apart. 1 for a channel
   * that never paused, 0 for an empty channel.
   */
  readonly runs: number;
}

/**
 * One run of a continuous channel: consecutive samples recorded one sample period
 * apart, with the exact time the run began.
 *
 * Times are microseconds from the bundle's origin. A run's samples are
 * `firstSample` through `firstSample + sampleCount - 1` of the channel's grid, and
 * sample `firstSample + i` is at `startUs + i * samplePeriod`. The grid places a run
 * within one sample period of `startUs`.
 */
export interface Run {
  /** Grid index of the run's first sample. */
  readonly firstSample: number;
  readonly sampleCount: number;
  /** Exact time of the first sample. */
  readonly startUs: number;
  /**
   * Exclusive end of the run: one sample period past its last sample, rounded up
   * to a whole microsecond.
   */
  readonly endUs: number;
}

/** The optional per-event columns an event channel can store. */
export type EventColumn =
  "durations" | "labels" | "values" | "text" | "channels" | "waveforms";

/** Metadata of an event channel: sorted spikes, detector output, or annotations. */
export interface EventChannelInfo extends ChannelBase {
  readonly kind: "event";
  /** Unit of the `values` column, when the bundle declares one. */
  readonly unit?: string;
  /** Number of events in the channel. */
  readonly eventCount: number;
  /** The optional per-event columns the channel stores. */
  readonly columns: readonly EventColumn[];
  /** Name of each label category, indexed by label value. */
  readonly labelNames?: readonly string[];
  /** Upper bound on every duration. Set whenever the bundle declares one. */
  readonly maxDurationUs?: number;
  /** True when the channel stores a mean waveform per label category. */
  readonly hasWaveformMean: boolean;
  /** Number of count levels. 0 when the channel stores none. */
  readonly countLevels: number;
}

/** Per-channel metadata read from a channel group's `tsz` attributes. */
export type ChannelInfo = ContinuousChannelInfo | EventChannelInfo;

/**
 * A bipolar montage pair. The rendered trace is `lead[i] - secondary[i]`, in
 * physical units. Both fields are channel ids as they appear in the bundle.
 */
export interface MontagePair {
  readonly lead: string;
  readonly secondary: string;
}

/**
 * A Butterworth filter request. Frequencies are in hertz. The `type`
 * discriminant fixes which cutoff fields apply. Lowpass and highpass take
 * `cutoffHz`, bandpass and bandstop a `lowHz`/`highHz` band.
 */
export type FilterSpec =
  | {
      readonly type: "lowpass";
      readonly order: number;
      readonly cutoffHz: number;
    }
  | {
      readonly type: "highpass";
      readonly order: number;
      readonly cutoffHz: number;
    }
  | {
      readonly type: "bandpass";
      readonly order: number;
      readonly lowHz: number;
      readonly highHz: number;
    }
  | {
      readonly type: "bandstop";
      readonly order: number;
      readonly lowHz: number;
      readonly highHz: number;
    };

/** Waveform snippets: one row per event, or one per label for a channel's mean waveforms. */
export interface Waveforms {
  /** Samples per snippet. */
  readonly pointsPerEvent: number;
  /** Time between snippet samples. */
  readonly periodUs: number;
  /** Index of the snippet sample recorded at the event time. */
  readonly eventSample: number;
  /** Snippet samples, one row of `pointsPerEvent` values per snippet, flattened row-major. */
  readonly data: Float64Array;
}

/**
 * One event channel's events over a query window, with the per-event columns that
 * were read.
 *
 * Times are microseconds from the bundle's origin. A column the channel does not
 * store, or the query did not ask for, is absent. Index `i` of every column is
 * event `i`.
 */
export interface EventWindow {
  /** Channel id the events belong to. */
  readonly channel: string;
  /** Query-window start. */
  readonly startUs: number;
  /** Query-window end, exclusive. */
  readonly endUs: number;
  /** Onset time of each event, ascending. */
  readonly times: Float64Array;
  /** Duration of each event. 0 is a point event. */
  readonly durations?: Float64Array;
  /** Label value of each event, an index into the channel's `labelNames`. */
  readonly labels?: Uint16Array;
  /** One measurement per event, in the channel's unit. */
  readonly values?: Float64Array;
  /** Free text of each event. */
  readonly text?: readonly string[];
  /** Ids of the channels each event applies to. An empty list names no channel. */
  readonly channels?: ReadonlyArray<readonly string[]>;
  /** The events' snippets, when the channel stores them and the query asked for them. */
  readonly waveforms?: Waveforms;
}

/** Per-bin event counts read from one count level of an event channel. */
export interface EventCounts {
  /** Channel id the counts belong to. */
  readonly channel: string;
  /** The count level read, numbered from 1. */
  readonly level: number;
  /** Start time of the first bin. */
  readonly startUs: number;
  /** Width of one bin. */
  readonly periodUs: number;
  /** Number of label categories: the values per bin. */
  readonly labelCount: number;
  /**
   * Events in each bin per label category, `labelCount` values per bin, flattened
   * row-major.
   */
  readonly counts: Uint32Array;
}

/**
 * The bundle's `recording.json`: identity and the wall-clock time of its origin.
 *
 * Every other time in a bundle counts from the origin, its reference time. Each
 * field is absent when the file omits it.
 */
export interface RecordingInfo {
  /** The reference time as written, an RFC 3339 timestamp. */
  readonly referenceTime?: string;
  /**
   * The reference time in microseconds since the Unix epoch. Add a bundle time to
   * it for wall-clock time.
   */
  readonly referenceTimeUs?: number;
  readonly subject?: Readonly<Record<string, unknown>>;
  readonly session?: Readonly<Record<string, unknown>>;
  readonly source?: Readonly<Record<string, unknown>>;
}

/**
 * What a read is for, which decides how early it is admitted.
 *
 * `viewport` is what the user is looking at, `prefetch` is where they are
 * likely to look next, and `background` is work whose result is not on screen,
 * such as a survey of the whole recording.
 */
export type ReadPriority = "viewport" | "prefetch" | "background";

/** Bytes to read from a key: a window, or the last `suffixLength` bytes. */
export type ByteRange =
  | { readonly offset: number; readonly length: number }
  | { readonly suffixLength: number };

/** Per-read options passed to a Store. */
export interface StoreOptions {
  readonly signal?: AbortSignal;
}

/**
 * The read-only storage surface the reader consumes.
 *
 * Both reads resolve to `undefined` for an absent key. Implementations own
 * authentication and transport.
 *
 * `getRange` is required. Every bundle array is sharded, and reading a shard
 * fetches its index and then the inner chunk as byte ranges.
 */
export interface Store {
  get(key: `/${string}`, opts?: StoreOptions): Promise<Uint8Array | undefined>;
  getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined>;
}

/** Strips `readonly` so a result object can be filled in field by field. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
