import {
  withByteCaching,
  withConsolidatedMetadata,
  withRangeCoalescing,
} from "zarrita";
import type { ByteRange, Store } from "../types.js";
import { createFetchLimit } from "../fetch.js";

/**
 * A bounded store of response bytes, keyed by request.
 *
 * `has` separates a key cached as absent, whose value is `undefined`, from one that was
 * never read.
 */
export interface ByteCache {
  has(key: string): boolean;
  get(key: string): Uint8Array | undefined;
  set(key: string, value: Uint8Array | undefined): void;
}

/**
 * Creates a byte cache that evicts least recently used first, once the bytes it holds
 * would exceed `maxBytes`.
 *
 * Reading a key makes it the most recently used. A value larger than `maxBytes` is not
 * stored. An absent key holds no bytes and is never evicted for size.
 *
 * Throws a RangeError when `maxBytes` is negative.
 */
export function createByteCache(maxBytes: number): ByteCache {
  if (!(maxBytes >= 0)) {
    throw new RangeError(`maxBytes must not be negative (got ${maxBytes})`);
  }

  const entries = new Map<string, Uint8Array | undefined>();
  let held = 0;

  const drop = (key: string): void => {
    held -= entries.get(key)?.byteLength ?? 0;
    entries.delete(key);
  };

  return {
    has: (key) => entries.has(key),

    get: (key) => {
      if (!entries.has(key)) {
        return undefined;
      }
      // Re-inserting moves the key to the end of the Map's iteration order, which is
      // the order eviction walks.
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set: (key, value) => {
      if (entries.has(key)) {
        drop(key);
      }
      const size = value?.byteLength ?? 0;
      if (size > maxBytes) {
        return;
      }
      entries.set(key, value);
      held += size;
      for (const oldest of entries.keys()) {
        if (held <= maxBytes) {
          break;
        }
        drop(oldest);
      }
    },
  };
}

/** Identifies the bytes a read asks for, so two callers asking for the same ones match. */
function readKey(path: string, range?: ByteRange): string {
  if (range === undefined) {
    return path;
  }
  return "suffixLength" in range
    ? `${path}\0s:${range.suffixLength}`
    : `${path}\0r:${range.offset}:${range.length}`;
}

/** A read in flight, and the callers waiting on it. */
interface SharedRead {
  readonly bytes: Promise<Uint8Array | undefined>;
  /** Cancels the request in flight. Replaced when a merged neighbour's abort forces a re-read. */
  controller: AbortController;
  /** Callers waiting that have not aborted. */
  waiting: number;
  /** A caller that passed no signal joined, so the read runs to completion. */
  pinned: boolean;
}

/** Whether a rejection is an abort rather than a transport failure. */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Wraps a store so callers asking for the same bytes while a read is in flight share it.
 *
 * Two reads match when their key and byte range are equal. The shared read carries an
 * `AbortSignal` of its own. One caller aborting rejects that caller and leaves the bytes
 * to finish for the rest; the read itself is cancelled once every caller waiting on it
 * has aborted, which is what stops a discarded viewport from holding the connection. A
 * caller that passes no signal cannot abort, so it holds the read to completion for
 * everyone. A read cancelled from below, by a neighbouring range merged into the same
 * request, is read again under a fresh signal the remaining callers still control. A
 * read that settles is forgotten, so a later caller reads again and a failure is never
 * retained.
 *
 * Layer this beneath {@link createCachingStore}: the cache answers what it already holds,
 * and this collapses the concurrent misses that reach past it.
 */
export function createDedupingStore(store: Store): Store {
  const inflight = new Map<string, SharedRead>();

  const share = (
    key: string,
    read: (signal?: AbortSignal) => Promise<Uint8Array | undefined>,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> => {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }

    let entry = inflight.get(key);
    if (entry?.controller.signal.aborted === true) {
      // Cancelled, and still listed until its rejection settles. A caller arriving
      // now wants these bytes, so it needs a read of its own rather than this one's
      // guaranteed abort.
      entry = undefined;
    }
    if (entry === undefined) {
      const fresh: Omit<SharedRead, "bytes"> = {
        controller: new AbortController(),
        waiting: 0,
        pinned: false,
      };
      const bytes = read(fresh.controller.signal).catch((error: unknown) => {
        // A neighbouring range merged with this one downstream shares one request,
        // so its abort lands here too. When this read was not the one cancelled, read
        // again under a new controller, so the callers still waiting can cancel the
        // re-read the way they could the first.
        if (!fresh.controller.signal.aborted && isAbortError(error)) {
          fresh.controller = new AbortController();
          return read(fresh.controller.signal);
        }
        throw error;
      });
      entry = Object.assign(fresh, { bytes });
      inflight.set(key, entry);
      const forget = (): void => {
        if (inflight.get(key) === entry) {
          inflight.delete(key);
        }
      };
      // Handling both outcomes here keeps a rejection no caller awaited from surfacing
      // as an unhandled rejection.
      bytes.then(forget, forget);
    }

    const joined = entry;
    if (signal === undefined) {
      joined.pinned = true;
      return joined.bytes;
    }

    const waiter = signal;
    joined.waiting += 1;
    return new Promise((resolve, reject) => {
      const stopListening = (): void => {
        waiter.removeEventListener("abort", onAbort);
      };
      function onAbort(): void {
        joined.waiting -= 1;
        if (joined.waiting === 0 && !joined.pinned) {
          joined.controller.abort(waiter.reason);
        }
        reject(waiter.reason);
      }
      waiter.addEventListener("abort", onAbort, { once: true });
      joined.bytes.then(
        (value) => {
          stopListening();
          resolve(value);
        },
        (error: unknown) => {
          stopListening();
          reject(error);
        },
      );
    });
  };

  return {
    get: (key, opts) =>
      share(readKey(key), (signal) => store.get(key, { signal }), opts?.signal),
    getRange: (key, range, opts) =>
      share(
        readKey(key, range),
        (signal) => store.getRange(key, range, { signal }),
        opts?.signal,
      ),
  };
}

/**
 * Wraps a store so at most `maxConcurrent` reads are in flight, started in the order they
 * were submitted.
 *
 * Layer this innermost, beneath {@link createCoalescingStore}. What reaches it is then
 * one request per merged range, which is what the transport actually sends. Grouping is
 * decided above it, so waiting for a slot delays a request without splitting a batch.
 * Placing it above a layer that awaits a read would deadlock instead: the readers of one
 * shard index all wait on the single read that fetches it, and that read needs a slot of
 * its own.
 *
 * A caller whose signal aborts while queued rejects when its slot comes up, without
 * reaching the store.
 *
 * Throws a TypeError when `maxConcurrent` is not a positive integer.
 */
export function createThrottlingStore(
  store: Store,
  maxConcurrent: number,
): Store {
  const limit = createFetchLimit(maxConcurrent);

  const run = <T>(
    task: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }
    return limit(() => {
      // The wait for a slot can outlive the caller.
      signal?.throwIfAborted();
      return task();
    });
  };

  return {
    get: (key, opts) => run(() => store.get(key, opts), opts?.signal),
    getRange: (key, range, opts) =>
      run(() => store.getRange(key, range, opts), opts?.signal),
  };
}

