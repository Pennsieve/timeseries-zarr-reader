import fili from "fili";
import type { FilterSpec, Segment } from "./types.js";
import { FILTER_GAP_RESET_SAMPLES } from "./constants.js";

const { CalcCascades, IirFilter } = fili;

/** Maximum accepted filter order. */
const MAX_ORDER = 12;

/**
 * A stateful Butterworth filter.
 *
 * `process` carries IIR state across calls. A signal delivered in chunks
 * filters identically to the same signal delivered whole.
 */
export interface Filter {
  /** Filters one chunk of samples in order and returns a new array. The input is not modified. */
  process(samples: Float64Array): Float64Array;
  /** Discards state carried from earlier chunks. */
  reset(): void;
}

/** Throws a RangeError unless `freqHz` is strictly between 0 and `nyquistHz`. */
function requireInNyquistRange(
  freqHz: number,
  nyquistHz: number,
  label: string,
): void {
  if (!(freqHz > 0 && freqHz < nyquistHz)) {
    throw new RangeError(
      `${label} must be above 0 and below the Nyquist frequency of ${nyquistHz} Hz (got ${freqHz})`,
    );
  }
}

/** Validates the spec's frequencies against `rateHz` and builds the cascade coefficients. */
function designCoefficients(spec: FilterSpec, rateHz: number) {
  const nyquistHz = rateHz / 2;
  const cascades = new CalcCascades();
  const shared = {
    order: spec.order,
    characteristic: "butterworth",
    Fs: rateHz,
  } as const;

  if (spec.type === "lowpass" || spec.type === "highpass") {
    requireInNyquistRange(spec.cutoffHz, nyquistHz, "cutoffHz");
    const params = { ...shared, Fc: spec.cutoffHz };
    return spec.type === "lowpass"
      ? cascades.lowpass(params)
      : cascades.highpass(params);
  }

  requireInNyquistRange(spec.lowHz, nyquistHz, "lowHz");
  requireInNyquistRange(spec.highHz, nyquistHz, "highHz");
  if (spec.lowHz >= spec.highHz) {
    throw new RangeError(
      `lowHz must be below highHz (got ${spec.lowHz} and ${spec.highHz})`,
    );
  }
  const params = {
    ...shared,
    Fc: Math.sqrt(spec.lowHz * spec.highHz),
    BW: Math.log2(spec.highHz / spec.lowHz),
  };
  return spec.type === "bandpass"
    ? cascades.bandpass(params)
    : cascades.bandstop(params);
}

/** Throws a RangeError for an `order` that is not a whole number from 1 to `MAX_ORDER`. */
function requireOrder(order: number): void {
  if (!Number.isInteger(order) || order < 1 || order > MAX_ORDER) {
    throw new RangeError(
      `order must be a whole number from 1 to ${MAX_ORDER} (got ${order})`,
    );
  }
}

/**
 * Checks a spec against a channel's sampling rate without building a filter.
 *
 * Throws the RangeError {@link createFilter} throws for the same spec and rate:
 * an `order` that is not an integer from 1 to 12, a frequency not strictly
 * between 0 and half `rateHz`, or a `lowHz` at or above its `highHz`.
 */
export function assertFilterSpec(spec: FilterSpec, rateHz: number): void {
  requireOrder(spec.order);
  designCoefficients(spec, rateHz);
}

/**
 * Builds a Butterworth filter for one channel.
 *
 * Every frequency in `spec` is read against `rateHz`, the channel's native
 * sampling rate. The filter applies no gain. For bandpass and bandstop,
 * `lowHz` and `highHz` are the band edges, and attenuation at those nominal
 * edges deepens with `order`.
 *
 * Throws a RangeError for an `order` that is not an integer from 1 to 12, a
 * frequency not strictly between 0 and half `rateHz`, or a `lowHz` at or above
 * its `highHz`.
 */
export function createFilter(spec: FilterSpec, rateHz: number): Filter {
  requireOrder(spec.order);
  const filter = new IirFilter(designCoefficients(spec, rateHz));
  return {
    process: (samples) => Float64Array.from(filter.multiStep(samples)),
    reset: () => filter.reinit(),
  };
}

/**
 * Filters raw segments, holding filter state per (channel, spec, rate).
 *
 * Two sessions filtering the same channel hold separate state.
 */
export interface FilterSession {
  /**
   * Filters one raw segment. Returns a new segment with the filtered data and
   * does not modify the input.
   *
   * State carries over from the previous segment of the same (channel, spec,
   * rate) when this segment starts within `FILTER_GAP_RESET_SAMPLES` sample
   * periods of where that segment ended. An initial segment, a wider gap, or a
   * jump backwards of more than one sample filters from a cleared state.
   *
   * A first sample repeating the previous segment's last is dropped. The returned
   * `startUs` advances one period, and a segment holding only the repeat comes
   * back empty. Each sample reaches the filter once, whatever windows a range was
   * read in.
   *
   * An empty segment returns empty and leaves the state unchanged.
   * Throws a RangeError for a min/max segment.
   */
  apply(segment: Segment, spec: FilterSpec, rateHz: number): Segment;
  /** Drops all held state. */
  clear(): void;
}

/** Canonical key for a spec. Equal specs produce equal keys. */
function specKey(spec: FilterSpec): string {
  return spec.type === "lowpass" || spec.type === "highpass"
    ? `${spec.type}:${spec.order}:${spec.cutoffHz}`
    : `${spec.type}:${spec.order}:${spec.lowHz}:${spec.highHz}`;
}

/**
 * Creates a filter session.
 *
 * One filter accumulates per (channel, spec, rate) applied. `clear` releases
 * them all.
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

      // The spec and rate parts contain no "|", so a channel id containing the
      // separator cannot collide with another key.
      const key = `${specKey(spec)}|${rateHz}|${segment.channel}`;
      let entry = entries.get(key);
      let alreadyFiltered = 0;

      if (entry === undefined) {
        // A new filter starts cleared, so there is no continuity to check.
        entry = { filter: createFilter(spec, rateHz), nextStartUs: 0 };
        entries.set(key, entry);
      } else {
        // Measured in samples, not microseconds. A channel period is rarely a whole
        // number of microseconds, so `startUs` carries rounding error that only a
        // round back to samples cancels.
        const driftSamples = Math.round(
          (segment.startUs - entry.nextStartUs) / segment.samplePeriodUs,
        );
        if (driftSamples === -1) {
          alreadyFiltered = 1;
        } else if (
          driftSamples < 0 ||
          driftSamples > FILTER_GAP_RESET_SAMPLES
        ) {
          entry.filter.reset();
        }
      }

      // The dropped sample was filtered with the previous segment.
      const data = segment.data.subarray(alreadyFiltered);
      const startUs =
        segment.startUs + alreadyFiltered * segment.samplePeriodUs;
      entry.nextStartUs = startUs + data.length * segment.samplePeriodUs;
      return { ...segment, startUs, data: entry.filter.process(data) };
    },

    clear() {
      entries.clear();
    },
  };
}
