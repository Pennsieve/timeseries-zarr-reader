import { describe, expect, test } from "vitest";
import {
  createByteCache,
  createCachingStore,
  createCoalescingStore,
  createConsolidatedStore,
  createDedupingStore,
  createThrottlingStore,
} from "./cache.js";
import type { Store } from "../types.js";
import {
  bundleMetadata,
  createCountingStore,
  createMemoryStore,
} from "../test-utils.js";

const bytes = (length: number): Uint8Array => new Uint8Array(length);

describe("createByteCache", () => {
  test("returns a stored value and reports it present", () => {
    const cache = createByteCache(1024);
    cache.set("a", bytes(8));

    expect(cache.has("a")).toBe(true);
    expect(cache.get("a")).toHaveLength(8);
  });

  test("separates a key cached as absent from one never read", () => {
    const cache = createByteCache(1024);
    cache.set("missing", undefined);

    expect(cache.has("missing")).toBe(true);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("unread")).toBe(false);
  });

  test("rejects a negative cap", () => {
    expect(() => createByteCache(-1)).toThrow(RangeError);
  });

  test("evicts the least recently used entry once the cap is passed", () => {
    const cache = createByteCache(20);
    cache.set("a", bytes(10));
    cache.set("b", bytes(10));
    cache.set("c", bytes(10));

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  test("a read makes an entry the most recently used", () => {
    const cache = createByteCache(20);
    cache.set("a", bytes(10));
    cache.set("b", bytes(10));
    cache.get("a");
    cache.set("c", bytes(10));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  test("does not store a value larger than the cap", () => {
    const cache = createByteCache(20);
    cache.set("a", bytes(10));
    cache.set("big", bytes(21));

    expect(cache.has("big")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  test("replacing a key releases the bytes it held", () => {
    const cache = createByteCache(20);
    cache.set("a", bytes(20));
    cache.set("a", bytes(1));
    cache.set("b", bytes(10));

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(true);
  });
});

describe("createCachingStore", () => {
  test("serves a repeated whole-key read from memory", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/zarr.json": "{}" }),
    );
    const cached = createCachingStore(store, 1024);

    await cached.get("/zarr.json");
    await cached.get("/zarr.json");

    expect(reads.get("/zarr.json")).toBe(1);
  });

  test("serves a repeated ranged read from memory", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": bytes(64) }),
    );
    const cached = createCachingStore(store, 1024);

    await cached.getRange("/0/0/c/0", { offset: 0, length: 8 });
    await cached.getRange("/0/0/c/0", { offset: 0, length: 8 });

    expect(reads.get("/0/0/c/0")).toBe(1);
  });

  test("keys each byte range separately", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": bytes(64) }),
    );
    const cached = createCachingStore(store, 1024);

    await cached.getRange("/0/0/c/0", { offset: 0, length: 8 });
    await cached.getRange("/0/0/c/0", { offset: 8, length: 8 });
    await cached.getRange("/0/0/c/0", { suffixLength: 8 });

    expect(reads.get("/0/0/c/0")).toBe(3);
  });

  test("reads through to the store once an entry is evicted", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/a": bytes(8), "/b": bytes(8) }),
    );
    const cached = createCachingStore(store, 8);

    await cached.get("/a");
    await cached.get("/b");
    await cached.get("/a");

    expect(reads.get("/a")).toBe(2);
  });
});

