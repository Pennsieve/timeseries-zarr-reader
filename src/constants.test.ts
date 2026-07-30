import { expect, expectTypeOf, test } from "vitest";
import {
  DECIMATION_FACTOR,
  FILTER_GAP_RESET_SAMPLES,
  FILTER_MAX_BYTES,
  MAX_INFLIGHT_FETCHES,
  RESAMPLE_PIXEL_RATIO,
  SEND_SPIKE_THRESHOLD,
} from "./constants.js";

test("constants have their documented values", () => {
  expect(DECIMATION_FACTOR).toBe(4);
  expect(FILTER_GAP_RESET_SAMPLES).toBe(100);
  expect(FILTER_MAX_BYTES).toBe(15_000_000);
  expect(MAX_INFLIGHT_FETCHES).toBe(8);
  expect(RESAMPLE_PIXEL_RATIO).toBe(3);
  expect(SEND_SPIKE_THRESHOLD).toBe(10);
});

test("constants are literal-typed, not widened to number", () => {
  expectTypeOf<typeof DECIMATION_FACTOR>().toEqualTypeOf<4>();
  expectTypeOf<typeof SEND_SPIKE_THRESHOLD>().toEqualTypeOf<10>();
});
