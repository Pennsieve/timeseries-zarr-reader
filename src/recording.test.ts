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

test("reads reference_time and the identity objects", async () => {
  const store = createMemoryStore({
    "/recording.json": JSON.stringify({
      reference_time: "2023-11-14T22:13:20.000000+00:00",
      subject: { id: "sub-01" },
      session: { id: "ses-01" },
      source: { system: "synthetic" },
    }),
  });
  await expect(readRecording(store)).resolves.toEqual({
    referenceTime: "2023-11-14T22:13:20.000000+00:00",
    referenceTimeUs: 1_700_000_000_000_000,
    subject: { id: "sub-01" },
    session: { id: "ses-01" },
    source: { system: "synthetic" },
  });
});

test("keeps session.start_time inside session, where it places no data", async () => {
  const store = createMemoryStore({
    "/recording.json": JSON.stringify({
      reference_time: "1970-01-01T00:00:02Z",
      session: { start_time: "1970-01-01T00:00:01Z" },
    }),
  });
  await expect(readRecording(store)).resolves.toEqual({
    referenceTime: "1970-01-01T00:00:02Z",
    referenceTimeUs: 2_000_000,
    session: { start_time: "1970-01-01T00:00:01Z" },
  });
});

test("ignores keys the format does not define, including the pre-1.0 start", async () => {
  const store = createMemoryStore({
    "/recording.json": JSON.stringify({
      start: "1970-01-01T00:00:02Z",
      device: { model: "x" },
    }),
  });
  await expect(readRecording(store)).resolves.toEqual({});
});

test("reads a de-identified file with no reference_time as an empty record", async () => {
  const store = createMemoryStore({ "/recording.json": "{}" });
  await expect(readRecording(store)).resolves.toEqual({});
});

test("rejects a file that is not a JSON object, a bad reference_time, or a non-object field", async () => {
  await expect(
    readRecording(createMemoryStore({ "/recording.json": "{nope" })),
  ).rejects.toThrow(/not valid JSON/);
  await expect(
    readRecording(createMemoryStore({ "/recording.json": "[]" })),
  ).rejects.toThrow(/object/);
  await expect(
    readRecording(
      createMemoryStore({ "/recording.json": '{"reference_time": 5}' }),
    ),
  ).rejects.toThrow(/reference_time must be a string/);
  await expect(
    readRecording(
      createMemoryStore({ "/recording.json": '{"reference_time": "noon"}' }),
    ),
  ).rejects.toThrow(RangeError);
  await expect(
    readRecording(
      createMemoryStore({ "/recording.json": '{"subject": "me"}' }),
    ),
  ).rejects.toThrow(/subject must be an object/);
});
