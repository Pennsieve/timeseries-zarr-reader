import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ByteRange, Store, StoreOptions } from "../types.js";

/** Returns whether an error is the filesystem's ENOENT, the one failure that means an absent key. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * A `Store` over a bundle directory on disk.
 *
 * Node-only (`node:fs`); must not be reachable from a browser entry point. Intended for CI
 * fixtures, offline development, and local inspection.
 *
 * Keys resolve beneath `root`; a key that resolves outside `root` throws. A ranged read seeks
 * and reads only the requested bytes. Nothing is cached or held open between reads.
 *
 * A missing file resolves to `undefined`; an empty file resolves to zero bytes. Any other
 * filesystem failure propagates.
 */
export class FileStore implements Store {
  /** The bundle directory as given, unresolved. */
  readonly root: string;

  readonly #base: string;

  constructor(root: string) {
    this.root = root;
    this.#base = resolve(root);
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
      // A range past the end of the file returns the bytes present, not zero padding.
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

  /** Resolves a key to an absolute path. Throws when the key resolves outside the bundle root. */
  #pathFor(key: `/${string}`): string {
    const path = resolve(this.#base, `.${key}`);
    const within = relative(this.#base, path);
    if (within.startsWith("..") || isAbsolute(within)) {
      throw new Error(`key ${key} resolves outside the bundle root`);
    }
    return path;
  }
}
