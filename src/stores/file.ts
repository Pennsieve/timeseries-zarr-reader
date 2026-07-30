import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ByteRange, Store, StoreOptions } from "../types.js";

/** True for the filesystem's "no such file" - the one failure that means an absent key. */
const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

/**
 * A `Store` over a bundle directory on disk.
 *
 * Node-only: it reads through `node:fs`, so it must never be reachable from a browser entry
 * point. Its purpose is local work - CI fixtures, offline development, inspecting a bundle
 * without a server.
 *
 * Keys are absolute and resolve beneath `root`, so `/0/1/zarr.json` is that path under the
 * bundle directory. A key that would escape `root` is rejected rather than followed.
 *
 * A ranged read seeks: it opens the file and reads only the requested bytes, which is what makes
 * a 16 MB shard cheap to sample. Nothing is cached and nothing is held open between reads.
 *
 * A missing file resolves to `undefined` from either read, per the `Store` contract; an empty
 * file resolves to zero bytes, which is a different answer. Any other filesystem failure - a
 * permission error, a directory where a file was expected - propagates.
 */
export class FileStore implements Store {
  readonly root: string;

  // Written out rather than declared as a constructor parameter property: that syntax is not
  // erasable, so it breaks tools that strip types without transforming them.
  constructor(root: string) {
    this.root = root;
  }

  async get(
    key: `/${string}`,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined> {
    opts?.signal?.throwIfAborted();
    try {
      return new Uint8Array(await readFile(this.#pathFor(key)));
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async getRange(
    key: `/${string}`,
    range: ByteRange,
    opts?: StoreOptions,
  ): Promise<Uint8Array | undefined> {
    opts?.signal?.throwIfAborted();
    const path = this.#pathFor(key);
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "r");
      const length =
        "suffixLength" in range ? range.suffixLength : range.length;
      const position =
        "suffixLength" in range
          ? Math.max(0, (await handle.stat()).size - range.suffixLength)
          : range.offset;

      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      opts?.signal?.throwIfAborted();
      // A range reaching past the end returns what was there, not zero padding.
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** Absolute path for a key, refusing anything that normalises out of the bundle. */
  #pathFor(key: `/${string}`): string {
    const base = resolve(this.root);
    const path = resolve(base, `.${key}`);
    const within = relative(base, path);
    if (within.startsWith("..") || isAbsolute(within)) {
      throw new Error(`key ${key} resolves outside the bundle root`);
    }
    return path;
  }
}
