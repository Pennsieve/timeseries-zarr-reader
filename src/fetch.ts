import pLimit from "p-limit";
import { MAX_INFLIGHT_FETCHES } from "./constants.js";

/**
 * Runs at most a fixed number of tasks at once, starting them in submission order.
 *
 * A task's rejection reaches only its own caller and does not stall queued tasks.
 */
export type FetchLimit = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Creates a limit that runs at most `concurrency` tasks at once.
 *
 * `concurrency` overrides the `MAX_INFLIGHT_FETCHES` default, which suits the level
 * reads a query starts. A caller bounding something else passes its own value. Tasks are
 * not cancellable through the limit, so a caller that must drop queued work checks its
 * own `AbortSignal` inside the task.
 *
 * Throws a TypeError when `concurrency` is not a positive integer.
 */
export function createFetchLimit(
  concurrency: number = MAX_INFLIGHT_FETCHES,
): FetchLimit {
  // p-limit validates concurrency and isolates task rejections.
  return pLimit(concurrency);
}
