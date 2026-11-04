import { describe, expect, test } from "vitest";
import { readCatalog } from "./catalog.js";
import { readRuns } from "./runs.js";
import { bundleFiles, createMemoryStore } from "./test-utils.js";

const OFFSET_US = 1_704_067_200_000_000;

/** A channel from an epoch offset. At 512 Hz the period is 1953.125 us. */
async function open(raw: number[], runs?: number[][], rateHz = 512) {
  const store = createMemoryStore(
    bundleFiles([
      {
        index: 0,
        tsz: {
          kind: "continuous",
          id: "c",
          name: "C",
          unit: "uV",
          rate_hz: rateHz,
          offset_us: OFFSET_US,
        },
        raw,
        ...(runs === undefined ? {} : { runs }),
      },
    ]),
  );
  const [entry] = (await readCatalog(store)).channels;
  if (entry?.kind !== "continuous") {
    throw new Error("fixture has no continuous channel");
  }
  return { store, entry };
}

const samples = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index);

describe("readRuns", () => {
  test("returns one run for a channel without a table", async () => {
    const { store, entry } = await open(samples(3));

    expect(await readRuns(store, entry)).toEqual([
      {
        firstSample: 0,
        sampleCount: 3,
        startUs: OFFSET_US,
        endUs: OFFSET_US + 5860,
      },
    ]);
  });

  test("returns no runs for an empty channel", async () => {
    const { store, entry } = await open([]);

    expect(await readRuns(store, entry)).toEqual([]);
  });

  test("places an off-grid resume at its stored time", async () => {
    // Sample 10 is on the grid at 19531.25 us. The run starts 0.25 us earlier.
    const { store, entry } = await open(samples(14), [
      [0, 4, OFFSET_US],
      [10, 4, OFFSET_US + 19_531],
    ]);

    expect(await readRuns(store, entry)).toEqual([
      {
        firstSample: 0,
        sampleCount: 4,
        startUs: OFFSET_US,
        endUs: OFFSET_US + 7813,
      },
      {
        firstSample: 10,
        sampleCount: 4,
        startUs: OFFSET_US + 19_531,
        endUs: OFFSET_US + 27_344,
      },
    ]);
  });

  test("accepts a run that starts where the previous one ends", async () => {
    // Four samples end at 7812.5 us, and the next run starts at sample 4.
    const { store, entry } = await open(samples(8), [
      [0, 4, OFFSET_US],
      [4, 4, OFFSET_US + 7813],
    ]);

    const runs = await readRuns(store, entry);

    expect(runs.map((run) => run.firstSample)).toEqual([0, 4]);
  });

  describe("rejects a table that breaks the format", () => {
    const cases: Array<[string, number[], number[][], RegExp]> = [
      [
        "a run with no samples",
        samples(4),
        [[0, 0, OFFSET_US]],
        /\/0 runs row 0 \[0, 0, \d+\] holds no samples/,
      ],
      [
        "a first row that does not start at offset_us",
        samples(4),
        [[0, 4, OFFSET_US + 1]],
        /row 0 .* must be \[0, n, 1704067200000000\]/,
      ],
      [
        "a first row that does not start at sample 0",
        samples(8),
        [[1, 7, OFFSET_US]],
        /row 0 .* must be \[0, n, 1704067200000000\]/,
      ],
      [
        "a run that overlaps the one before it",
        samples(10),
        [
          [0, 4, OFFSET_US],
          [3, 7, OFFSET_US + 5859],
        ],
        /row 1 .* overlaps the run before it, which ends at sample 4/,
      ],
      [
        "a run that starts before the samples of the one before it end",
        samples(10),
        [
          [0, 4, OFFSET_US],
          [4, 6, OFFSET_US + 7812],
        ],
        /row 1 .* starts before the run before it ends at/,
      ],
      [
        "a run a full sample period from its grid sample",
        samples(10),
        [
          [0, 4, OFFSET_US],
          [6, 4, OFFSET_US + 13_672],
        ],
        /row 1 .* from its grid sample; the bound is one sample period/,
      ],
      [
        "a last run that ends before the last sample",
        samples(10),
        [[0, 9, OFFSET_US]],
        /runs end at sample 9 but raw holds 10 samples/,
      ],
    ];

    test.each(cases)("%s", async (_title, raw, runs, message) => {
      const { store, entry } = await open(raw, runs);

      await expect(readRuns(store, entry)).rejects.toThrow(message);
    });
  });

  test("rejects an offset of one period from the grid", async () => {
    // At 1000 Hz the period is 1000 us and sample 6 is on the grid at 6000 us.
    const table = (startUs: number) => [
      [0, 4, OFFSET_US],
      [6, 4, startUs],
    ];
    const inside = await open(samples(10), table(OFFSET_US + 6999), 1000);
    const edge = await open(samples(10), table(OFFSET_US + 7000), 1000);

    await expect(readRuns(inside.store, inside.entry)).resolves.toHaveLength(2);
    await expect(readRuns(edge.store, edge.entry)).rejects.toThrow(
      /starts 1000 us from its grid sample/,
    );
  });

  test("rejects when the signal is already aborted", async () => {
    const { store, entry } = await open(samples(8), [
      [0, 4, OFFSET_US],
      [4, 4, OFFSET_US + 7813],
    ]);
    await expect(
      readRuns(store, entry, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
