import pLimit from "p-limit";
import { MAX_INFLIGHT_FETCHES } from "./constants.js";

/**
 * A gate that runs at most a fixed number of tasks at once.
 *
 * Each task starts when a slot frees, in the order submitted. A task's result or rejection
 * reaches only its own caller, so one failed read does not stall the reads queued behind it.
 */
export type FetchLimit = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Create the gate that bounds in-flight chunk reads.
 *
 * A query fans out across channels and chunks, so uncapped it would open as many requests as it
 * has chunks - thousands for a wide window - and the store, the browser's connection pool, or
 * both would suffer. `MAX_INFLIGHT_FETCHES` is the default cap; `concurrency` is for tests.
 *
 * Cancellation is deliberately not handled here. Dropping queued tasks would leave the reads
 * already in flight running, so it would only look like cancelling; a query passes its own
 * AbortSignal to the store instead.
 *
 * Throws a TypeError for a concurrency that is not a whole number of at least one.
 */
export function createFetchLimit(
  concurrency: number = MAX_INFLIGHT_FETCHES,
): FetchLimit {
  // p-limit validates the concurrency itself, and its queue already survives a rejecting task.
  return pLimit(concurrency);
}
