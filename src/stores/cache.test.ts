import { describe, expect, test } from "vitest";
import {
  createByteCache,
  createCachingStore,
  createCoalescingStore,
  createConsolidatedStore,
  createDedupingStore,
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

  test("an already-aborted caller rejects without reading", async () => {
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

describe("createCoalescingStore", () => {
  /** 0..255 as bytes, so a slice reports the offset it came from. */
  const ramp = Uint8Array.from({ length: 256 }, (_, i) => i);

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
