import { expect, test } from "vitest";
import { createFetchLimit } from "./fetch.js";

/** A promise with its resolve function exposed. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Resolves after already-scheduled microtasks and timer callbacks have run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("resolves a task's value", async () => {
  const limit = createFetchLimit();
  await expect(limit(() => Promise.resolve(7))).resolves.toBe(7);
});

test("runs no more tasks at once than the cap, starting them in order", async () => {
  const limit = createFetchLimit(2);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started: number[] = [];
  let active = 0;
  let peak = 0;

  const runs = gates.map((gate, index) =>
    limit(async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    }),
  );

  await flush();
  expect(started).toEqual([0, 1]);

  gates[0]?.resolve();
  await flush();
  expect(started).toEqual([0, 1, 2]);

  gates[1]?.resolve();
  gates[2]?.resolve();
  await Promise.all(runs);

  expect(peak).toBe(2);
});

test("a rejected task does not block queued tasks", async () => {
  const limit = createFetchLimit(1);

  const failed = limit(() => Promise.reject(new Error("read failed")));
  const queued = limit(() => Promise.resolve("ok"));

  await expect(failed).rejects.toThrow(/read failed/);
  await expect(queued).resolves.toBe("ok");
});

test("turns a task's synchronous throw into a rejection", async () => {
  const limit = createFetchLimit(1);
  await expect(
    limit(() => {
      throw new Error("boom");
    }),
  ).rejects.toThrow(/boom/);
});

test("throws for a concurrency that is not a positive integer", () => {
  expect(() => createFetchLimit(0)).toThrow(TypeError);
  expect(() => createFetchLimit(-1)).toThrow(TypeError);
  expect(() => createFetchLimit(1.5)).toThrow(TypeError);
});
