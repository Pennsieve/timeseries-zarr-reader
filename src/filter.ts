// fili is CommonJS; native Node ESM guarantees only the default export for CJS modules.
import fili from "fili";
import type { FilterSpec, Segment } from "./types.js";
import { FILTER_GAP_RESET_SAMPLES } from "./constants.js";

const { CalcCascades, IirFilter } = fili;

/** Maximum filter order the cascade builder accepts. Above this it silently clamps. */
const MAX_ORDER = 12;

/**
 * A stateful Butterworth filter.
 *
 * `process` carries IIR state across calls: a signal delivered in chunks
 * filters identically to the same signal delivered whole.
 */
export interface Filter {
  /** Filters one chunk of samples in order and returns a new array. The input is not modified. */
  process(samples: Float64Array): Float64Array;
  /**
   * Discards state carried from earlier chunks; the next `process` call starts
   * fresh. Use across a break in the signal.
   */
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
  // The builder takes a center frequency and a width in octaves, not the two edges.
  const params = {
    ...shared,
    Fc: Math.sqrt(spec.lowHz * spec.highHz),
    BW: Math.log2(spec.highHz / spec.lowHz),
  };
  return spec.type === "bandpass"
    ? cascades.bandpass(params)
    : cascades.bandstop(params);
}

/**
 * Builds a Butterworth filter for one channel.
 *
 * `rateHz` is the channel's native sampling rate; it fixes the meaning of every
 * frequency in `spec`. Samples stay in physical units: no unit conversion, no
 * gain. For bandpass and bandstop, `lowHz` and `highHz` are the band edges,
 * converted to the center frequency and octave width the cascade builder
 * takes. Attenuation at the nominal edges deepens with `order`.
 *
 * Throws a RangeError for an `order` that is not an integer from 1 to 12, a
 * frequency not strictly between 0 and half `rateHz`, or a `lowHz` at or above
 * its `highHz`.
 */
export function createFilter(spec: FilterSpec, rateHz: number): Filter {
  if (
    !Number.isInteger(spec.order) ||
    spec.order < 1 ||
    spec.order > MAX_ORDER
  ) {
    throw new RangeError(
      `order must be a whole number from 1 to ${MAX_ORDER} (got ${spec.order})`,
    );
  }

  const filter = new IirFilter(designCoefficients(spec, rateHz));
  return {
    process: (samples) => Float64Array.from(filter.multiStep(samples)),
    reset: () => filter.reinit(),
  };
}

/**
 * Filters raw segments, holding filter state per (channel, spec, rate).
 *
 * Sessions are independent: two sessions filtering the same channel do not
 * share state.
 */
export interface FilterSession {
  /**
   * Filters one raw segment. Returns a new segment with the filtered data;
   * the input is not modified.
   *
   * State carries over from the previous segment of the same (channel, spec,
   * rate) when this segment starts within `FILTER_GAP_RESET_SAMPLES` sample
   * periods of where that segment ended. An initial segment, a wider gap, or
   * a jump backwards filters from a cleared state.
   *
   * An empty segment returns empty and leaves the state unchanged.
   * Throws a RangeError for a min/max segment.
   */
  apply(segment: Segment, spec: FilterSpec, rateHz: number): Segment;
  /** Drops all held state. */
  clear(): void;
}

/** Canonical key for a spec; equal specs produce equal keys. */
function specKey(spec: FilterSpec): string {
  return spec.type === "lowpass" || spec.type === "highpass"
    ? `${spec.type}:${spec.order}:${spec.cutoffHz}`
    : `${spec.type}:${spec.order}:${spec.lowHz}:${spec.highHz}`;
}

/**
 * Creates a filter session.
 *
 * One filter accumulates per (channel, spec, rate) applied; `clear` releases
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

      // The spec and rate parts contain no "|"; a channel id containing the
      // separator cannot collide with another key.
      const key = `${specKey(spec)}|${rateHz}|${segment.channel}`;
      let entry = entries.get(key);

      if (entry === undefined) {
        // A new filter starts cleared; no continuity check needed.
        entry = { filter: createFilter(spec, rateHz), nextStartUs: 0 };
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
