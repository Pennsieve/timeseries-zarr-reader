import { FetchStore } from "zarrita";
import type { Store } from "../types.js";

/** The HTTP store used for http(s) locations. */
export { FetchStore };

const SUPPORTED_LOCATIONS =
  'http(s):// URLs, file:// URLs, and absolute filesystem paths starting with "/"';

/** Constructs the filesystem store, importing its module on first use. */
async function loadFileStore(path: string): Promise<Store> {
  const { FileStore } = await import("./file.js");
  return new FileStore(path);
}

/**
 * Returns a `Store` for a bundle location, chosen by URL scheme.
 *
 * `http://` and `https://` URLs use `FetchStore`; `file://` URLs and absolute filesystem
 * paths use `FileStore`, imported dynamically to keep `node:fs` out of browser bundles.
 * Relative paths and unrecognized schemes throw.
 *
 * A store that needs credentials must be constructed by the consumer and passed as a `Store`
 * directly. Every store must implement `getRange`; bundle arrays are sharded.
 */
export async function openBundle(url: string): Promise<Store> {
  if (url.startsWith("/")) {
    return loadFileStore(url);
  }

  let location: URL;
  try {
    location = new URL(url);
  } catch {
    throw new Error(
      `openBundle needs ${SUPPORTED_LOCATIONS} (got ${JSON.stringify(url)})`,
    );
  }

  if (location.protocol === "http:" || location.protocol === "https:") {
    return new FetchStore(url);
  }
  if (location.protocol === "file:") {
    const { fileURLToPath } = await import("node:url");
    return loadFileStore(fileURLToPath(location));
  }

  throw new Error(
    `openBundle cannot open a ${location.protocol} location; it supports ${SUPPORTED_LOCATIONS}`,
  );
}
