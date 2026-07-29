import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./file";

let root: string;
let store: FileStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reader-filestore-"));
  await mkdir(join(root, "0", "1"), { recursive: true });
  await writeFile(join(root, "zarr.json"), '{"zarr_format":3}');
  await writeFile(
    join(root, "0", "1", "chunk"),
    new Uint8Array([1, 2, 3, 4, 5]),
  );
  await writeFile(join(root, "empty"), new Uint8Array(0));
  store = new FileStore(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reads a whole file's bytes", async () => {
  const bytes = await store.get("/zarr.json");
  expect(new TextDecoder().decode(bytes)).toBe('{"zarr_format":3}');
});

test("reads a key nested under the bundle root", async () => {
  const bytes = await store.get("/0/1/chunk");
  expect(Array.from(bytes ?? [])).toEqual([1, 2, 3, 4, 5]);
});

test("resolves undefined for a file that is not there", async () => {
  await expect(store.get("/absent")).resolves.toBeUndefined();
});

test("keeps an empty file distinct from a missing one", async () => {
  expect((await store.get("/empty"))?.length).toBe(0);
  await expect(store.get("/absent")).resolves.toBeUndefined();
});

test("reads a byte window without reading the whole file", async () => {
  const bytes = await store.getRange("/0/1/chunk", { offset: 1, length: 3 });
  expect(Array.from(bytes ?? [])).toEqual([2, 3, 4]);
});

test("reads a suffix, which is how a shard index is found", async () => {
  const bytes = await store.getRange("/0/1/chunk", { suffixLength: 2 });
  expect(Array.from(bytes ?? [])).toEqual([4, 5]);
});

test("resolves undefined for a range of a file that is not there", async () => {
  await expect(
    store.getRange("/absent", { offset: 0, length: 2 }),
  ).resolves.toBeUndefined();
});

test("refuses a key that would escape the bundle root", async () => {
  await expect(store.get("/../outside")).rejects.toThrow(/root/);
  await expect(
    store.getRange("/0/../../outside", { offset: 0, length: 1 }),
  ).rejects.toThrow(/root/);
});

test("honours a signal that is already aborted", async () => {
  await expect(
    store.get("/zarr.json", { signal: AbortSignal.abort() }),
  ).rejects.toThrow(/abort/i);
  await expect(
    store.getRange(
      "/0/1/chunk",
      { offset: 0, length: 1 },
      {
        signal: AbortSignal.abort(),
      },
    ),
  ).rejects.toThrow(/abort/i);
});

test("propagates a ranged-read failure that does not mean a missing key", async () => {
  // A directory is not an absent key, so this must not resolve to undefined.
  await expect(
    store.getRange("/0", { offset: 0, length: 1 }),
  ).rejects.toThrow();
});
