import { expect, expectTypeOf, test } from "vitest";
import {
  FILTER_GAP_RESET_SAMPLES,
  MAX_CACHE_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_INFLIGHT_FETCHES,
  MAX_RAW_BYTES,
  MIN_WAVEFORM_PIXELS,
  RESAMPLE_PIXEL_RATIO,
} from "./constants.js";

test("pins the value of every exported constant", () => {
  expect(FILTER_GAP_RESET_SAMPLES).toBe(100);
  expect(MAX_CACHE_BYTES).toBe(67_108_864);
  expect(MAX_CONCURRENT_REQUESTS).toBe(64);
  expect(MAX_INFLIGHT_FETCHES).toBe(64);
  expect(MAX_RAW_BYTES).toBe(15_000_000);
  expect(MIN_WAVEFORM_PIXELS).toBe(10);
  expect(RESAMPLE_PIXEL_RATIO).toBe(3);
});

test("constants are literal-typed, not widened to number", () => {
  expectTypeOf<typeof MAX_INFLIGHT_FETCHES>().toEqualTypeOf<64>();
  expectTypeOf<typeof MIN_WAVEFORM_PIXELS>().toEqualTypeOf<10>();
});
