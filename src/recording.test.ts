import { expect, test } from "vitest";
import { parseRfc3339Us, readRecording } from "./recording.js";
import { createMemoryStore } from "./test-utils.js";

test("parses an RFC 3339 timestamp to microseconds, keeping the microsecond", () => {
  expect(parseRfc3339Us("1970-01-01T00:00:00Z")).toBe(0);
  expect(parseRfc3339Us("1970-01-01T00:00:01.000001Z")).toBe(1_000_001);
  expect(parseRfc3339Us("2023-11-14T22:13:20.000000+00:00")).toBe(
    1_700_000_000_000_000,
  );
  // A UTC offset shifts the instant.
  expect(parseRfc3339Us("2024-03-14T09:15:00.250000-05:00")).toBe(
    Date.UTC(2024, 2, 14, 14, 15, 0) * 1000 + 250_000,
  );
});

test("accepts the lowercase and space forms RFC 3339 allows", () => {
  expect(parseRfc3339Us("1970-01-01t00:00:00z")).toBe(0);
  expect(parseRfc3339Us("1970-01-01 00:00:00Z")).toBe(0);
});

test("truncates a fraction beyond six digits and pads a short one", () => {
  expect(parseRfc3339Us("1970-01-01T00:00:00.1234567Z")).toBe(123_456);
  expect(parseRfc3339Us("1970-01-01T00:00:00.5Z")).toBe(500_000);
});

test("rejects a timestamp with no offset, a date alone, or garbage", () => {
  for (const text of [
    "2024-03-14T09:15:00",
    "2024-03-14",
    "yesterday",
    "2024-13-45T09:15:00Z",
    "",
  ]) {
    expect(() => parseRfc3339Us(text)).toThrow(RangeError);
  }
});

test("resolves undefined when the bundle has no recording.json", async () => {
  await expect(readRecording(createMemoryStore({}))).resolves.toBeUndefined();
});

test("reads start and the identity objects", async () => {
  const store = createMemoryStore({
    "/recording.json": JSON.stringify({
      start: "2023-11-14T22:13:20.000000+00:00",
      subject: { id: "sub-01" },
      session: { id: "ses-01" },
      source: { system: "synthetic" },
    }),
  });
  await expect(readRecording(store)).resolves.toEqual({
    start: "2023-11-14T22:13:20.000000+00:00",
    startUs: 1_700_000_000_000_000,
    subject: { id: "sub-01" },
    session: { id: "ses-01" },
    source: { system: "synthetic" },
  });
});

test("accepts reference_time as the name of the origin", async () => {
  // What timeseries-zarr-py writes for the same instant.
  const store = createMemoryStore({
    "/recording.json": JSON.stringify({
      reference_time: "1970-01-01T00:00:02Z",
      session: { start_time: "1970-01-01T00:00:02Z" },
    }),
  });
  await expect(readRecording(store)).resolves.toEqual({
    start: "1970-01-01T00:00:02Z",
    startUs: 2_000_000,
    session: { start_time: "1970-01-01T00:00:02Z" },
  });
});

test("reads a de-identified file with no start as an empty record", async () => {
  const store = createMemoryStore({ "/recording.json": "{}" });
  await expect(readRecording(store)).resolves.toEqual({});
});

test("rejects a file that is not a JSON object, a bad start, or a non-object field", async () => {
  await expect(
    readRecording(createMemoryStore({ "/recording.json": "{nope" })),
  ).rejects.toThrow(/not valid JSON/);
  await expect(
    readRecording(createMemoryStore({ "/recording.json": "[]" })),
  ).rejects.toThrow(/object/);
  await expect(
    readRecording(createMemoryStore({ "/recording.json": '{"start": 5}' })),
  ).rejects.toThrow(/start must be a string/);
  await expect(
    readRecording(
      createMemoryStore({ "/recording.json": '{"start": "noon"}' }),
    ),
  ).rejects.toThrow(RangeError);
  await expect(
    readRecording(
      createMemoryStore({ "/recording.json": '{"subject": "me"}' }),
    ),
  ).rejects.toThrow(/subject must be an object/);
});
