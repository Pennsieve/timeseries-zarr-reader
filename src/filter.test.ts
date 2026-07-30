import { expect, test } from "vitest";
import { FILTER_GAP_RESET_SAMPLES } from "./constants.js";
import { makeSegment } from "./test-utils.js";
import { createFilterSession, makeFilter } from "./filter.js";

const RATE_HZ = 1000;
const PERIOD_US = 1000;
const LOWPASS = { type: "lowpass", order: 4, cutoffHz: 50 } as const;

/** One second of a unit-amplitude sine at `freqHz`, sampled at RATE_HZ. */
const sine = (freqHz: number, n = 4000): Float64Array => {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / RATE_HZ);
  }
  return out;
};

/** Peak amplitude over the second half, once the filter has settled. */
const settledAmplitude = (samples: Float64Array): number => {
  let peak = 0;
  for (let i = Math.floor(samples.length / 2); i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i] as number));
  }
  return peak;
};

/** Settled amplitude of a sine at `freqHz` after passing through the given filter. */
const amplitudeAt = (
  freqHz: number,
  spec: Parameters<typeof makeFilter>[0],
): number => settledAmplitude(makeFilter(spec, RATE_HZ).process(sine(freqHz)));

test("lowpass passes frequencies below the cutoff and attenuates those above", () => {
  const spec = { type: "lowpass", order: 4, cutoffHz: 50 } as const;
  expect(amplitudeAt(20, spec)).toBeGreaterThan(0.9);
  expect(amplitudeAt(200, spec)).toBeLessThan(0.05);
});

test("highpass attenuates frequencies below the cutoff and passes those above", () => {
  const spec = { type: "highpass", order: 4, cutoffHz: 50 } as const;
  expect(amplitudeAt(5, spec)).toBeLessThan(0.05);
  expect(amplitudeAt(200, spec)).toBeGreaterThan(0.9);
});

test("bandpass passes the band and attenuates both sides of it", () => {
  const spec = { type: "bandpass", order: 2, lowHz: 20, highHz: 80 } as const;
  expect(amplitudeAt(40, spec)).toBeGreaterThan(0.9);
  expect(amplitudeAt(2, spec)).toBeLessThan(0.05);
  expect(amplitudeAt(400, spec)).toBeLessThan(0.05);
});

test("bandstop attenuates the band and passes both sides of it", () => {
  const spec = { type: "bandstop", order: 4, lowHz: 20, highHz: 80 } as const;
  expect(amplitudeAt(40, spec)).toBeLessThan(0.05);
  expect(amplitudeAt(2, spec)).toBeGreaterThan(0.9);
  expect(amplitudeAt(400, spec)).toBeGreaterThan(0.9);
});

test("returns a new Float64Array and leaves the input untouched", () => {
  const filter = makeFilter(
    { type: "lowpass", order: 4, cutoffHz: 50 },
    RATE_HZ,
  );
  const input = sine(20, 64);
  const copy = Float64Array.from(input);
  const out = filter.process(input);
  expect(out).toBeInstanceOf(Float64Array);
  expect(out).not.toBe(input);
  expect(Array.from(input)).toEqual(Array.from(copy));
});

test("returns an empty result for an empty chunk", () => {
  const filter = makeFilter(
    { type: "lowpass", order: 4, cutoffHz: 50 },
    RATE_HZ,
  );
  expect(filter.process(new Float64Array(0)).length).toBe(0);
});

test("carries state across chunks, matching the same signal filtered whole", () => {
  const spec = { type: "lowpass", order: 4, cutoffHz: 50 } as const;
  const signal = sine(20, 200);
  const whole = makeFilter(spec, RATE_HZ).process(signal);

  const chunked = makeFilter(spec, RATE_HZ);
  const first = chunked.process(signal.slice(0, 80));
  const second = chunked.process(signal.slice(80));

  const joined = [...first, ...second];
  expect(joined.length).toBe(whole.length);
  for (let i = 0; i < whole.length; i++) {
    expect(joined[i]).toBeCloseTo(whole[i] as number, 12);
  }
});

test("reset discards carried state, so the next chunk filters as the first did", () => {
  const spec = { type: "lowpass", order: 4, cutoffHz: 50 } as const;
  const signal = sine(20, 200);
  const fresh = makeFilter(spec, RATE_HZ).process(signal);

  const reused = makeFilter(spec, RATE_HZ);
  reused.process(signal);
  reused.reset();
  const afterReset = reused.process(signal);

  for (let i = 0; i < fresh.length; i++) {
    expect(afterReset[i]).toBeCloseTo(fresh[i] as number, 12);
  }
});

test("rejects an order outside the supported range", () => {
  expect(() =>
    makeFilter({ type: "lowpass", order: 0, cutoffHz: 50 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "lowpass", order: 13, cutoffHz: 50 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "lowpass", order: 2.5, cutoffHz: 50 }, RATE_HZ),
  ).toThrow(RangeError);
});

test("rejects a frequency at or above the Nyquist frequency", () => {
  expect(() =>
    makeFilter({ type: "lowpass", order: 4, cutoffHz: 500 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "highpass", order: 4, cutoffHz: 600 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "lowpass", order: 4, cutoffHz: 0 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "bandpass", order: 2, lowHz: 20, highHz: 500 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "bandstop", order: 2, lowHz: 0, highHz: 80 }, RATE_HZ),
  ).toThrow(RangeError);
});

