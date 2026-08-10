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
