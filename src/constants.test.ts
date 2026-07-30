import { expect, expectTypeOf, test } from "vitest";
import {
  DECIMATION_FACTOR,
  FILTER_GAP_RESET_SAMPLES,
  FILTER_MAX_BYTES,
  MAX_INFLIGHT_FETCHES,
  MIN_WAVEFORM_PIXELS,
  RESAMPLE_PIXEL_RATIO,
} from "./constants.js";

test("pins the value of every exported constant", () => {
  expect(DECIMATION_FACTOR).toBe(4);
  expect(FILTER_GAP_RESET_SAMPLES).toBe(100);
  expect(FILTER_MAX_BYTES).toBe(15_000_000);
  expect(MAX_INFLIGHT_FETCHES).toBe(8);
  expect(MIN_WAVEFORM_PIXELS).toBe(10);
  expect(RESAMPLE_PIXEL_RATIO).toBe(3);
});

test("constants are literal-typed, not widened to number", () => {
  expectTypeOf<typeof DECIMATION_FACTOR>().toEqualTypeOf<4>();
  expectTypeOf<typeof MIN_WAVEFORM_PIXELS>().toEqualTypeOf<10>();
});
