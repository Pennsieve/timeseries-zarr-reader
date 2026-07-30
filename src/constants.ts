/** Fixed decimation ratio between adjacent pyramid levels: each level is 4x coarser. */
export const DECIMATION_FACTOR = 4;

/**
 * Byte cap for a raw read forced by an active filter or montage, summed across the
 * requested channels. A window that would exceed this surfaces an error instead of
 * silently fetching the full raw level. Roughly 15 MB.
 */
export const FILTER_MAX_BYTES = 15_000_000;

/** Maximum chunk fetches the reader keeps in flight at once. */
export const MAX_INFLIGHT_FETCHES = 8;

/**
 * Largest gap, in samples, that a filter carries its state across. A chunk starting further
 * than this past the previous chunk's end is filtered from a cleared state.
 */
export const FILTER_GAP_RESET_SAMPLES = 100;

/**
 * A segment is resampled onto the pixel grid only when one pixel spans more than this many
 * source bins. Below it the data already sits near pixel resolution and is delivered as
 * fetched.
 */
export const RESAMPLE_PIXEL_RATIO = 3;

/**
 * Gates spike-waveform fetching: a waveform is fetched only when it spans more than this
 * many pixels on screen. Larger values fetch waveforms only when more zoomed in.
 */
export const SEND_SPIKE_THRESHOLD = 10;