describe("createDedupingStore", () => {
  /** A store whose reads settle only when the test releases them. */
  function gatedStore(): {
    store: Store;
    reads: number;
    release: (value?: Uint8Array) => void;
    fail: (error: Error) => void;
  } {
    const pending: Array<{
      resolve: (v: Uint8Array | undefined) => void;
      reject: (e: Error) => void;
    }> = [];
    const queue = (): Promise<Uint8Array | undefined> =>
      new Promise<Uint8Array | undefined>((resolve, reject) => {
        state.reads += 1;
        pending.push({ resolve, reject });
      });
    const state = {
      store: { get: queue, getRange: queue },
      reads: 0,
      release: (value: Uint8Array = bytes(4)) => {
        for (const p of pending.splice(0)) p.resolve(value);
      },
      fail: (error: Error) => {
        for (const p of pending.splice(0)) p.reject(error);
      },
    };
    return state;
  }

  test("collapses concurrent reads of the same range into one", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);

    const both = Promise.all([
      deduped.getRange("/0/1/c/0", { offset: 0, length: 8 }),
      deduped.getRange("/0/1/c/0", { offset: 0, length: 8 }),
    ]);
    expect(gate.reads).toBe(1);
    gate.release(bytes(8));
    const [first, second] = await both;

    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
  });

  test("collapses concurrent whole-key reads into one", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);

    const both = Promise.all([
      deduped.get("/zarr.json"),
      deduped.get("/zarr.json"),
    ]);
    expect(gate.reads).toBe(1);
    gate.release();
    await both;
  });

  test("keeps distinct ranges and distinct keys separate", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);

    const all = Promise.all([
      deduped.getRange("/a", { offset: 0, length: 8 }),
      deduped.getRange("/a", { offset: 8, length: 8 }),
      deduped.getRange("/a", { suffixLength: 8 }),
      deduped.getRange("/b", { offset: 0, length: 8 }),
    ]);
    expect(gate.reads).toBe(4);
    gate.release();
    await all;
  });

  test("reads again once the shared read has settled", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);

    const first = deduped.get("/zarr.json");
    gate.release();
    await first;
    const second = deduped.get("/zarr.json");
    gate.release();
    await second;

    expect(gate.reads).toBe(2);
  });

  test("one caller aborting leaves the others unaffected", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);
    const quitter = new AbortController();

    const abandoned = deduped.get("/zarr.json", { signal: quitter.signal });
    const kept = deduped.get("/zarr.json");
    expect(gate.reads).toBe(1);

    quitter.abort();
    await expect(abandoned).rejects.toThrow();
    gate.release(bytes(8));

    expect(await kept).toHaveLength(8);
  });

  /** Records the signal each read was given, so abort propagation is observable. */
  function watchedStore(): {
    store: Store;
    reads: () => number;
    cancelled: () => number;
    release: (value?: Uint8Array) => void;
  } {
    const pending: Array<(value: Uint8Array | undefined) => void> = [];
    const signals: AbortSignal[] = [];
    const record = (opts?: {
      signal?: AbortSignal;
    }): Promise<Uint8Array | undefined> => {
      if (opts?.signal !== undefined) {
        signals.push(opts.signal);
      }
      return new Promise((resolve) => pending.push(resolve));
    };
    return {
      store: {
        get: (_key, opts) => record(opts),
        getRange: (_key, _range, opts) => record(opts),
      },
      reads: () => signals.length,
      cancelled: () => signals.filter((signal) => signal.aborted).length,
      release: (value: Uint8Array = bytes(4)) => {
        for (const resolve of pending.splice(0)) resolve(value);
      },
    };
  }

  test("cancels the underlying read once every caller has aborted", async () => {
    const watched = watchedStore();
    const deduped = createDedupingStore(watched.store);
    const first = new AbortController();
    const second = new AbortController();

    const a = deduped.get("/zarr.json", { signal: first.signal });
    const b = deduped.get("/zarr.json", { signal: second.signal });
    expect(watched.reads()).toBe(1);
    expect(watched.cancelled()).toBe(0);

    first.abort();
    await expect(a).rejects.toThrow();
    expect(watched.cancelled()).toBe(0);

    second.abort();
    await expect(b).rejects.toThrow();
    expect(watched.cancelled()).toBe(1);
  });

  test("leaves the underlying read running while a caller is still waiting", async () => {
    const watched = watchedStore();
    const deduped = createDedupingStore(watched.store);
    const quitter = new AbortController();
    const stayer = new AbortController();

    const abandoned = deduped.get("/zarr.json", { signal: quitter.signal });
    const kept = deduped.get("/zarr.json", { signal: stayer.signal });

    quitter.abort();
    await expect(abandoned).rejects.toThrow();
    expect(watched.cancelled()).toBe(0);

    watched.release(bytes(8));
    expect(await kept).toHaveLength(8);
  });

  test("a caller without a signal holds the underlying read to completion", async () => {
    const watched = watchedStore();
    const deduped = createDedupingStore(watched.store);
    const quitter = new AbortController();

    const kept = deduped.get("/zarr.json");
    const abandoned = deduped.get("/zarr.json", { signal: quitter.signal });

    quitter.abort();
    await expect(abandoned).rejects.toThrow();
    expect(watched.cancelled()).toBe(0);

    watched.release(bytes(8));
    expect(await kept).toHaveLength(8);
  });

  test("reads again under a live signal when a merged neighbour aborts the shared read", async () => {
    let reads = 0;
    const seen: Array<AbortSignal | undefined> = [];
    const store: Store = {
      get: async (_key, opts) => {
        reads += 1;
        seen.push(opts?.signal);
        if (reads === 1) {
          // A neighbouring range merged with this one downstream was cancelled.
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return bytes(8);
      },
      getRange: async () => undefined,
    };
    const deduped = createDedupingStore(store);

    expect(await deduped.get("/zarr.json")).toHaveLength(8);
    expect(reads).toBe(2);
    expect(seen[1]).toBeDefined();
    expect(seen[1]?.aborted).toBe(false);
    expect(seen[1]).not.toBe(seen[0]);
  });

  test("cancels the re-read when the last waiting caller aborts", async () => {
    let reads = 0;
    const seen: Array<AbortSignal | undefined> = [];
    const store: Store = {
      get: (_key, opts) => {
        reads += 1;
        seen.push(opts?.signal);
        if (reads === 1) {
          return Promise.reject(
            Object.assign(new Error("aborted"), { name: "AbortError" }),
          );
        }
        // The re-read stays in flight until the test looks at its signal.
        return new Promise(() => {});
      },
      getRange: async () => undefined,
    };
    const deduped = createDedupingStore(store);
    const caller = new AbortController();

    const pending = deduped.get("/zarr.json", { signal: caller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBe(2);
    expect(seen[1]?.aborted).toBe(false);

    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(seen[1]?.aborted).toBe(true);
  });

  test("starts a new read when the shared one was already cancelled", async () => {
    const watched = watchedStore();
    const deduped = createDedupingStore(watched.store);
    const quitter = new AbortController();

    // A page is requested, then a dump aborts it, cancelling the shared read.
    const abandoned = deduped.get("/zarr.json", { signal: quitter.signal });
    quitter.abort();
    await expect(abandoned).rejects.toThrow();
    expect(watched.cancelled()).toBe(1);

    // The viewer immediately re-requests the same page. It must not join the
    // read that was just cancelled.
    const retried = deduped.get("/zarr.json");
    expect(watched.reads()).toBe(2);

    watched.release(bytes(8));
    expect(await retried).toHaveLength(8);
  });

  test("an already-aborted caller rejects without reading (dedup)", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);
    const controller = new AbortController();
    controller.abort();

    await expect(
      deduped.get("/zarr.json", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(gate.reads).toBe(0);
  });

  test("a failed shared read rejects every caller and is not retained", async () => {
    const gate = gatedStore();
    const deduped = createDedupingStore(gate.store);

    const both = Promise.allSettled([
      deduped.get("/zarr.json"),
      deduped.get("/zarr.json"),
    ]);
    gate.fail(new Error("transport down"));
    const results = await both;
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);

    const retry = deduped.get("/zarr.json");
    gate.release();
    await retry;
    expect(gate.reads).toBe(2);
  });
});

