import { describe, it, expect } from "vitest";
import { ntpSlice, median, trimmedMean, stdev, summarizeRtts, type NtpSample } from "../src/core/estimator.js";

/**
 * Simulate a full 4-timestamp handshake through a fake network.
 *
 * Clock domains: the client clock runs at `clientClock = serverClock - offset`,
 * transit dOut (client -> server), dIn (server -> client), server dwell proc.
 */
function simulateHandshake(opts: {
  /** true offset theta = serverClock - clientClock */
  offset: number;
  /** one-way transit client -> server */
  dOut: number;
  /** one-way transit server -> client */
  dIn: number;
  /** server processing dwell */
  proc: number;
  /** client clock reading when the request is sent */
  now: number;
}): NtpSample {
  const t0 = opts.now;
  const t1 = t0 + opts.offset + opts.dOut; // server clock at receive
  const t2 = t1 + opts.proc; // server clock at reply
  const t3 = t0 + opts.dOut + opts.proc + opts.dIn; // client clock at reply receive
  return { t0, t1, t2, t3 };
}

describe("ntpSlice (4-timestamp estimator)", () => {
  it("recovers the exact offset and full transit RTT on a symmetric link", () => {
    const sample = simulateHandshake({ offset: 1234.5, dOut: 42, dIn: 42, proc: 0.9, now: 5000 });
    const est = ntpSlice(sample);
    expect(est.offset).toBeCloseTo(1234.5, 6);
    expect(est.rtt).toBeCloseTo(84, 6);
    expect(est.serverProc).toBeCloseTo(0.9, 6);
  });

  it("is biased by exactly half the transit asymmetry (documented limitation)", () => {
    const sample = simulateHandshake({ offset: 0, dOut: 80, dIn: 20, proc: 0, now: 0 });
    const est = ntpSlice(sample);
    expect(est.offset).toBeCloseTo(30, 6); // (80 - 20) / 2
    expect(est.rtt).toBeCloseTo(100, 6); // RTT itself is unaffected by asymmetry
  });

  it("excludes the server processing dwell from the RTT", () => {
    const sample = simulateHandshake({ offset: 10, dOut: 50, dIn: 50, proc: 25, now: 100 });
    const est = ntpSlice(sample);
    expect(est.rtt).toBeCloseTo(100, 6);
    expect(est.serverProc).toBeCloseTo(25, 6);
  });

  it("is insensitive to the pitch point the journey starts at", () => {
    const early = simulateHandshake({ offset: -700, dOut: 30, dIn: 45, proc: 2, now: 0 });
    const late = simulateHandshake({ offset: -700, dOut: 30, dIn: 45, proc: 2, now: 1e6 });
    expect(ntpSlice(late).offset).toBeCloseTo(ntpSlice(early).offset, 6);
  });
});

describe("robust aggregators", () => {
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(() => median([])).toThrow();
  });

  it("trimmedMean drops high-rank outliers on both ends", () => {
    expect(trimmedMean([1, 2, 3, 4, 1000], 0.2)).toBe(3);
    expect(trimmedMean([10, 20], 0.2)).toBe(15); // tiny arrays lose nothing
    expect(() => trimmedMean([])).toThrow();
  });

  it("stdev separates steady from jittery windows", () => {
    expect(stdev([10, 10, 10])).toBeCloseTo(0, 9);
    expect(stdev([10, 20, 30, 40])).toBeGreaterThan(10);
    expect(stdev([5])).toBe(0);
  });
});

describe("summarizeRtts", () => {
  it("takes the median and halves it for one-way", () => {
    const summary = summarizeRtts([20, 22, 24, 200, 21]);
    expect(summary.rtt).toBe(22);
    expect(summary.oneway).toBe(11);
    expect(summary.samples).toBe(5);
  });

  it("surfaces outlier pollution as jitter", () => {
    const summary = summarizeRtts([20, 22, 24, 200, 21]);
    expect(summary.jitter).toBeGreaterThan(70);

    const calm = summarizeRtts([20, 21, 22, 21, 20]);
    expect(calm.jitter).toBeLessThan(1);
  });

  it("handles a single sample", () => {
    const summary = summarizeRtts([40]);
    expect(summary.rtt).toBe(40);
    expect(summary.oneway).toBe(20);
    expect(summary.jitter).toBe(0);
  });
});
