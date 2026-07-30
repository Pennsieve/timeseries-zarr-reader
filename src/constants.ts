/** Decimation ratio between adjacent pyramid levels. */
export const DECIMATION_FACTOR = 4;

/**
 * Default byte cap on a raw read forced by an active filter or montage, summed
 * across the requested channels. A window that would exceed the cap throws
 * `FilterWindowTooWide` instead of fetching the raw level.
 */
export const FILTER_MAX_BYTES = 15_000_000;

/** Maximum chunk fetches the reader keeps in flight at once. */
export const MAX_INFLIGHT_FETCHES = 8;

/**
 * Largest gap, in samples, that a filter carries its state across. A chunk
 * starting further than this past the previous chunk's end is filtered from a
 * cleared state.
 */
export const FILTER_GAP_RESET_SAMPLES = 100;

/**
 * A segment is resampled onto the pixel grid only when one pixel spans more
 * than this many source bins. Below that, the segment is returned as fetched.
 */
export const RESAMPLE_PIXEL_RATIO = 3;

/**
 * Minimum on-screen pixel span a spike waveform must exceed for its samples to
 * be fetched.
 */
export const MIN_WAVEFORM_PIXELS = 10;
