/**
 * Types for `fili`, which ships none and has no community typings package.
 *
 * Declares only the surface the reader uses.
 *
 * Parameter names come from fili.js directly. Note: a bandpass or bandstop
 * is specified by centre frequency and width, not by the two edges, and the
 * width is in octaves. Passing edge frequencies under other names silently yields
 * null coefficients and a filter that returns NaN.
 */
declare module "fili" {
  /**
   * A biquad's coefficients plus its delay registers. Produced by
   * the cascade builders and consumed by the filter, opaque in between.
   */
  export type BiquadCoeffs = {
    a: number[];
    b: number[];
    k: number;
    z: number[];
    a0: number;
  };

  /** How to build one cascade. Frequencies are in hertz, matching `Fs`. */
  export type CascadeParams = {
    /** Number of stages; the builder clamps above 12 rather than refusing. */
    order: number;
    characteristic: "butterworth";
    /** Sampling rate. */
    Fs: number;
    /** Cutoff for lowpass and highpass; band centre for bandpass and bandstop. */
    Fc: number;
    /** Band width in octaves. Band filters only, where it is required despite the type. */
    BW?: number;
  };

  /** Builds the per-stage coefficients for a cascaded IIR filter. */
  export class CalcCascades {
    lowpass(params: CascadeParams): BiquadCoeffs[];
    highpass(params: CascadeParams): BiquadCoeffs[];
    bandpass(params: CascadeParams): BiquadCoeffs[];
    bandstop(params: CascadeParams): BiquadCoeffs[];
  }

  /**
   * A cascaded IIR filter. Each instance owns its delay registers,
   * so instances built from the same coefficients stay independent.
   */
  export class IirFilter {
    constructor(coeffs: BiquadCoeffs[]);
    /**
     * Filter a run of samples in order, returning a plain array, including
     * when handed a typed array. Use `overwrite` to filter in place instead.
     */
    multiStep(input: ArrayLike<number>, overwrite?: boolean): number[];
    /** Zero the delay registers. */
    reinit(): void;
  }
}
