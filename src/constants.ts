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
 * Gates spike-waveform fetching. Waveforms are fetched only when a single waveform is wide
 * enough on screen to be worth drawing, i.e. when
 * `pixelWidthUs * SEND_SPIKE_THRESHOLD < waveformDurationUs`. Larger values fetch waveforms
 * only when more zoomed in.
 */
export const SEND_SPIKE_THRESHOLD = 10;