describe("createThrottlingStore", () => {
  /** Typed key list, since Store keys are template-literal typed. */
  const keys = (...paths: Array<`/${string}`>): Array<`/${string}`> => paths;

  /** Counts reads that overlap, and the order they reached the store. */
  function tracked(): {
    store: Store;
    peak: () => number;
    keys: string[];
  } {
    let open = 0;
    let peak = 0;
    const keys: string[] = [];
    const enter = async (key: string): Promise<Uint8Array | undefined> => {
      keys.push(key);
      open += 1;
      peak = Math.max(peak, open);
      try {
        // Two turns, so an unbounded caller would overlap here.
        await Promise.resolve();
        await Promise.resolve();
        return new Uint8Array(4);
      } finally {
        open -= 1;
      }
    };
    return {
      store: { get: (key) => enter(key), getRange: (key) => enter(key) },
      peak: () => peak,
      keys,
    };
  }

  test("holds concurrent reads to the requested cap", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 2);

    await Promise.all(
      keys("/a", "/b", "/c", "/d", "/e", "/f").map((key) => throttled.get(key)),
    );

    expect(inner.peak()).toBe(2);
    expect(inner.keys).toHaveLength(6);
  });

  test("lets every read through when the cap is not reached", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 8);

    await Promise.all(
      keys("/a", "/b", "/c", "/d").map((key) => throttled.get(key)),
    );

    expect(inner.peak()).toBe(4);
  });

  test("counts whole-key and ranged reads against one cap", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 1);

    await Promise.all([
      throttled.get("/a"),
      throttled.getRange("/b", { offset: 0, length: 8 }),
    ]);

    expect(inner.peak()).toBe(1);
    expect(inner.keys).toEqual(["/a", "/b"]);
  });

  test("releases a slot when a read fails", async () => {
    let started = 0;
    const failing: Store = {
      get: async () => {
        started += 1;
        throw new Error("transport down");
      },
      getRange: async () => undefined,
    };
    const throttled = createThrottlingStore(failing, 1);

    await expect(throttled.get("/a")).rejects.toThrow("transport down");
    await expect(throttled.get("/b")).rejects.toThrow("transport down");
    expect(started).toBe(2);
  });

  test("rejects a queued read whose signal aborts, without reading", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 1);
    const quitter = new AbortController();

    const running = throttled.get("/a");
    const queued = throttled.get("/b", { signal: quitter.signal });
    quitter.abort();

    await expect(queued).rejects.toThrow();
    await running;

    expect(inner.keys).toEqual(["/a"]);
  });

  test("frees the slot a queued read gave up", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 1);
    const quitter = new AbortController();

    const running = throttled.get("/a");
    const abandoned = throttled.get("/b", { signal: quitter.signal });
    const waiting = throttled.get("/c");
    quitter.abort();

    await expect(abandoned).rejects.toThrow();
    await Promise.all([running, waiting]);

    expect(inner.keys).toEqual(["/a", "/c"]);
  });

  test("rejects an already-aborted caller without taking a place", async () => {
    const inner = tracked();
    const throttled = createThrottlingStore(inner.store, 1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      throttled.get("/a", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(inner.keys).toEqual([]);
  });

  test("passes the caller's options through to the store", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const store: Store = {
      get: async (_key, opts) => {
        seen.push(opts?.signal);
        return new Uint8Array(4);
      },
      getRange: async () => undefined,
    };
    const throttled = createThrottlingStore(store, 4);
    const controller = new AbortController();

    await throttled.get("/a", { signal: controller.signal });

    expect(seen).toEqual([controller.signal]);
  });

  test("throws for a concurrency that is not a positive integer", () => {
    const inner = tracked();

    expect(() => createThrottlingStore(inner.store, 0)).toThrow(TypeError);
    expect(() => createThrottlingStore(inner.store, 1.5)).toThrow(TypeError);
  });
});

