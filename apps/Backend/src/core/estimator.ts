/**
 * Pure clock-estimation math for the sync engine.
 *
 * Deliberately dependency-free and side-effect-free so it can be unit-tested
 * under synthetic symmetric/asymmetric latency, and so the exact same formulas
 * can later be shared with the client SDK (packages/client, Phase 3).
 */

export type NtpSample = {
  /** Client clock timestamp: request sent. */
  t0: number;
  /** Server clock timestamp: request received. */
  t1: number;
  /** Server clock timestamp: reply sent. */
  t2: number;
  /** Client clock timestamp: reply received. */
  t3: number;
};

export type NtpSlice = {
  /** offset theta = serverClock - clientClock at the exchange midpoint. */
  offset: number;
  /** Network round-trip time, minus the server-side processing dwell. */
  rtt: number;
  /** Time the server spent handling the request (t2 - t1) — measured, not assumed. */
  serverProc: number;
};

/**
 * Classic NTP offset from one 4-timestamp handshake:
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *   rtt    = (t3 - t0) - (t2 - t1)
 *
 * Bias note: with one-way transits `dOut` (client -> server) and `dIn`
 * (server -> client) and true offset theta, the result is
 *   theta + (dOut - dIn) / 2
 * i.e. exactly unbiased on symmetric links, and biased by half the measured
 * asymmetry otherwise (documented limitation until per-direction probing exists).
 */
export function ntpSlice(sample: NtpSample): NtpSlice {
  const serverProc = sample.t2 - sample.t1;
  const rtt = sample.t3 - sample.t0 - serverProc;
  const offset = (sample.t1 - sample.t0 + sample.t2 - sample.t3) / 2;
  return { offset, rtt, serverProc };
}

/** Median. Throws on an empty array. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Mean after dropping `trim` (0..0.5) of the sorted points from each rank end.
 * Robust against single-probe pollution (a GC pause, a wifi hiccup...).
 */
export function trimmedMean(values: number[], trim = 0.2): number {
  if (values.length === 0) throw new Error("trimmedMean of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.min(Math.floor(sorted.length * trim), Math.floor((sorted.length - 1) / 2));
  const kept = sorted.slice(cut, sorted.length - cut);
  if (kept.length === 0) return median(sorted);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** Sample standard deviation. 0 for fewer than two samples. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export type RttSummary = {
  /** Median RTT in ms. */
  rtt: number;
  /** RTT / 2 — the best symmetric-link estimate of one-way latency. */
  oneway: number;
  /** Sample stddev across the window (jitter indicator). */
  jitter: number;
  /** Number of samples in the window. */
  samples: number;
};

/** Summarize a rolling window of RTT samples (ms). */
export function summarizeRtts(rtts: number[]): RttSummary {
  const rtt = median(rtts);
  return {
    rtt,
    oneway: rtt / 2,
    jitter: stdev(rtts),
    samples: rtts.length,
  };
}
