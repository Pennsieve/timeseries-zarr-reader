import type { ContinuousEntry } from "./catalog.js";
import type { Run, Store, StoreOptions } from "./types.js";
import { binEdgeUs, binStartUs } from "./grid.js";
import { readInt64Rows } from "./zarr.js";

/**
 * Reads a continuous channel's runs: every span of samples recorded one period
 * apart, with the exact time each began.
 *
 * A channel without a `runs` table is one run from its first sample, and an empty
 * channel has none. A stored table is checked before it is returned: row 0 starts
 * the channel at `offset_us`, runs are in order and do not overlap, the last ends at
 * the last sample, and each starts within one sample period of its grid sample. A
 * failed check throws, naming the channel and the row.
 */
export async function readRuns(
  store: Store,
  entry: ContinuousEntry,
  opts?: StoreOptions,
): Promise<Run[]> {
  const { info, sampleCount } = entry;
  const endOf = (startUs: number, count: number): number =>
    binEdgeUs(count, startUs, info.rateHz, 1, "ceil");

  if (entry.runs === undefined) {
    return sampleCount === 0
      ? []
      : [
          {
            firstSample: 0,
            sampleCount,
            startUs: info.startUs,
            endUs: endOf(info.startUs, sampleCount),
          },
        ];
  }

  const { data } = await readInt64Rows(
    store,
    entry.runs.path,
    { start: 0, end: entry.runs.rows },
    opts,
  );
  const periodUs = 1e6 / info.rateHz;
  const runs: Run[] = [];
  for (let row = 0; row < entry.runs.rows; row++) {
    const firstSample = data[row * 3]!;
    const count = data[row * 3 + 1]!;
    const startUs = data[row * 3 + 2]!;
    const fail = (reason: string): Error =>
      new Error(
        `${entry.path} runs row ${row} [${firstSample}, ${count}, ${startUs}] ${reason}`,
      );

    if (count < 1) {
      throw fail("holds no samples");
    }
    const previous = runs[runs.length - 1];
    if (previous === undefined) {
      if (firstSample !== 0 || startUs !== info.startUs) {
        throw fail(
          `must be [0, n, ${info.startUs}]: the channel's first sample at offset_us`,
        );
      }
    } else {
      const previousEnd = previous.firstSample + previous.sampleCount;
      if (firstSample < previousEnd) {
        throw fail(
          `overlaps the run before it, which ends at sample ${previousEnd}`,
        );
      }
      const previousEndUs = binStartUs(
        previous.sampleCount,
        previous.startUs,
        info.rateHz,
        1,
      );
      if (startUs < previousEndUs) {
        throw fail(
          `starts before the run before it ends at ${previousEndUs} us`,
        );
      }
    }
    const gridUs = binStartUs(firstSample, info.startUs, info.rateHz, 1);
    if (!(Math.abs(startUs - gridUs) < periodUs)) {
      throw fail(
        `starts ${startUs - gridUs} us from its grid sample; the bound is one sample period`,
      );
    }
    runs.push({
      firstSample,
      sampleCount: count,
      startUs,
      endUs: endOf(startUs, count),
    });
  }

  const last = runs[runs.length - 1]!;
  if (last.firstSample + last.sampleCount !== sampleCount) {
    throw new Error(
      `${entry.path} runs end at sample ${last.firstSample + last.sampleCount} but raw holds ${sampleCount} samples`,
    );
  }
  return runs;
}