/**
 * Wraps a store so ranged reads of one key issued in the same microtask become one read.
 *
 * A read spanning several inner chunks of a shard asks for each separately. Merging them
 * trades a few unused bytes between chunks for one round trip instead of several. Suffix
 * reads are passed through unmerged.
 *
 * Layer this beneath {@link createCachingStore}, so the cache is keyed by the range each
 * caller asked for rather than by whatever a merge produced.
 */
export function createCoalescingStore(store: Store): Store {
  return withRangeCoalescing(store);
}

/**
 * Wraps a store so a repeated read of the same key and byte range is served from memory.
 *
 * Whole-key and ranged reads are both cached, which covers array metadata, shard
 * indices, and chunk bytes. A bundle is immutable, so a hit is never revalidated.
 *
 * Throws a RangeError when `maxBytes` is negative.
 */
export function createCachingStore(store: Store, maxBytes: number): Store {
  return withByteCaching(store, { cache: createByteCache(maxBytes) });
}

/**
 * Wraps a store so every array's `zarr.json` comes from the root's consolidated
 * metadata rather than a request per array.
 *
 * Reads `/zarr.json` once on construction. The wrapped store reports the root group
 * without its `consolidated_metadata` block, so read the catalog through the store
 * passed in, not the one returned.
 *
 * Throws when the root carries no consolidated metadata.
 */
export function createConsolidatedStore(store: Store): Promise<Store> {
  return withConsolidatedMetadata(store, { format: "v3" });
}
