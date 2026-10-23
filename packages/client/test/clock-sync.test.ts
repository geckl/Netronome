import { describe, it, expect, vi } from "vitest";
import { ClockSync, type ClockEstimate } from "../src/clock-sync.js";

/** Hand-advanced monotonic clock for tests. */
class FakeClock {
  private tick = 0;
  now = (): number => this.tick;
  advance(ms: number): void {
    this.tick += ms;
  }
}

type LinkShape = {
  /** true offset theta = serverClock - clientClock */
  offset?: number;
  /** one-way transit client -> server */
  dOut?: number;
  /** one-way transit server -> client */
  dIn?: number;
  /** server processing dwell */
  dwell?: number;
  bootId?: string;
  /** HTTP failure injection */
  status?: number;
  /** return a malformed body */
  malformed?: boolean;
};

/**
 * Fake `GET /api/sync` over a fake network: the request is stamped on arrival
 * exactly like the real server does (t1 already contains the offset!), and
 * the transit until the reply lands advances the client clock so the
 * syncOnce t0/t3 bracket contains everything.
 */
function mkFetch(clock: FakeClock, link: LinkShape = {}) {
  const fn = vi.fn(async (url: string) => {
    const t0 = clock.now();
    if (link.status) {
      return { ok: false, status: link.status, json: async () => ({}), url } as unknown as Response;
    }
    const theta = link.offset ?? 100;
    const dOut = link.dOut ?? 15;
    const dIn = link.dIn ?? 15;
    const dwell = link.dwell ?? 2;
    const t1 = t0 + dOut + theta; // server-clock stamp at receive
    const t2 = t1 + dwell; // server-clock stamp at reply
    clock.advance(dOut + dwell + dIn); // reply lands after dwell + transit back
    const body = link.malformed ? { nope: true } : { t1, t2, bootId: link.bootId ?? "boot-A" };
    return { ok: true, status: 200, url, json: async () => body } as unknown as Response;
  });
  return fn as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

describe("ClockSync (HTTP NTP against /api/sync)", () => {
  it("recovers the exact server offset on a symmetric link", async () => {
    const clock = new FakeClock();
    const clockSync = new ClockSync({ fetch: mkFetch(clock, { offset: 1234.5 }), now: clock.now });
    const estimate = await clockSync.syncOnce();
    expect(estimate.offset).toBeCloseTo(1234.5, 6);
    expect(estimate.rtt).toBeCloseTo(30, 6); // dOut + dIn, dwell removed
    expect(estimate.bootId).toBe("boot-A");
    expect(clockSync.serverNow()).toBeCloseTo(clock.now() + 1234.5, 6);
    expect(clockSync.synced).toBe(true);
  });

  it("prefers the lowest-RTT sample in the window for the offset", async () => {
    const clock = new FakeClock();
    const link: LinkShape & { offset: number; dOut: number; dIn: number } = { offset: 100, dOut: 60, dIn: 20 };
    const clockSync = new ClockSync({ fetch: mkFetch(clock, link), now: clock.now, windowSize: 8 });
    // A noisy, asymmetric, slow probe first: bias = (60 - 20) / 2 = +20.
    await clockSync.syncOnce();
    expect(clockSync.estimate()!.offset).toBeCloseTo(120, 6);
    // A clean symmetric probe now — its (much lower) RTT should win the window.
    link.dOut = 5;
    link.dIn = 5;
    await clockSync.syncOnce();
    expect(clockSync.estimate()!.offset).toBeCloseTo(100, 6);
  });

  it("rolls the statistics window", async () => {
    const clock = new FakeClock();
    const fetchFn = mkFetch(clock, { dOut: 10, dIn: 10 });
    const clockSync = new ClockSync({ fetch: fetchFn, now: clock.now, windowSize: 3 });
    for (let i = 0; i < 5; i++) {
      await clockSync.syncOnce();
      clock.advance(1000);
    }
    const estimate = clockSync.estimate()!;
    expect(estimate.samples).toBe(3); // window capped
    expect(fetchFn.mock.calls.length).toBe(5);
  });

  it("reports bootId changes (server restart) exactly once each", async () => {
    const clock = new FakeClock();
    const boots: string[] = ["boot-A", "boot-A", "boot-B"];
    let call = 0;
    const fetchFn = vi.fn(async () => {
      const body = { t1: clock.now() + 12, t2: clock.now() + 14, bootId: boots[Math.min(call, boots.length - 1)] };
      call += 1;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    });
    const onBootChange = vi.fn();
    const clockSync = new ClockSync({ fetch: fetchFn as unknown as typeof fetch, now: clock.now, onBootChange });
    await clockSync.syncOnce();
    await clockSync.syncOnce();
    await clockSync.syncOnce();
    expect(onBootChange).toHaveBeenCalledTimes(1);
    expect(onBootChange).toHaveBeenCalledWith("boot-B");
    expect(clockSync.estimate()!.bootId).toBe("boot-B");
  });

  it("emits onUpdate after each probe", async () => {
    const clock = new FakeClock();
    const updates: ClockEstimate[] = [];
    const clockSync = new ClockSync({
      fetch: mkFetch(clock),
      now: clock.now,
      onUpdate: (estimate) => updates.push(estimate),
    });
    await clockSync.syncOnce();
    expect(updates.length).toBe(1);
    expect(updates[0]!.offset).toBeCloseTo(100, 6);
  });

  it("surfaces HTTP and payload failures as thrown errors", async () => {
    const clock = new FakeClock();
    const failing = new ClockSync({ fetch: mkFetch(clock, { status: 503 }), now: clock.now });
    await expect(failing.syncOnce()).rejects.toThrow("503");
    const garbage = new ClockSync({ fetch: mkFetch(clock, { malformed: true }), now: clock.now });
    await expect(garbage.syncOnce()).rejects.toThrow("malformed");
  });
});

describe("ClockSync — drift regression (Phase 5)", () => {
  /**
   * A server whose clock drifts ADDITIVELY against the client:
   * theta(t) = base + rate * t (rate in ms/ms; 0.0002 == 200 ppm). The stamps
   * are still shaped exactly like real replies (t1 contains the offset).
   */
  function mkDriftFetch(
    clock: FakeClock,
    opts: { base: number; rate: number; dOut?: number; dIn?: number },
  ) {
    return async (url: string) => {
      const t0 = clock.now();
      const dOut = opts.dOut ?? 4;
      const dIn = opts.dIn ?? 4;
      const dwell = 2;
      const theta = opts.base + opts.rate * t0;
      const t1 = t0 + dOut + theta;
      const t2 = t1 + dwell;
      clock.advance(dOut + dwell + dIn);
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({ t1, t2, bootId: "boot-A" }),
      } as unknown as Response;
    };
  }

  it("extrapolates the fitted drift so serverNow() stops drifting", async () => {
    const clock = new FakeClock();
    // 200 ppm across a 30s extrapolation = 6ms without the model.
    const rate = 0.0002;
    const clockSync = new ClockSync({
      fetch: mkDriftFetch(clock, { base: 100, rate }) as unknown as typeof fetch,
      now: clock.now,
      windowSize: 16,
    });
    for (let i = 0; i < 8; i++) {
      await clockSync.syncOnce();
      clock.advance(5_000); // 35s window spread >= the 20s gate
    }
    expect(clockSync.estimate()!.driftRate).toBeCloseTo(rate, 7);

    const before = clock.now();
    clock.advance(30_000);
    const expected = clock.now() + 100 + rate * clock.now(); // true server reading
    const actual = clockSync.serverNow()!;
    expect(actual).toBeCloseTo(expected, 0); // < ~0.5ms thanks to the exact fit
    expect(Math.abs(actual - expected)).toBeLessThan(2);
    expect(before).toBeLessThan(clock.now());
  });

  it("clamps absurd drift rates to a sane band", async () => {
    const clock = new FakeClock();
    const clockSync = new ClockSync({
      fetch: mkDriftFetch(clock, { base: 100, rate: 0.01 }) as unknown as typeof fetch, // 10,000 ppm
      now: clock.now,
      windowSize: 16,
    });
    for (let i = 0; i < 8; i++) {
      await clockSync.syncOnce();
      clock.advance(5_000);
    }
    expect(clockSync.estimate()!.driftRate).toBeCloseTo(0.00025, 8); // 250 ppm cap
  });

  it("keeps driftRate 0 until the window has enough samples and spread", async () => {
    const clock = new FakeClock();
    const clockSync = new ClockSync({
      fetch: mkDriftFetch(clock, { base: 100, rate: 0.0002 }) as unknown as typeof fetch,
      now: clock.now,
      windowSize: 16,
    });
    await clockSync.syncOnce();
    await clockSync.syncOnce();
    await clockSync.syncOnce();
    clock.advance(30_000);
    await clockSync.syncOnce();
    expect(clockSync.estimate()!.driftRate).toBe(0); // only 4 samples (gate: 6)
  });

  it("drops the drift model and history when the server restarts", async () => {
    const clock = new FakeClock();
    let boots = 0;
    const fetchFn = async (url: string) => {
      const t0 = clock.now();
      const theta = 100 + 0.0002 * t0;
      const t1 = t0 + 4 + theta;
      const t2 = t1 + 2;
      clock.advance(10);
      boots += 1;
      return {
        ok: true,
        status: 200,
        url,
        json: async () => ({ t1, t2, bootId: boots < 8 ? "boot-A" : "boot-B" }),
      } as unknown as Response;
    };
    const clockSync = new ClockSync({ fetch: fetchFn as unknown as typeof fetch, now: clock.now, windowSize: 16 });
    for (let i = 0; i < 7; i++) {
      await clockSync.syncOnce();
      clock.advance(5_000);
    }
    expect(clockSync.estimate()!.driftRate).toBeCloseTo(0.0002, 7);
    await clockSync.syncOnce(); // 8th probe reports boot-B
    expect(clockSync.estimate()!.bootId).toBe("boot-B");
    expect(clockSync.estimate()!.driftRate).toBe(0); // history cleared
    expect(clockSync.estimate()!.samples).toBe(1);
  });
});
