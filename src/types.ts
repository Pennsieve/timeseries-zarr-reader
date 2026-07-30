/**
 * A contiguous run of one trace's data over a queried window, ready for canvas rendering.
 *
 * Timestamps are UTC microseconds.
 *
 * Values stay in physical units; y-axis orientation is handled by the consumer.
 */
export type Segment = {
  /** Channel id this segment belongs to (a compound key when montaged). */
  channel: string;
  /** Start time of the first sample/bin. */
  startUs: number;
  /** Time between consecutive samples (raw) or bins (envelope). */
  samplePeriodUs: number;
  /**
   * True when `data` holds interleaved `[min, max, min, max, ...]` envelope pairs
   * rather than raw samples i.e. the output was decimated to the pixel grid.
   */
  isMinMax: boolean;
  /**
   * Raw samples, or interleaved `[min, max, ...]` pairs when {@link Segment.isMinMax}.
   * Always `Float64Array`, regardless of the on-disk float width.
   */
  data: Float64Array;
};

/**
 * Generic, self-describing info for one channel, read straight from the bundle's Zarr
 * group attributes - no network lookup and no host API. A consumer that needs a
 * host-specific shape builds it on top of this.
 *
 * Timestamps are UTC microseconds.
 */
export type ChannelInfo = {
  /** Stable channel id used to address the channel in queries. */
  id: string;
  /** Human-readable channel label for display. */
  name: string;
  /** Physical unit of the samples (e.g. "uV"). */
  unit: string;
  /** Native sampling rate, in hertz. */
  rateHz: number;
  /** Time of the channel's first sample. */
  startUs: number;
  /** Exclusive end of the channel's data: the time just past its last sample. */
  endUs: number;
  /**
   * Channel category: a continuous waveform, or a unit/spike channel whose data is
   * discrete events rather than a regularly-sampled signal.
   */
  kind: "continuous" | "unit";
};

/**
 * A bipolar montage pair: the rendered trace is the lead channel minus the secondary
 * channel, sample by sample (`lead[i] - secondary[i]`), in physical units. Both fields
 * are channel ids as they appear in the bundle; forming the compound display key is the
 * montage module's concern, not this type's.
 */
export type MontagePair = {
  /** Channel id whose samples are the minuend i.e. those from the lead. */
  lead: string;
  /** Channel id whose samples are the subtrahend i.e. those subtracted from the lead. */
  secondary: string;
};

/**
 * A Butterworth filter request. Frequencies are in hertz (hz) and `order` is the filter order.
 * The `type` discriminant fixes which cutoff fields apply:
 *   - lowpass/highpass take a single `cutoffHz`
 *   - bandpass/bandstop take a `lowHz`/`highHz` band.
 * Butterworth is the only characteristic, so it is not encoded here - filter.ts supplies it.
 *
 * An active filter forces a raw (level 0) read.
 * Pyramid levels are pre-decimated and cannot be filtered exactly.
 */
export type FilterSpec =
  | { type: "lowpass"; order: number; cutoffHz: number }
  | { type: "highpass"; order: number; cutoffHz: number }
  | { type: "bandpass"; order: number; lowHz: number; highHz: number }
  | { type: "bandstop"; order: number; lowHz: number; highHz: number };

/**
 * Unit/spike output for one channel over a query window.
 * Timestamps are UTC microseconds; waveform samples are physical units.
 */
export type Event = {
  /** Channel id this event stream belongs to. */
  channel: string;
  /** Query-window start, in microseconds. */
  startUs: number;
  /** Query-window end, in microseconds. */
  endUs: number;
  /** Time between waveform samples, in microseconds. */
  samplePeriodUs: number;
  /** Samples per spike waveform. 0 when waveforms were not fetched for this window. */
  pointsPerEvent: number;
  /** True when the waveforms were resampled to fit the pixel budget. */
  isResampled: boolean;
  /** Event timestamps within the window, in microseconds, ascending. */
  times: Float64Array;
  /**
   * Waveform samples, one row of `pointsPerEvent` values per event, flattened row-major.
   * Empty when waveforms were not fetched.
   */
  data: Float64Array;
};

/** Bytes to read from a key: a window, or the last `suffixLength` bytes. */
export type ByteRange =
  { offset: number; length: number } | { suffixLength: number };

/** Per-read options a Store honours. */
export type StoreOptions = {
  signal?: AbortSignal;
};

/**
 * The read-only storage surface the reader depends on, named here so this module imports no
 * zarrita.
 *
 * Both reads resolve to `undefined` for an absent key rather than throwing, since a missing
 * key is an ordinary answer. Authentication, transport, and URLs are the Store's business; the
 * reader never sees a credential.
 *
 * **`getRange` is required, not a nicety.** Every array in a bundle is sharded, and a shard is
 * read by fetching its index and then the inner chunk, so a Store offering only whole-key reads
 * cannot read bundle data at all - it can only read metadata. A Store that cannot serve ranges
 * therefore cannot back this reader.
 */
export type Store = {
  get(key: `/${string}`, opts?: StoreOptions): Promise<Uint8Array | undefined>;
  getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined>;
};
