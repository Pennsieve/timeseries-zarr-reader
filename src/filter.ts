import { CalcCascades, IirFilter } from "fili";
import type { FilterSpec, Segment } from "./types";
import { FILTER_GAP_RESET_SAMPLES } from "./constants";

/**
 * The single characteristic the reader currently offers.
 * Required by the cascade builder.
 */
const CHARACTERISTIC = "butterworth";

/**
 * The maximum number of stages the cascade builder honours
 * Beyond this it silently clamps.
 */
const MAX_ORDER = 12;

/**
 * A configured, stateful Butterworth filter.
 *
 * The recursive filter carries state from one `process` call to the next.
 * Building a filter yields an object to keep rather than a function to call
 * in order to maintain this state between chunks.
 *
 * A signal delivered in chunks should filter identically to the same signal
 * delivered whole.
 */
export type Filter = {
  /**
   * Filter one chunk of samples, in order, returning a new array.
   * The input is left untouched.
   */
  process(samples: Float64Array): Float64Array;
  /**
   * Discard the state carried from earlier chunks. Allows the next `process`
   * call to start as if nothing had been filtered.
   * Use across a break in the signal, where the previous samples are no longer
   * the immediate past.
   */
  reset(): void;
};

/**
 * Build a Butterworth filter for one channel from a filter request.
 *
 * Butterworth is the only characteristic offered, so `spec` does not name one.
 * `rateHz` is the channel's native sampling rate, which fixes the meaning of
 * every frequency in the spec.
 *
 * Samples stay in physical units: no unit conversion, no gain.
 *
 * The result is stateful and belongs to exactly one channel's stream to allow
 * for seamless joins across the stream's chunks.
 *
 * Only raw samples can be filtered. A pyramid level stores min/max extremes
 * per bin rather than a signal. No filter of extremes can accurately calculate
 * a raw, filtered signal's extremes.
 *
 * For bandpass and bandstop, `lowHz` and `highHz` name the band's edges and are converted
 * to the centre frequency and width the filter is built from.
 *
 * The cascade sharpens with order: every stage attenuates at the edges. The
 * nominal edges sit further down the skirt at higher orders rather than
 * remaining at a fixed level.
 *
 * Choose `order` for the desired skirt rather than on the assumption that
 * the edges keep a constant attenuation.
 *
 * Throws a RangeError for a spec the filter cannot honour: an `order` that is
 * not a whole number within the supported range, a frequency that is not above
 * zero and below the Nyquist frequency (half `rateHz`), or a band whose `lowHz`
 * is not below its `highHz`.
 */
export function makeFilter(spec: FilterSpec, rateHz: number): Filter {
  if (
    !Number.isInteger(spec.order) ||
    spec.order < 1 ||
    spec.order > MAX_ORDER
  ) {
    throw new RangeError(
      `order must be a whole number from 1 to ${MAX_ORDER} (got ${spec.order})`,
    );
  }

  const nyquistHz = rateHz / 2;
  const requireBelowNyquist = (freqHz: number, label: string): void => {
    if (!(freqHz > 0 && freqHz < nyquistHz)) {
      throw new RangeError(
        `${label} must be above 0 and below the Nyquist frequency of ${nyquistHz} Hz (got ${freqHz})`,
      );
    }
  };

  const cascades = new CalcCascades();
  const shared = {
    order: spec.order,
    characteristic: CHARACTERISTIC,
    Fs: rateHz,
  } as const;

  let coeffs;
  if (spec.type === "lowpass" || spec.type === "highpass") {
    requireBelowNyquist(spec.cutoffHz, "cutoffHz");
    const params = { ...shared, Fc: spec.cutoffHz };
    coeffs =
      spec.type === "lowpass"
        ? cascades.lowpass(params)
        : cascades.highpass(params);
  } else {
    requireBelowNyquist(spec.lowHz, "lowHz");
    requireBelowNyquist(spec.highHz, "highHz");
    if (spec.lowHz >= spec.highHz) {
      throw new RangeError(
        `lowHz must be below highHz (got ${spec.lowHz} and ${spec.highHz})`,
      );
    }
    // The builder takes a centre frequency and a width in octaves, not the two edges.
    const params = {
      ...shared,
      Fc: Math.sqrt(spec.lowHz * spec.highHz),
      BW: Math.log2(spec.highHz / spec.lowHz),
    };
    coeffs =
      spec.type === "bandpass"
        ? cascades.bandpass(params)
        : cascades.bandstop(params);
  }

  const filter = new IirFilter(coeffs);
  return {
    process: (samples) => Float64Array.from(filter.multiStep(samples)),
    reset: () => filter.reinit(),
  };
}

/**
 * Holds the filter state for a session, one filter per (channel, spec, rate).
 *
 * A recursive filter's output depends on the samples before it.
 * A stream arriving in chunks must maintain state between chunks.
 *
 * Sessions are independent. Two sessions filtering the same channel do not share state.
 */
export type FilterSession = {
  /**
   * Filters one raw segment.
   * Returns the filter with its samples replaced.
   *
   * State carries from the previous segment of the same session when this segment
   * is within `FILTER_GAP_RESET_SAMPLES` `samplePeriodUs` steps
   * from where the previous segment ended.
   *
   * An initial chunk, one with a wider gap, or a jump backwards,
   * all filter from a cleared state.
   *
   * An empty segment returns empty and leaves the state as it was.
   * Throws a RangeError for a min/max segment.
   */
  apply(segment: Segment, spec: FilterSpec, rateHz: number): Segment;
  /** Drop all held state. */
  clear(): void;
};

/** Canonical key for a spec, independent of the order its properties were written in. */
const specKey = (spec: FilterSpec): string =>
  spec.type === "lowpass" || spec.type === "highpass"
    ? `${spec.type}:${spec.order}:${spec.cutoffHz}`
    : `${spec.type}:${spec.order}:${spec.lowHz}:${spec.highHz}`;

/**
 * Create a filter session.
 *
 * One filter accumulates per (channel, spec, rate) applied; `clear` releases them all.
 */
export function createFilterSession(): FilterSession {
  const entries = new Map<string, { filter: Filter; nextStartUs: number }>();

  return {
    apply(segment, spec, rateHz) {
      if (segment.isMinMax) {
        throw new RangeError(
          `only raw segments can be filtered (channel ${segment.channel} carries min/max pairs)`,
        );
      }
      if (segment.data.length === 0) {
        return { ...segment };
      }

      // Channel last: the spec and rate parts have a fixed shape, so a channel key
      // containing the separator cannot be read as another entry's key.
      const key = `${specKey(spec)}|${rateHz}|${segment.channel}`;
      let entry = entries.get(key);

      if (entry === undefined) {
        // A filter starts cleared, so a first sighting needs no continuity check.
        entry = { filter: makeFilter(spec, rateHz), nextStartUs: 0 };
        entries.set(key, entry);
      } else {
        const driftUs = segment.startUs - entry.nextStartUs;
        const allowedUs = FILTER_GAP_RESET_SAMPLES * segment.samplePeriodUs;
        if (driftUs < 0 || driftUs > allowedUs) {
          entry.filter.reset();
        }
      }

      entry.nextStartUs =
        segment.startUs + segment.data.length * segment.samplePeriodUs;
      return { ...segment, data: entry.filter.process(segment.data) };
    },

    clear() {
      entries.clear();
    },
  };
}
