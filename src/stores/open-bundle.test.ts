import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FetchStore } from "zarrita";
import { FileStore } from "./file.js";
import {
  FetchStore as ReExportedFetchStore,
  openBundle,
} from "./open-bundle.js";

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

test("opens a Windows drive-letter path with the filesystem store", async () => {
  expect(await openBundle("C:\\data\\bundle.zarr")).toBeInstanceOf(FileStore);
  expect(await openBundle("d:/data/bundle.zarr")).toBeInstanceOf(FileStore);
});

test("opens a file:// URL with the filesystem store, decoding the path", async () => {
  const spaced = await mkdtemp(join(tmpdir(), "reader with space-"));
  try {
    const store = await openBundle(pathToFileURL(spaced).href);
    if (!(store instanceof FileStore)) {
      throw new Error("expected a FileStore");
    }
    expect(store.root).toBe(spaced);
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

test("re-exports zarrita's FetchStore unchanged", () => {
  expect(ReExportedFetchStore).toBe(FetchStore);
});

test("rejects an unsupported URL scheme", async () => {
  await expect(openBundle("s3://bucket/sample.zarr")).rejects.toThrow(/s3:/);
});

test("rejects a relative path", async () => {
  await expect(openBundle("sample.zarr")).rejects.toThrow(/absolute/);
});
