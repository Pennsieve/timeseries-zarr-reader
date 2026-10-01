/**
 * A contiguous run of one trace's data over a queried window.
 *
 * Timestamps are UTC microseconds. Values are in physical units; the reader
 * does not negate them.
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

/**
 * Per-channel metadata read from the bundle's Zarr group attributes.
 *
 * Timestamps are UTC microseconds.
 */
export interface ChannelInfo {
  /** Stable channel id used to address the channel in queries. */
  readonly id: string;
  /** Human-readable channel label. */
  readonly name: string;
  /** Physical unit of the samples (e.g. "uV"). */
  readonly unit: string;
  /** Native sampling rate, in hertz. */
  readonly rateHz: number;
  /** Time of the channel's first sample. */
  readonly startUs: number;
  /** Exclusive end of the channel's data: one sample period past the last sample. */
  readonly endUs: number;
  /** "continuous" for a sampled waveform, "unit" for a discrete event channel. */
  readonly kind: "continuous" | "unit";
}

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

/**
 * One unit channel's events within a query window, with their waveforms when
 * those were fetched.
 *
 * Timestamps are UTC microseconds. Waveform samples are in physical units.
 */
export interface EventBatch {
  /** Channel id the events belong to. */
  readonly channel: string;
  /** Query-window start. */
  readonly startUs: number;
  /** Query-window end, exclusive. */
  readonly endUs: number;
  /** Time between waveform samples. */
  readonly samplePeriodUs: number;
  /** Samples per spike waveform. 0 when waveforms were not fetched. */
  readonly pointsPerEvent: number;
  /** Always false: waveforms are returned as stored. */
  readonly isResampled: boolean;
  /** Timestamps of the events, ascending. */
  readonly times: Float64Array;
  /**
   * Waveform samples, one row of `pointsPerEvent` values per event, flattened
   * row-major. Empty when waveforms were not fetched.
   */
  readonly data: Float64Array;
}

/**
 * What a read is for, which decides how early it is admitted.
 *
 * `viewport` is what the user is looking at, `prefetch` is where they are
 * likely to look next, and `background` is work whose result is not on screen,
 * such as a survey of the whole recording.
 */
export type ReadPriority = "viewport" | "prefetch" | "background";

/**
 * Metadata for one event channel: annotations, detector output, or any other
 * timestamped marks stored as `kind: "event"`.
 */
export interface EventChannelInfo {
  /** Stable channel id used to address the channel in queries. */
  readonly id: string;
  /** Human-readable channel label. */
  readonly name: string;
  /** Number of events in the channel. */
  readonly count: number;
  /** Names for label categories, index-aligned. Empty when the bundle names none. */
  readonly labelNames: readonly string[];
  /** IANA media type of each event's body, e.g. "text/plain" or "application/json". */
  readonly bodyMediaType: string;
  /** Upper bound on any event's duration. 0 when every event is a point. */
  readonly maxDurationUs: number;
}

/** One event read from an event channel. Times are microseconds from recording onset. */
export interface EventRecord {
  /** Position in the channel's arrays. Stable within one bundle, not across rewrites. */
  readonly index: number;
  readonly timeUs: number;
  /** 0 for a point event. */
  readonly durationUs: number;
  /** The label's name, or its number when the bundle names none. Undefined when unlabeled. */
  readonly label: string | undefined;
  /** The body decoded as UTF-8, trailing newline removed. Undefined when there are no bodies. */
  readonly body: string | undefined;
  /** Ids of the channels the event applies to. Empty means the whole recording. */
  readonly channels: readonly string[];
}

/** An event channel's events that overlap a query window. */
export interface EventWindow {
  /** Channel id the events belong to. */
  readonly channel: string;
  /** Query-window start. */
  readonly startUs: number;
  /** Query-window end, exclusive. */
  readonly endUs: number;
  /** Events in ascending time order. */
  readonly events: readonly EventRecord[];
}

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