describe("createCoalescingStore", () => {
  /** 0..255 as bytes, so a slice reports the offset it came from. */
  const ramp = Uint8Array.from({ length: 256 }, (_, i) => i);

  test("merges adjacent ranges even when the throttle defers them", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": ramp }),
    );
    // The layering #openBundle uses: grouping happens above the throttle, so a
    // wait for a slot must not split a batch.
    const coalesced = createCoalescingStore(createThrottlingStore(store, 1));

    const [first, second] = await Promise.all([
      coalesced.getRange("/0/0/c/0", { offset: 0, length: 8 }),
      coalesced.getRange("/0/0/c/0", { offset: 8, length: 8 }),
    ]);

    expect(reads.get("/0/0/c/0")).toBe(1);
    expect(Array.from(first ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(second ?? [])).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test("merges adjacent ranges of one key into one read", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": ramp }),
    );
    const coalesced = createCoalescingStore(store);

    const [first, second] = await Promise.all([
      coalesced.getRange("/0/0/c/0", { offset: 0, length: 8 }),
      coalesced.getRange("/0/0/c/0", { offset: 8, length: 8 }),
    ]);

    expect(reads.get("/0/0/c/0")).toBe(1);
    expect(Array.from(first ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Array.from(second ?? [])).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
  });

  test("keeps distant ranges as separate reads", async () => {
    const big = new Uint8Array(200_000);
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": big }),
    );
    const coalesced = createCoalescingStore(store);

    await Promise.all([
      coalesced.getRange("/0/0/c/0", { offset: 0, length: 8 }),
      coalesced.getRange("/0/0/c/0", { offset: 150_000, length: 8 }),
    ]);

    expect(reads.get("/0/0/c/0")).toBe(2);
  });

  test("does not merge across keys", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/a": ramp, "/b": ramp }),
    );
    const coalesced = createCoalescingStore(store);

    await Promise.all([
      coalesced.getRange("/a", { offset: 0, length: 8 }),
      coalesced.getRange("/b", { offset: 0, length: 8 }),
    ]);

    expect(reads.get("/a")).toBe(1);
    expect(reads.get("/b")).toBe(1);
  });

  test("passes a suffix read through unmerged", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/0/0/c/0": ramp }),
    );
    const coalesced = createCoalescingStore(store);

    const tail = await coalesced.getRange("/0/0/c/0", { suffixLength: 4 });

    expect(reads.get("/0/0/c/0")).toBe(1);
    expect(Array.from(tail ?? [])).toEqual([252, 253, 254, 255]);
  });
});