test("rejects a band whose low edge is not below its high edge", () => {
  expect(() =>
    makeFilter({ type: "bandpass", order: 2, lowHz: 80, highHz: 20 }, RATE_HZ),
  ).toThrow(RangeError);
  expect(() =>
    makeFilter({ type: "bandstop", order: 2, lowHz: 40, highHz: 40 }, RATE_HZ),
  ).toThrow(RangeError);
});

const segment = (
  channel: string,
  startUs: number,
  data: Float64Array,
  samplePeriodUs = PERIOD_US,
) => makeSegment({ channel, startUs, samplePeriodUs, data });

/** A signal split at sample 80, with the second part's contiguous start time. */
const split = (n = 200) => {
  const signal = sine(20, n);
  return {
    signal,
    first: signal.slice(0, 80),
    second: signal.slice(80),
    secondStartUs: 80 * PERIOD_US,
  };
};

const expectSamplesClose = (
  actual: Float64Array,
  expected: Float64Array,
): void => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i] as number, 12);
  }
};

test("filters the segment while carrying over its channel, start and period", () => {
  const session = createFilterSession();
  const out = session.apply(segment("c", 7, sine(20, 64)), LOWPASS, RATE_HZ);
  expect(out.channel).toBe("c");
  expect(out.startUs).toBe(7);
  expect(out.samplePeriodUs).toBe(PERIOD_US);
  expect(out.isMinMax).toBe(false);
  expectSamplesClose(
    out.data,
    makeFilter(LOWPASS, RATE_HZ).process(sine(20, 64)),
  );
});

test("carries state across contiguous segments", () => {
  const { signal, first, second, secondStartUs } = split();
  const whole = makeFilter(LOWPASS, RATE_HZ).process(signal);

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("c", secondStartUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, whole.slice(80));
});

test("carries state across a gap within the reset threshold", () => {
  const { signal, first, second, secondStartUs } = split();
  const whole = makeFilter(LOWPASS, RATE_HZ).process(signal);
  const gapUs = (FILTER_GAP_RESET_SAMPLES - 1) * PERIOD_US;

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("c", secondStartUs + gapUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, whole.slice(80));
});

test("clears state after a gap beyond the reset threshold", () => {
  const { first, second, secondStartUs } = split();
  const gapUs = (FILTER_GAP_RESET_SAMPLES + 1) * PERIOD_US;

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("c", secondStartUs + gapUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, makeFilter(LOWPASS, RATE_HZ).process(second));
});

test("clears state when a segment starts before the previous one ended", () => {
  const { first, second } = split();

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("c", 40 * PERIOD_US, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, makeFilter(LOWPASS, RATE_HZ).process(second));
});

test("holds state separately per channel", () => {
  const { signal, first, second, secondStartUs } = split();
  const whole = makeFilter(LOWPASS, RATE_HZ).process(signal);

  const session = createFilterSession();
  session.apply(segment("a", 0, first), LOWPASS, RATE_HZ);
  session.apply(segment("b", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("a", secondStartUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, whole.slice(80));
});

test("holds state separately per spec", () => {
  const { signal, first, second, secondStartUs } = split();
  const other = { type: "bandpass", order: 2, lowHz: 20, highHz: 80 } as const;
  const whole = makeFilter(LOWPASS, RATE_HZ).process(signal);

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const otherOut = session.apply(segment("c", 0, first), other, RATE_HZ);
  const out = session.apply(
    segment("c", secondStartUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(otherOut.data, makeFilter(other, RATE_HZ).process(first));
  expectSamplesClose(out.data, whole.slice(80));
});

test("holds state separately per rate", () => {
  const { first, second, secondStartUs } = split();

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const out = session.apply(
    segment("c", secondStartUs, second, 2000),
    LOWPASS,
    500,
  );

  expectSamplesClose(out.data, makeFilter(LOWPASS, 500).process(second));
});

test("clear drops held state, so the next segment filters from nothing", () => {
  const { first, second, secondStartUs } = split();

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  session.clear();
  const out = session.apply(
    segment("c", secondStartUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expectSamplesClose(out.data, makeFilter(LOWPASS, RATE_HZ).process(second));
});

test("passes an empty segment through without disturbing the state", () => {
  const { signal, first, second, secondStartUs } = split();
  const whole = makeFilter(LOWPASS, RATE_HZ).process(signal);

  const session = createFilterSession();
  session.apply(segment("c", 0, first), LOWPASS, RATE_HZ);
  const empty = session.apply(
    segment("c", secondStartUs, new Float64Array(0)),
    LOWPASS,
    RATE_HZ,
  );
  const out = session.apply(
    segment("c", secondStartUs, second),
    LOWPASS,
    RATE_HZ,
  );

  expect(empty.data.length).toBe(0);
  expectSamplesClose(out.data, whole.slice(80));
});

test("rejects a min/max segment", () => {
  const session = createFilterSession();
  const envelope = makeSegment({
    isMinMax: true,
    data: new Float64Array([1, 2, 3, 4]),
  });
  expect(() => session.apply(envelope, LOWPASS, RATE_HZ)).toThrow(RangeError);
});
