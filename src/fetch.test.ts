import { expect, test } from "vitest";
import { createFetchLimit, createPriorityLimit } from "./fetch.js";

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

test("admits a higher priority ahead of a lower one already queued", async () => {
  const limit = createPriorityLimit(1);
  const blocker = deferred<void>();
  const started: string[] = [];

  const running = limit("viewport", async () => {
    started.push("running");
    await blocker.promise;
  });
  const low = limit("background", async () => {
    started.push("background");
  });
  const high = limit("viewport", async () => {
    started.push("viewport");
  });

  blocker.resolve();
  await Promise.all([running, low, high]);

  expect(started).toEqual(["running", "viewport", "background"]);
});

test("keeps submission order within one priority", async () => {
  const limit = createPriorityLimit(1);
  const started: number[] = [];

  await Promise.all(
    [0, 1, 2, 3].map((index) =>
      limit("viewport", async () => {
        started.push(index);
      }),
    ),
  );

  expect(started).toEqual([0, 1, 2, 3]);
});

test("leaves slots for a higher priority submitted after a lower one", async () => {
  const limit = createPriorityLimit(8);
  const blocker = deferred<void>();
  let backgroundActive = 0;
  let backgroundPeak = 0;

  const background = Array.from({ length: 16 }, () =>
    limit("background", async () => {
      backgroundActive += 1;
      backgroundPeak = Math.max(backgroundPeak, backgroundActive);
      await blocker.promise;
      backgroundActive -= 1;
    }),
  );

  await flush();
  // A survey submitted before the first viewport read must not take the pool.
  expect(backgroundPeak).toBeLessThanOrEqual(2);

  let viewportStarted = false;
  const viewport = limit("viewport", async () => {
    viewportStarted = true;
  });
  await flush();
  expect(viewportStarted).toBe(true);

  blocker.resolve();
  await Promise.all([...background, viewport]);
});

test("gives a freed slot to a waiting lower priority, not back to the higher one", async () => {
  const limit = createPriorityLimit(2);
  const gates = [deferred<void>(), deferred<void>()];
  const started: string[] = [];

  // Saturate the pool with viewport work.
  const busy = gates.map((gate) =>
    limit("viewport", async () => {
      started.push("busy");
      await gate.promise;
    }),
  );
  await flush();
  expect(started).toEqual(["busy", "busy"]);

  // More viewport work queues behind it, and a survey waits with nothing running.
  const queuedViewport = limit("viewport", async () => {
    started.push("viewport");
  });
  const queuedBackground = limit("background", async () => {
    started.push("background");
  });
  await flush();
  expect(started).toEqual(["busy", "busy"]);

  gates[0]?.resolve();
  await flush();
  expect(started[2]).toBe("background");

  gates[1]?.resolve();
  await Promise.all([...busy, queuedViewport, queuedBackground]);
});

test("throws for a priority concurrency that is not a positive integer", () => {
  expect(() => createPriorityLimit(0)).toThrow(TypeError);
  expect(() => createPriorityLimit(1.5)).toThrow(TypeError);
});
