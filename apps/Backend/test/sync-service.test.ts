import { describe, it, expect } from "vitest";
import { ServerClock } from "../src/core/clock.js";
import { SyncService } from "../src/core/sync-service.js";

const makeSync = () => new SyncService(new ServerClock(), false, 64);

describe("SyncService", () => {
  it("reports no estimate before any RTT is recorded", () => {
    const sync = makeSync();
    sync.register("sock-1");
    expect(sync.estimate("sock-1")).toBeNull();
  });

  it("medians RTT samples and derives one-way as half", () => {
    const sync = makeSync();
    sync.register("sock-1");
    sync.recordRtt("sock-1", 20);
    sync.recordRtt("sock-1", 24);
    sync.recordRtt("sock-1", 22);
    const estimate = sync.estimate("sock-1")!;
    expect(estimate.rtt).toBe(22);
    expect(estimate.oneway).toBe(11);
    expect(estimate.samples).toBe(3);
    expect(estimate.lastRttAt).not.toBeNull();
  });

  it("rolls the window at the cap, keeping the most recent samples", () => {
    const sync = new SyncService(new ServerClock(), false, 3);
    sync.register("sock-1");
    [100, 101, 102, 103, 200].forEach((v) => sync.recordRtt("sock-1", v));
    const estimate = sync.estimate("sock-1")!;
    expect(estimate.samples).toBe(3);
    expect(estimate.rtt).toBe(103); // window holds [102, 103, 200] → median 103
  });

  it("records probes as observations only (no offset knowledge server-side)", () => {
    const sync = makeSync();
    sync.register("sock-2");
    sync.recordProbe("sock-2", 9000.5); // client-clock t0 — uninterpretable on the server
    expect(sync.estimate("sock-2")).toBeNull();
  });

  it("estimates are per-connection, never shared", () => {
    const sync = makeSync();
    sync.register("a");
    sync.register("b");
    sync.recordRtt("a", 30);
    sync.recordRtt("b", 300);
    expect(sync.estimate("a")!.oneway).toBe(15);
    expect(sync.estimate("b")!.oneway).toBe(150);
  });

  it("unregister clears stats and ids reflect active connections", () => {
    const sync = makeSync();
    sync.register("a");
    sync.register("b");
    sync.recordRtt("b", 12);
    expect(sort(sync.ids())).toEqual(["a", "b"]);
    sync.unregister("b");
    expect(sync.estimate("b")).toBeNull();
    expect(sync.ids()).toEqual(["a"]);
  });

  it("snapshot lists one entry per connection with samples", () => {
    const sync = makeSync();
    sync.register("a");
    sync.register("c"); // no samples — excluded
    sync.recordRtt("a", 30);
    const snapshot = sync.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.socketId).toBe("a");
    expect(snapshot[0]!.oneway).toBe(15);
  });

  it("is safe when probes come from never-registered connections, and in stats mode", () => {
    const sync = new SyncService(new ServerClock(), true, 64); // stats logging on
    expect(() => {
      sync.recordProbe("ghost-id", 123456.7);
      sync.recordRtt("ghost-id", 33);
      sync.register("a");
      sync.unregister("a");
      sync.unregister("a"); // duplicate unregister must not throw
      sync.estimate("ghost-id");
      sync.snapshot();
    }).not.toThrow();
    expect(sync.estimate("ghost-id")!.rtt).toBe(33);
  });
});

const sort = (xs: string[]) => [...xs].sort();
