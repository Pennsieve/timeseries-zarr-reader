import pLimit from "p-limit";
import { MAX_INFLIGHT_FETCHES } from "./constants.js";

/**
 * Runs at most a fixed number of tasks at once, starting them in submission order.
 *
 * A task's rejection reaches only its own caller and does not stall queued tasks.
 */
export type FetchLimit = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Creates the gate that bounds in-flight chunk reads.
 *
 * `concurrency` overrides the `MAX_INFLIGHT_FETCHES` default. Cancellation is not
 * handled here; a query passes its `AbortSignal` to the store.
 *
 * Throws a TypeError when `concurrency` is not a positive integer.
 */
export function createFetchLimit(
  concurrency: number = MAX_INFLIGHT_FETCHES,
): FetchLimit {
  // p-limit validates concurrency and isolates task rejections.
  return pLimit(concurrency);
}
