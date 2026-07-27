import { expect, test } from "vitest";
import { createMemoryStore } from "./test-utils";

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

test("resolves a copy, so mutating a read cannot corrupt the fixture", async () => {
  const store = createMemoryStore({ "/a.bin": new Uint8Array([1, 2, 3]) });

  const first = await store.get("/a.bin");
  expect(first).toBeDefined();
  if (first) first[0] = 99;

  expect(Array.from((await store.get("/a.bin")) ?? [])).toEqual([1, 2, 3]);
});