describe("createConsolidatedStore", () => {
  const root = bundleMetadata([
    {
      path: "0",
      attributes: {
        id: "a",
        name: "A",
        unit: "uV",
        rate_hz: 1000,
        start_us: 0,
        kind: "continuous",
      },
      levels: [{ shape: [32], periodUs: 1000 }],
    },
  ]);

  test("serves an array's metadata without reading its own key", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/zarr.json": root }),
    );
    const consolidated = await createConsolidatedStore(store);

    const raw = await consolidated.get("/0/0/zarr.json");
    expect(raw).toBeDefined();
    const node: unknown = JSON.parse(new TextDecoder().decode(raw));
    expect(node).toMatchObject({ node_type: "array", shape: [32] });
    expect(reads.has("/0/0/zarr.json")).toBe(false);
  });

  test("reports the root group without its consolidated metadata", async () => {
    const store = createMemoryStore({ "/zarr.json": root });
    const consolidated = await createConsolidatedStore(store);

    const raw = await consolidated.get("/zarr.json");
    const node: unknown = JSON.parse(new TextDecoder().decode(raw));
    expect(node).not.toHaveProperty("consolidated_metadata");
    expect(node).toMatchObject({ node_type: "group" });
  });

  test("passes a chunk read through to the store", async () => {
    const { store, reads } = createCountingStore(
      createMemoryStore({ "/zarr.json": root, "/0/0/c/0": bytes(128) }),
    );
    const consolidated = await createConsolidatedStore(store);

    await consolidated.getRange("/0/0/c/0", { offset: 0, length: 4 });

    expect(reads.get("/0/0/c/0")).toBe(1);
  });

  test("rejects a root carrying no consolidated metadata", async () => {
    const store = createMemoryStore({
      "/zarr.json": '{"zarr_format":3,"node_type":"group","attributes":{}}',
    });

    await expect(createConsolidatedStore(store)).rejects.toThrow();
  });
});
