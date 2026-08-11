import {
  withByteCaching,
  withConsolidatedMetadata,
  withRangeCoalescing,
} from "zarrita";
import type { Store } from "../types.js";

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
