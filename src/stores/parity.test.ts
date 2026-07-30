/**
 * The same bundle read through the filesystem store and through the HTTP store must produce
 * identical output. The test server is a minimal static file server supporting Range requests
 * in offset and suffix forms, which the HTTP store requires.
 */
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { StreamingClient, openBundle } from "../index.js";
import { collect } from "../test-utils.js";

const BUNDLE = fileURLToPath(
  new URL("../../test-data/sample.zarr", import.meta.url),
);

let server: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    void (async () => {
      const path = normalize(
        join(BUNDLE, decodeURIComponent(request.url ?? "/")),
      );
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch {
        response.writeHead(404).end();
        return;
      }

      if (request.method === "HEAD") {
        response.writeHead(200, { "content-length": data.length }).end();
        return;
      }

      const range = request.headers.range;
      if (range !== undefined) {
        const suffix = /^bytes=-(\d+)$/.exec(range);
        const window = /^bytes=(\d+)-(\d+)?$/.exec(range);
        let slice: Buffer;
        if (suffix) {
          slice = data.subarray(Math.max(0, data.length - Number(suffix[1])));
        } else if (window) {
          const start = Number(window[1]);
          const end =
            window[2] === undefined ? data.length : Number(window[2]) + 1;
          slice = data.subarray(start, Math.min(end, data.length));
        } else {
          response.writeHead(416).end();
          return;
        }
        response.writeHead(206, { "content-length": slice.length }).end(slice);
        return;
      }

      response.writeHead(200, { "content-length": data.length }).end(data);
    })();
  });
  await new Promise<void>((ready) => {
    server?.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server is not listening on a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => {
    if (server) {
      server.close(() => closed());
    } else {
      closed();
    }
  });
});

test("acceptance: file and HTTP stores produce identical output", async () => {
  const local = new StreamingClient({ store: await openBundle(BUNDLE) });
  const remote = new StreamingClient({ store: await openBundle(baseUrl) });

  const localInfos = await local.channelInfo();
  const remoteInfos = await remote.channelInfo();
  expect(remoteInfos).toEqual(localInfos);

  const [info] = localInfos;
  if (!info) throw new Error("bundle has no channels");
  const window = { startUs: info.startUs, endUs: info.startUs + 10_000_000 };

  for (const params of [
    { pixelWidthUs: 1000, minMax: false }, // raw
    { pixelWidthUs: 50_000 }, // pyramid + resample
  ]) {
    const query = { channels: [info.id], ...window, ...params };
    const [fromFile] = await collect(local.query(query));
    const [fromHttp] = await collect(remote.query(query));
    expect(fromHttp?.startUs).toBe(fromFile?.startUs);
    expect(Array.from(fromHttp?.data ?? [])).toEqual(
      Array.from(fromFile?.data ?? []),
    );
  }

  const spans = { channel: info.id, ...window };
  expect(await remote.getSegmentSpans(spans)).toEqual(
    await local.getSegmentSpans(spans),
  );
});
