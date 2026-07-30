import { FetchStore } from "zarrita";
import type { Store } from "../types.js";

// The HTTP store the reader itself picks for http(s) locations, re-exported for consumers.
export { FetchStore };

const SUPPORTED =
  'http(s):// URLs, file:// URLs, and absolute filesystem paths starting with "/"';

/** Load the filesystem store on demand, so its `node:fs` import stays out of a browser bundle. */
const fileStore = async (path: string): Promise<Store> => {
  const { FileStore } = await import("./file.js");
  return new FileStore(path);
};

/**
 * Open a bundle by location, choosing the store its scheme calls for.
 *
 * `http://` and `https://` get the HTTP store; `file://` and a bare absolute path get the
 * filesystem store. After this call the reader sees only a `Store` - no URLs, no schemes.
 *
 * Async, and the filesystem store is imported only when a location asks for it, so a browser
 * bundle that fetches over HTTP never pulls `node:fs` into its graph.
 *
 * Deliberately not a store registry, and there is no scheme for authenticated access. A store
 * that needs credentials cannot be chosen by scheme alone - it needs a signer or a token - so a
 * consumer builds that store itself and passes it to the reader directly. That store must serve
 * ranged reads, since bundle arrays are sharded.
 *
 * A relative path is refused rather than resolved against the working directory, which a library
 * has no business guessing at. Anything else that is not one of the supported forms throws,
 * naming what is supported.
 */
export async function openBundle(url: string): Promise<Store> {
  if (url.startsWith("/")) {
    return fileStore(url);
  }

  let location: URL;
  try {
    location = new URL(url);
  } catch {
    throw new Error(
      `openBundle needs ${SUPPORTED} (got ${JSON.stringify(url)})`,
    );
  }

  if (location.protocol === "http:" || location.protocol === "https:") {
    return new FetchStore(url);
  }
  if (location.protocol === "file:") {
    const { fileURLToPath } = await import("node:url");
    return fileStore(fileURLToPath(location));
  }

  throw new Error(
    `openBundle cannot open a ${location.protocol} location; it supports ${SUPPORTED}`,
  );
}
