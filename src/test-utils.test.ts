import { expect, test } from "vitest";
import { createMemoryStore } from "./test-utils.js";

test("resolves the bytes stored for a key", async () => {
  const store = createMemoryStore({ "/a.bin": new Uint8Array([1, 2, 3]) });
  expect(Array.from((await store.get("/a.bin")) ?? [])).toEqual([1, 2, 3]);
});

test("encodes string values as UTF-8", async () => {
  const json = '{"n":"\u00e9"}';
  const store = createMemoryStore({ "/zarr.json": json });

  const bytes = await store.get("/zarr.json");

  expect(new TextDecoder().decode(bytes)).toBe(json);
  // 9 characters, one of which needs two bytes: latin1 would give 9.
  expect(bytes?.length).toBe(10);
});

test("resolves undefined for an absent key rather than throwing", async () => {
  const store = createMemoryStore({});
  await expect(store.get("/missing")).resolves.toBeUndefined();
});

test("keeps an empty file distinct from an absent one", async () => {
  const store = createMemoryStore({ "/empty": new Uint8Array(0) });
  expect((await store.get("/empty"))?.length).toBe(0);
  expect(await store.get("/absent")).toBeUndefined();
});

test("serves a byte window from a key", async () => {
  const store = createMemoryStore({
    "/a.bin": new Uint8Array([1, 2, 3, 4, 5]),
  });
  const bytes = await store.getRange("/a.bin", { offset: 1, length: 3 });
  expect(Array.from(bytes ?? [])).toEqual([2, 3, 4]);
});

test("serves a suffix, which is how a shard index is read", async () => {
  const store = createMemoryStore({
    "/a.bin": new Uint8Array([1, 2, 3, 4, 5]),
  });
  const bytes = await store.getRange("/a.bin", { suffixLength: 2 });
  expect(Array.from(bytes ?? [])).toEqual([4, 5]);
});

test("resolves undefined for a range of an absent key", async () => {
  const store = createMemoryStore({});
  await expect(
    store.getRange("/missing", { offset: 0, length: 1 }),
  ).resolves.toBeUndefined();
});

test("rejects reads carrying an already-aborted signal", async () => {
  const store = createMemoryStore({ "/a.bin": new Uint8Array([1]) });
  const signal = AbortSignal.abort();
  await expect(store.get("/a.bin", { signal })).rejects.toThrow(/abort/i);
  await expect(
    store.getRange("/a.bin", { offset: 0, length: 1 }, { signal }),
  ).rejects.toThrow(/abort/i);
});

test("resolves a copy, so mutating a read cannot corrupt the fixture", async () => {
  const store = createMemoryStore({ "/a.bin": new Uint8Array([1, 2, 3]) });

  const first = await store.get("/a.bin");
  expect(first).toBeDefined();
  if (first) first[0] = 99;

  expect(Array.from((await store.get("/a.bin")) ?? [])).toEqual([1, 2, 3]);
});
