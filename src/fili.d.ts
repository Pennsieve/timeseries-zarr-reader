/**
 * Type declarations for `fili`, which provides none. Declares only the
 * surface the reader uses. Parameter names come from fili.js.
 *
 * Bandpass and bandstop take a center frequency and a width in octaves, not
 * two edge frequencies. Edges passed under other names silently yield null
 * coefficients and NaN output.
 *
 * The package is CommonJS, declared with `export =` and consumed via a default
 * import. Named ESM imports fail on native Node.
 */
declare module "fili" {
  /**
   * A biquad's coefficients plus its delay registers. Produced by the cascade
   * builders and consumed by the filter constructor. Callers do not read its
   * fields.
   */
  interface BiquadCoeffs {
    a: number[];
    b: number[];
    k: number;
    z: number[];
    a0: number;
  }

  /**
   * Parameters for the lowpass and highpass builders. Frequencies are in
   * hertz, matching `Fs`.
   */
  interface EdgeCascadeParams {
    /** Number of stages. The builder silently clamps above 12. */
    order: number;
    characteristic: "butterworth";
    /** Sampling rate. */
    Fs: number;
    /** Cutoff frequency. */
    Fc: number;
  }

  /**
   * Parameters for the bandpass and bandstop builders. `Fc` is the band center
   * frequency.
   */
  interface BandCascadeParams extends EdgeCascadeParams {
    /** Band width in octaves. */
    BW: number;
  }

  /** Builds the per-stage coefficients for a cascaded IIR filter. */
  interface CalcCascades {
    lowpass(params: EdgeCascadeParams): BiquadCoeffs[];
    highpass(params: EdgeCascadeParams): BiquadCoeffs[];
    bandpass(params: BandCascadeParams): BiquadCoeffs[];
    bandstop(params: BandCascadeParams): BiquadCoeffs[];
  }

  /**
   * A cascaded IIR filter. Each instance owns its delay registers, so two
   * built from the same coefficients are independent.
   */
  interface IirFilter {
    /**
     * Filters a run of samples in order. Returns a plain array, even for
     * typed-array input. `overwrite` filters in place instead.
     */
    multiStep(input: ArrayLike<number>, overwrite?: boolean): number[];
    /** Zeroes the delay registers. */
    reinit(): void;
  }

  const fili: {
    CalcCascades: new () => CalcCascades;
    IirFilter: new (coeffs: BiquadCoeffs[]) => IirFilter;
  };
  export = fili;
}
