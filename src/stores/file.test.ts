import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./file.js";

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

test("resolves undefined for a missing file", async () => {
  await expect(store.get("/absent")).resolves.toBeUndefined();
});

test("keeps an empty file distinct from a missing one", async () => {
  expect((await store.get("/empty"))?.length).toBe(0);
  await expect(store.get("/absent")).resolves.toBeUndefined();
});

test("reads an offset range", async () => {
  const bytes = await store.getRange("/0/1/chunk", { offset: 1, length: 3 });
  expect(Array.from(bytes ?? [])).toEqual([2, 3, 4]);
});

test("reads a suffix range", async () => {
  const bytes = await store.getRange("/0/1/chunk", { suffixLength: 2 });
  expect(Array.from(bytes ?? [])).toEqual([4, 5]);
});

test("resolves undefined for a range of a missing file", async () => {
  await expect(
    store.getRange("/absent", { offset: 0, length: 2 }),
  ).resolves.toBeUndefined();
});

test("rejects a key that escapes the bundle root", async () => {
  await expect(store.get("/../outside")).rejects.toThrow(/root/);
  await expect(
    store.getRange("/0/../../outside", { offset: 0, length: 1 }),
  ).rejects.toThrow(/root/);
});

test("rejects reads with an already-aborted signal", async () => {
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

test("propagates a ranged-read failure other than a missing file", async () => {
  // Reading a directory fails with an error other than ENOENT.
  await expect(
    store.getRange("/0", { offset: 0, length: 1 }),
  ).rejects.toThrow();
});
