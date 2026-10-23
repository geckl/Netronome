import { describe, it, expect } from "vitest";
import { CtxRateCalibrator, fitCtxRate } from "../src/audio-rate.js";
import { NetronomeClient } from "../src/netronome-client.js";
import { ClockSync } from "../src/clock-sync.js";

describe("fitCtxRate", () => {
  it("returns rate 1 for too-few or too-close samples", () => {
    expect(fitCtxRate([])).toMatchObject({ rate: 1, samples: 0 });
    const one = fitCtxRate([{ perfMs: 0, ctxSec: 10 }]);
    expect(one.rate).toBe(1);
    const tight = fitCtxRate([
      { perfMs: 0, ctxSec: 10 },
      { perfMs: 100, ctxSec: 10.1 },
    ]); // 0.1s spread < 2s default gate
    expect(tight.rate).toBe(1);
    expect(tight.samples).toBe(2);
  });

  it("recovers a slow virtual ctx clock (Theil-Sen over duplicates)", () => {
    // ctx runs 100 ppm slow vs the monotonic clock.
    const samples = [];
    for (let i = 0; i <= 5; i++) {
      samples.push({ perfMs: i * 1000, ctxSec: 10 + (i * 1000) / 1000 * 0.9999 });
    }
    const fit = fitCtxRate(samples);
    expect(fit.rate).toBeCloseTo(0.9999, 9);
    expect(fit.spreadSec).toBeCloseTo(5, 6);
  });

  it("recovers a fast virtual ctx clock and clamps absurd rates", () => {
    const fast = fitCtxRate([
      { perfMs: 0, ctxSec: 10 },
      { perfMs: 4000, ctxSec: 14.004 },
    ]);
    expect(fast.rate).toBeCloseTo(1.001, 9);
    const absurd = fitCtxRate(
      [
        { perfMs: 0, ctxSec: 10 },
        { perfMs: 4000, ctxSec: 14.4 }, // 10% fast — noise or corruption
      ],
      { maxDeviation: 0.02 },
    );
    expect(absurd.rate).toBeCloseTo(1.02, 9);
  });
});

describe("CtxRateCalibrator", () => {
  it("ignores duplicate instants and keeps the spread anchor", () => {
    const cal = new CtxRateCalibrator();
    cal.observe(10, 0);
    const dup = cal.observe(10, 0); // same instant — ignored
    expect(dup.samples).toBe(1);
    cal.observe(10.05, 100);
    // Roll far past the 16-sample budget: the 0ms anchor must survive.
    for (let i = 1; i <= 40; i++) cal.observe(10 + i * 0.5, 100 + i * 500);
    const fit = cal.fit();
    expect(fit.samples).toBe(16);
    expect(fit.spreadSec).toBeCloseTo(20.1, 5); // from 0ms to 20.1s (anchor kept)
  });
});

describe("NetronomeClient — ctx-rate calibrated localAudioTime (Phase 5)", () => {
  class HandCtx {
    sec = 3.0;
    get currentTime(): number {
      return this.sec;
    }
  }

  /** Hand-advanced monotonic clock for tests (mirrors the other suites). */
  class FakeClock {
    private tick = 0;
    now = (): number => this.tick;
    advance(ms: number): void {
      this.tick += ms;
    }
  }

  function mkSyncFetch(clock: FakeClock, offset: number) {
    return async (url: string) => {
      const t0 = clock.now();
      const t1 = t0 + 5 + offset;
      const t2 = t1 + 2;
      clock.advance(12);
      return { ok: true, status: 200, url, json: async () => ({ t1, t2, bootId: "boot-A" }) } as unknown as Response;
    };
  }

  it("scales long deltas by the calibrated ctx rate", async () => {
    const clock = new FakeClock();
    const ctx = new HandCtx();
    const client = new NetronomeClient({
      role: "performer",
      socketFactory: () =>
        ({
          on: () => ({}),
          off: () => ({}),
          once: () => ({}),
          emit: () => ({}),
          connect: () => ({}),
          disconnect: () => ({}),
        }) as never,
      clockFactory: () => new ClockSync({ now: clock.now, fetch: mkSyncFetch(clock, 50) as unknown as typeof fetch }),
      now: clock.now,
    });
    await client.clock.syncOnce();
    expect(client.synced).toBe(true);

    // Warm the calibrator with a ctx clock running 200 ppm SLOW (0.06s lost
    // per 5 minutes of wall time on this fake hardware).
    for (let i = 1; i <= 6; i++) {
      clock.advance(1000);
      ctx.sec += 0.9998;
      client.localAudioTime(client.serverNow()!, ctx as unknown as BaseAudioContext);
    }
    expect(client.audioCalibration().rate).toBeCloseTo(0.9998, 8);

    // A deadline 2000 real-ms ahead must land 2000 * 0.9998 ctx-ms ahead.
    const due = client.localAudioTime(client.serverNow()! + 2000, ctx as unknown as BaseAudioContext);
    expect(due - ctx.currentTime).toBeCloseTo(1.9996, 4);
    client.disconnect();
  });

  it("stays uncalibrated (rate 1) when the clock never advances", async () => {
    const clock = new FakeClock();
    const ctx = new HandCtx();
    const client = new NetronomeClient({
      role: "performer",
      socketFactory: () =>
        ({ on: () => ({}), off: () => ({}), once: () => ({}), emit: () => ({}), connect: () => ({}), disconnect: () => ({}), }) as never,
      clockFactory: () => new ClockSync({ now: clock.now, fetch: mkSyncFetch(clock, 50) as unknown as typeof fetch }),
      now: clock.now,
    });
    await client.clock.syncOnce();
    for (let i = 0; i < 5; i++) {
      client.localAudioTime(client.serverNow()!, ctx as unknown as BaseAudioContext);
    }
    expect(client.audioCalibration().rate).toBe(1);
    expect(client.localAudioTime(client.serverNow()! + 350, ctx as unknown as BaseAudioContext)).toBeCloseTo(
      ctx.currentTime + 0.35,
      6,
    );
    client.disconnect();
  });
});
