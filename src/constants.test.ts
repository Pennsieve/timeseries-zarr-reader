import { expect, expectTypeOf, test } from "vitest";
import {
  DECIMATION_FACTOR,
  FILTER_MAX_BYTES,
  MAX_INFLIGHT_FETCHES,
  SEND_SPIKE_THRESHOLD,
} from "./constants";

test("constants have their documented values", () => {
  expect(DECIMATION_FACTOR).toBe(4);
  expect(FILTER_MAX_BYTES).toBe(15_000_000);
  expect(MAX_INFLIGHT_FETCHES).toBe(8);
  expect(SEND_SPIKE_THRESHOLD).toBe(10);
});

test("constants are literal-typed, not widened to number", () => {
  expectTypeOf<typeof DECIMATION_FACTOR>().toEqualTypeOf<4>();
  expectTypeOf<typeof SEND_SPIKE_THRESHOLD>().toEqualTypeOf<10>();
});
