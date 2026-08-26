import pLimit from "p-limit";
import { MAX_INFLIGHT_FETCHES } from "./constants.js";
import type { ReadPriority } from "./types.js";

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

/**
 * Runs at most a fixed number of tasks at once, admitting the highest priority waiting.
 *
 * Submission order holds within a priority.
 */
export type PriorityLimit = <T>(
  priority: ReadPriority,
  task: () => Promise<T>,
) => Promise<T>;

/** Admission order, highest priority first. */
const PRIORITIES: readonly ReadPriority[] = [
  "viewport",
  "prefetch",
  "background",
];

/** One priority's queue and its share of the pool. */
interface PriorityTier {
  readonly queue: Array<() => void>;
  /** Most tasks of this priority that may run at once. */
  readonly max: number;
  active: number;
}

/**
 * Creates the limit that admits level reads, highest priority first.
 *
 * A lower priority holds only part of the pool, so a survey of the whole recording
 * submitted before the first viewport read cannot take every slot. A priority with
 * nothing running is admitted ahead of the order, so no priority waits forever and a
 * query whose reads were only partly admitted always finishes. Order within one priority
 * is the order of submission, which is the order a query yields its traces in.
 *
 * `concurrency` overrides the `MAX_INFLIGHT_FETCHES` default.
 *
 * Throws a TypeError when `concurrency` is not a positive integer.
 */
export function createPriorityLimit(
  concurrency: number = MAX_INFLIGHT_FETCHES,
): PriorityLimit {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Expected `concurrency` to be a number from 1 and up");
  }

  const share = (divisor: number): number =>
    Math.max(1, Math.floor(concurrency / divisor));
  const tiers: Record<ReadPriority, PriorityTier> = {
    viewport: { queue: [], max: concurrency, active: 0 },
    prefetch: { queue: [], max: share(2), active: 0 },
    background: { queue: [], max: share(4), active: 0 },
  };
  let active = 0;

  /**
   * Slots held back for a lower priority that is waiting with nothing running. One slot
   * always stays available to `viewport`, so the reservation cannot invert the order.
   */
  const reserved = (): number => {
    let waiting = 0;
    for (const priority of PRIORITIES) {
      const tier = tiers[priority];
      if (
        priority !== "viewport" &&
        tier.active === 0 &&
        tier.queue.length > 0
      ) {
        waiting += 1;
      }
    }
    return Math.min(waiting, concurrency - 1);
  };

  const nextTier = (): PriorityTier | undefined => {
    const budget = concurrency - reserved();
    for (const priority of PRIORITIES) {
      const tier = tiers[priority];
      if (tier.queue.length === 0 || tier.active >= tier.max) {
        continue;
      }
      if (active < (priority === "viewport" ? budget : concurrency)) {
        return tier;
      }
    }
    return undefined;
  };

  const admit = (): void => {
    for (;;) {
      if (active >= concurrency) {
        return;
      }
      const tier = nextTier();
      const start = tier?.queue.shift();
      if (tier === undefined || start === undefined) {
        return;
      }
      active += 1;
      tier.active += 1;
      start();
    }
  };

  return <T>(priority: ReadPriority, task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const tier = tiers[priority];
      tier.queue.push(() => {
        void (async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          } finally {
            active -= 1;
            tier.active -= 1;
            admit();
          }
        })();
      });
      admit();
    });
}
