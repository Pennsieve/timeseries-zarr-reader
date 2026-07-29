import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FetchStore } from "zarrita";
import { FileStore } from "./file";
import { openBundle } from "./open-bundle";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reader-openbundle-"));
  await writeFile(join(root, "zarr.json"), '{"zarr_format":3}');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("opens an absolute path with the filesystem store", async () => {
  const store = await openBundle(root);
  expect(store).toBeInstanceOf(FileStore);
});

test("opens a file:// URL with the filesystem store, decoding the path", async () => {
  const spaced = await mkdtemp(join(tmpdir(), "reader with space-"));
  try {
    const store = await openBundle(pathToFileURL(spaced).href);
    expect(store).toBeInstanceOf(FileStore);
    expect((store as FileStore).root).toBe(spaced);
  } finally {
    await rm(spaced, { recursive: true, force: true });
  }
});

test("reads through the store it returns", async () => {
  const store = await openBundle(root);
  const bytes = await store.get("/zarr.json");
  expect(new TextDecoder().decode(bytes)).toBe('{"zarr_format":3}');
});

test("opens http and https URLs with the fetch store", async () => {
  expect(await openBundle("http://localhost:9090/sample.zarr")).toBeInstanceOf(
    FetchStore,
  );
  expect(await openBundle("https://example.org/sample.zarr")).toBeInstanceOf(
    FetchStore,
  );
});

test("refuses a scheme it has no store for", async () => {
  await expect(openBundle("s3://bucket/sample.zarr")).rejects.toThrow(/s3:/);
});

test("refuses a relative path rather than guessing a working directory", async () => {
  await expect(openBundle("sample.zarr")).rejects.toThrow(/absolute/);
});
