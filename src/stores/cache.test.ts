import { describe, expect, test } from "vitest";
import {
  createByteCache,
  createCachingStore,
  createConsolidatedStore,
} from "./cache.js";
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
