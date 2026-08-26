/**
 * Default byte cap on a forced-raw read, summed across the requested traces and
 * counting both sides of a montage pair.
 */
export const MAX_RAW_BYTES = 15_000_000;

/**
 * Default cap on level reads the reader keeps in flight at once.
 *
 * One query reads every trace on screen and each read costs at least one round trip, so
 * a query serializes into `ceil(traces / cap)` rounds. A view with more traces than the
 * cap pays a round trip per extra round, whatever the bytes involved.
 */
export const MAX_INFLIGHT_FETCHES = 64;

/**
 * Default cap on transport requests in flight at once, counted after identical reads
 * collapse and adjacent ranges merge.
 *
 * A sharded level read asks for the shard index and then the inner chunks, and the two
 * phases do not overlap, so a query's peak request count is its level-read count. This
 * matches `MAX_INFLIGHT_FETCHES` for that reason: it bounds a runaway fan-out without
 * adding a round trip to a query the level cap already admitted.
 */
export const MAX_CONCURRENT_REQUESTS = 64;

/**
 * Default byte cap on the response cache a client holds over its store. Chunks span
 * more time than one query window, so adjacent windows read the same chunk.
 */
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;

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
