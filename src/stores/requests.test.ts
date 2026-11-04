/**
 * Pins how many store requests a read sends per shard.
 *
 * A cold read of a shard fetches its index with one suffix request and the
 * inner chunks it needs with one merged range request. Once the client holds
 * the index, a read of the same shard sends the range request alone. Counts
 * start after the client has opened the bundle.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { StreamingClient } from "../index.js";
import type { QueryOptions } from "../index.js";
import { collect, createCountingStore } from "../test-utils.js";
import { FileStore } from "./file.js";
import type { CountingStore } from "../test-utils.js";

const SAMPLE = fileURLToPath(
  new URL("../../test-data/sample.zarr", import.meta.url),
);
const THIRTY_KHZ = fileURLToPath(
  new URL("../../test-data/conformance/continuous_30khz", import.meta.url),
);
const CHANNEL = "continuous_30khz";
const RATE_HZ = 30_000;

// continuous_30khz: 6000 samples, shards of 1024 rows, inner chunks of 256
// rows. Level 1 has 4 samples per bin, 1500 rows, shards of 512 rows, and
// inner chunks of 256 rows.
const SAMPLES_PER_BIN = 4;
const BIN_US = (SAMPLES_PER_BIN * 1_000_000) / RATE_HZ;
const LEVEL_1_PIXEL_US = 134;

interface Opened {
  readonly client: StreamingClient;
  readonly counting: CountingStore;
}

/** Opens the bundle at `path` over a counting store and loads the catalog. */
async function openCounted(
  path: string,
  options: { readonly maxCacheBytes?: number } = {},
): Promise<Opened> {
  const counting = createCountingStore(new FileStore(path));
  const client = new StreamingClient({ store: counting.store, ...options });
  await client.channelInfo();
  return { client, counting };
}

/** Returns the requests that reach the store while `run` settles. */
async function requestsDuring(
  counting: CountingStore,
  run: () => Promise<unknown>,
): Promise<number> {
  const before = counting.total();
  await run();
  return counting.total() - before;
}

/** A raw query over samples `first` up to `last` of the 30 kHz channel. */
function rawQuery(first: number, last: number): QueryOptions {
  return {
    channels: [CHANNEL],
    startUs: Math.floor((first * 1_000_000) / RATE_HZ),
    endUs: Math.floor((last * 1_000_000) / RATE_HZ),
    pixelWidthUs: 1,
    raw: true,
  };
}

/** A level 1 query over bins `first` up to `last` of the 30 kHz channel. */
function levelQuery(first: number, last: number): QueryOptions {
  return {
    channels: [CHANNEL],
    startUs: Math.ceil(first * BIN_US),
    endUs: Math.floor(last * BIN_US),
    pixelWidthUs: LEVEL_1_PIXEL_US,
  };
}

const READS: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly query: (first: number, last: number) => QueryOptions;
  /** Key suffix of a shard past its row index. */
  readonly column: string;
  /** Rows in one shard. */
  readonly shardRows: number;
  /** Rows in one inner chunk. */
  readonly chunkRows: number;
}> = [
  {
    name: "raw level",
    path: "/0/raw/c",
    column: "",
    query: rawQuery,
    shardRows: 1024,
    chunkRows: 256,
  },
  {
    name: "level 1",
    path: "/0/1/minmax/c",
    column: "/0",
    query: levelQuery,
    shardRows: 512,
    chunkRows: 256,
  },
];

describe.each(READS)("$name of continuous_30khz", (read) => {
  const { query, path, column, shardRows, chunkRows } = read;

  test("sends 2 requests for a cold read inside one shard", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(10, chunkRows - 10))),
    );

    expect(sent).toBe(2);
    expect(counting.reads.get(`${path}/0${column}`)).toBe(2);
  });

  test("merges adjacent inner chunks of one shard into one range", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(10, 2 * chunkRows - 10))),
    );

    expect(sent).toBe(2);
  });

  test("sends 1 request for another chunk range of a warm shard", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);
    await collect(client.query(query(10, chunkRows - 10)));

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(chunkRows + 10, 2 * chunkRows - 10))),
    );

    expect(sent).toBe(1);
  });

  test("sends no request for a range it already holds", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);
    await collect(client.query(query(10, chunkRows - 10)));

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(10, chunkRows - 10))),
    );

    expect(sent).toBe(0);
  });

  test("sends 4 requests for a cold read across a shard edge", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(shardRows - 20, shardRows + 20))),
    );

    expect(sent).toBe(4);
    expect(counting.reads.get(`${path}/0${column}`)).toBe(2);
    expect(counting.reads.get(`${path}/1${column}`)).toBe(2);
  });

  test("sends 2 requests for a warm read across a shard edge", async () => {
    const { client, counting } = await openCounted(THIRTY_KHZ);
    // Chunks away from the edge, one in each shard.
    await collect(client.query(query(10, chunkRows - 10)));
    await collect(
      client.query(query(2 * shardRows - chunkRows + 10, 2 * shardRows - 10)),
    );

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query(shardRows - 20, shardRows + 20))),
    );

    expect(sent).toBe(2);
  });
});

describe("query over several channels of sample.zarr", () => {
  const RAW_CHANNELS = ["sineA", "sineB", "noise"];
  // Raw arrays hold 30000 samples at 1 kHz in 4 inner chunks of 8192 rows.
  const raw = (firstMs: number, lastMs: number): QueryOptions => ({
    channels: RAW_CHANNELS,
    startUs: firstMs * 1000,
    endUs: lastMs * 1000,
    pixelWidthUs: 1,
    raw: true,
  });

  test("sends 2 requests per channel when cold", async () => {
    const { client, counting } = await openCounted(SAMPLE);

    const sent = await requestsDuring(counting, () =>
      collect(client.query(raw(3_000, 4_000))),
    );

    expect(sent).toBe(2 * RAW_CHANNELS.length);
  });

  test("sends 1 request per channel when warm", async () => {
    const { client, counting } = await openCounted(SAMPLE);
    await collect(client.query(raw(3_000, 4_000)));

    const sent = await requestsDuring(counting, () =>
      collect(client.query(raw(20_000, 21_000))),
    );

    expect(sent).toBe(RAW_CHANNELS.length);
  });

  test("sends 2 requests per channel for a cold level read", async () => {
    const { client, counting } = await openCounted(SAMPLE);
    const query: QueryOptions = {
      channels: [...RAW_CHANNELS, "pausedA"],
      startUs: 0,
      endUs: 30_000_000,
      pixelWidthUs: 4_000,
    };

    const sent = await requestsDuring(counting, () =>
      collect(client.query(query)),
    );
    const repeated = await requestsDuring(counting, () =>
      collect(client.query(query)),
    );

    expect(sent).toBe(2 * 4);
    expect(repeated).toBe(0);
  });
});
