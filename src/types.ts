/**
 * A contiguous run of one channel's data for a single (channel, chunk), ready for canvas
 * rendering.
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
 * The reader's analogue of the legacy streaming service's neural-event message.
 * Timestamps are UTC microseconds; waveform samples are physical units.
 * `times` and `data` are flattened interleaved pairs (two values per entry).
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
  /** Event times as flattened interleaved pairs. */
  times: Float64Array;
  /** Spike waveform samples as flattened interleaved (min, max) pairs. */
  data: Float64Array;
};

/**
 *  A structural subset of zarrita's `Readable`.
 *  The minimal read-only storage surface the reader depends on.
 *  Defined here so this module does not need to import zarrita.
 *
 * `get` resolves to the bytes stored at an absolute key, or `undefined` when the key is
 * absent (a missing key is not an error). Authentication, HTTP range requests, and
 * networking are the Store's concern; the reader never sees URLs or credentials.
 *
 * zarr.ts adapts a real zarrita store to this type.
 */
export type Store = {
  get(key: `/${string}`, opts?: unknown): Promise<Uint8Array | undefined>;
};
