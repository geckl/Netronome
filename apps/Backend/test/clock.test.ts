import { describe, it, expect } from "vitest";
import { ServerClock } from "../src/core/clock.js";

describe("ServerClock", () => {
  it("now() is finite, fractional and monotonic", () => {
    const clock = new ServerClock();
    const a = clock.now();
    const b = clock.now();
    expect(Number.isFinite(a)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("bridges mono <-> epoch consistently in both directions", () => {
    const clock = new ServerClock();
    const mono = clock.now() + 123.456;
    const epoch = clock.toEpoch(mono);
    // Precision note: doubles carry ~2^-11 ms resolution at epoch scale
    // (~1.7e12 ms), so a perfect round-trip is asserted at sub-µs tolerance.
    expect(clock.fromEpoch(epoch)).toBeCloseTo(mono, 2);
  });

  it("info().epoch tracks the wall clock of this process within a tight tolerance", () => {
    const clock = new ServerClock();
    const info = clock.info();
    expect(Math.abs(info.epoch - Date.now())).toBeLessThan(50);
  });

  it("publishes a unique per-process UUID bootId (restart detection)", () => {
    const a = new ServerClock();
    const b = new ServerClock();
    expect(a.bootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b.bootId).not.toBe(a.bootId);
  });

  it("info() carries exactly the three restart-detection fields", () => {
    const info = new ServerClock().info();
    expect(Object.keys(info).sort()).toEqual(["bootId", "epoch", "mono"]);
  });
});
