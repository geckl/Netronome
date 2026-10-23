import { describe, it, expect, vi } from "vitest";
import { NetronomeClient } from "../src/netronome-client.js";
import { ClockSync, type ClockSyncOptions } from "../src/clock-sync.js";

/** Hand-advanced monotonic clock for tests. */
class FakeClock {
  private tick = 0;
  now = (): number => this.tick;
  advance(ms: number): void {
    this.tick += ms;
  }
}

/** Fake `GET /api/sync` that stamps the reply exactly like the real server. */
function mkSyncFetch(clock: FakeClock, link: { offset: number; dOut?: number; dIn?: number }) {
  const fn = async (url: string) => {
    const t0 = clock.now();
    const dOut = link.dOut ?? 10;
    const dIn = link.dIn ?? 10;
    const t1 = t0 + dOut + link.offset;
    const t2 = t1 + 2;
    clock.advance(dOut + 2 + dIn);
    return { ok: true, status: 200, url, json: async () => ({ t1, t2, bootId: "boot-A" }) } as unknown as Response;
  };
  return fn as unknown as typeof fetch;
}

/**
 * Minimal Socket-like double. NetronomeClient only needs on/once/off/emit/
 * connect/disconnect; typed end-to-end through the socketFactory injection.
 */
class FakeSocket {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  emitted: Array<{ event: string; args: unknown[] }> = [];

  on(event: string, handler: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, handler: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    this.listeners.get(event)?.forEach((h) => h(...args));
    return this;
  }

  connect(): this {
    return this;
  }

  disconnect(): this {
    return this;
  }

  /** Test helper: fire a wire event as if it came from the server. */
  incoming(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((h) => h(...args));
  }
}

function clientOver(clock: FakeClock, socket: FakeSocket, clockOptions: Partial<ClockSyncOptions> = {}) {
  const client = new NetronomeClient({
    role: "performer",
    socketFactory: () => socket as never,
    clockFactory: () => new ClockSync({ now: clock.now, ...clockOptions }),
  });
  return client;
}

describe("NetronomeClient — envelope consumption", () => {
  it("routes typed subscriptions for valid envelopes", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const beats = vi.fn();
    const everything = vi.fn();
    client.on("beat", beats);
    client.onEnvelope(everything);

    socket.incoming("envelope", { seq: 1, type: "beat", at: 12345, lead: 260, data: { index: 7 } });

    expect(beats).toHaveBeenCalledTimes(1);
    expect(beats.mock.calls[0]![0].data).toEqual({ index: 7 });
    expect(everything).toHaveBeenCalledTimes(1);
    expect(everything.mock.calls[0]![1].receivedAtServer).toBeNull(); // not synced yet
    client.disconnect();
  });

  it("drops exact replays but admits out-of-order fresh envelopes (seq = build order)", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const handler = vi.fn();
    client.on("transport.start", handler);

    socket.incoming("envelope", { seq: 4, type: "transport.start", at: 100, lead: 1, data: {} });
    socket.incoming("envelope", { seq: 4, type: "transport.start", at: 100, lead: 1, data: {} }); // replay
    socket.incoming("envelope", { seq: 3, type: "transport.start", at: 99, lead: 1, data: {} }); // NOT stale: built earlier, emitted later (Phase 5 build-time seq)
    socket.incoming("envelope", { seq: 5, type: "transport.start", at: 101, lead: 1, data: {} }); // fresh

    expect(handler).toHaveBeenCalledTimes(3);
    expect((handler.mock.calls[0]![0] as { seq: number }).seq).toBe(4);
    expect((handler.mock.calls[1]![0] as { seq: number }).seq).toBe(3);
    expect((handler.mock.calls[2]![0] as { seq: number }).seq).toBe(5);
    client.disconnect();
  });

  it("resets the sequence guard when the server restarts (bootId change)", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const boots = ["boot-1", "boot-1", "boot-1", "boot-2"];
    let call = 0;
    const fetchWithBoots = (async () =>
      ({ ok: true, status: 200, json: async () => ({ t1: clock.now() + 5, t2: clock.now() + 6, bootId: boots[Math.min(call++, boots.length - 1)] }) }) as unknown as Response) as unknown as typeof fetch;
    const client = clientOver(clock, socket, { fetch: fetchWithBoots });
    const handler = vi.fn();
    client.on("beat", handler);
    const seenBoot: string[] = [];
    client.clock.onBootChange((bootId) => seenBoot.push(bootId));

    await client.clock.syncOnce();
    await client.clock.syncOnce();
    expect(seenBoot).toEqual([]); // same boot so far

    // Envelope seq 9 raises the guard...
    socket.incoming("envelope", { seq: 9, type: "beat", at: 1, lead: 1, data: {} });
    expect(handler).toHaveBeenCalledTimes(1);

    // ...the server restarts (4th probe reports boot-2)...
    await client.clock.syncOnce();
    await client.clock.syncOnce();
    expect(seenBoot).toEqual(["boot-2"]);

    // ...so the restarted server's fresh seq=1 must pass the guard now.
    socket.incoming("envelope", { seq: 1, type: "beat", at: 2, lead: 1, data: {} });
    expect(handler).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  it("ignores malformed payloads without touching handlers", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const handler = vi.fn();
    client.onEnvelope(handler);

    socket.incoming("envelope", null);
    socket.incoming("envelope", { seq: "3", type: "beat", at: 1, lead: 1, data: {} });
    socket.incoming("envelope", { seq: 3, type: "beat", at: 1, lead: 1 }); // missing data
    expect(handler).toHaveBeenCalledTimes(0);
    client.disconnect();
  });
});

describe("NetronomeClient — time conversion", () => {
  it("localAudioTime maps server deadlines onto the AudioContext clock", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket, { fetch: mkSyncFetch(clock, { offset: 250 }) });
    await client.clock.syncOnce();
    expect(client.synced).toBe(true);

    // A fake AudioContext: current time 3.000s.
    const ctx = { currentTime: 3.0 } as BaseAudioContext;
    // A deadline 350ms ahead is 350ms ahead on BOTH frames (durations are
    // frame-invariant; only absolute readings differ by the offset), so it
    // fires at 3.350s. The offset cancels by construction: serverNow() already
    // reads the server clock in a value anchored to the client's now.
    expect(client.localAudioTime(client.serverNow()! + 350, ctx)).toBeCloseTo(3.35, 6);
    // The same absolute instant expressed on the client frame (offset 250):
    expect(client.localAudioTime(clock.now() + 600, ctx)).toBeCloseTo(3.35, 6);
    // Past-due deadlines come back <= currentTime, which fires immediately:
    expect(client.localAudioTime(client.serverNow()! - 100, ctx)).toBeCloseTo(2.9, 6);
    client.disconnect();
  });

  it("localAudioTime throws a clear error before the first sync", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const ctx = { currentTime: 1 } as BaseAudioContext;
    expect(() => client.localAudioTime(123, ctx)).toThrow(/not synced/);
    client.disconnect();
  });
});

describe("NetronomeClient — transport commands (conductor role)", () => {
  it("emits deadlines in the server clock domain", async () => {
    const clock = new FakeClock();
    clock.advance(10_000);
    const socket = new FakeSocket();
    const client = new NetronomeClient({
      role: "conductor",
      socketFactory: () => socket as never,
      clockFactory: () => new ClockSync({ now: clock.now, fetch: mkSyncFetch(clock, { offset: 50 }) }),
    });
    await client.clock.syncOnce();

    client.sendStart("1:0:0");
    client.sendTempo(96, "0:0:0");
    client.sendStop();

    const conductorStart = socket.emitted.find((e) => e.event === "conductor-start")!;
    expect(conductorStart.args[0]).toBe(clock.now() + 50); // serverNow
    expect(conductorStart.args[1]).toBe("1:0:0");
    expect(conductorStart.args[2]).toBeTypeOf("function"); // the ack callback

    const tempo = socket.emitted.find((e) => e.event === "conductor-change-tempo")!;
    expect(tempo.args[0]).toBe(clock.now() + 50);
    expect(tempo.args[1]).toBe("0:0:0");
    expect(tempo.args[2]).toBe(96);

    expect(socket.emitted.some((e) => e.event === "conductor-stop")).toBe(true);
    client.disconnect();
  });
});

describe("NetronomeClient — transport state (GET /api/state)", () => {
  it("parses the engine snapshot", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain("/api/state");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bootId: "boot-A",
          engineMode: true,
          minLead: 250,
          playing: true,
          pendingStart: false,
          tempo: 96,
          beats: 12.25,
          position: "3:0:1",
          at: 555,
          upcomingTransitions: 2,
          clients: [{ socketId: "s1", rtt: 24, oneway: 12, jitter: 1.2, samples: 8, lastRttAt: 500 }],
        }),
      } as unknown as Response;
    });
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    try {
      const state = await client.fetchTransportState();
      expect(state.playing).toBe(true);
      expect(state.tempo).toBe(96);
      expect(state.clients.length).toBe(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
    client.disconnect();
  });

  it("rejects malformed state payloads", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const client = clientOver(clock, socket);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ bootId: "x" }) }) as unknown as Response) as unknown as typeof fetch;
    try {
      await expect(client.fetchTransportState()).rejects.toThrow(/GET \/api\/state/);
    } finally {
      globalThis.fetch = savedFetch;
    }
    client.disconnect();
  });
});

describe("NetronomeClient — reconnect policy (Phase 5)", () => {
  /** Read a vi.fn()-wrapped fetch's recorded calls without widening its type. */
  const mockOf = (fetchFn: typeof fetch): { calls: unknown[][] } =>
    (fetchFn as unknown as { mock: { calls: unknown[][] } }).mock;

  function mkFetch(clock: FakeClock, link: { offset: number; bootId?: string }) {
    return async (url: string) => {
      if (String(url).includes("/api/state")) {
        return {
          ok: true,
          status: 200,
          url,
          json: async () => ({
            bootId: link.bootId ?? "boot-A",
            engineMode: true,
            minLead: 250,
            playing: true,
            pendingStart: false,
            tempo: 108,
            beats: 12.5,
            position: "3:0:2",
            at: clock.now() + link.offset,
            upcomingTransitions: 1,
            clients: [],
          }),
        } as unknown as Response;
      }
      const t0 = clock.now();
      const t1 = t0 + 10 + link.offset;
      const t2 = t1 + 2;
      clock.advance(22);
      return { ok: true, status: 200, url, json: async () => ({ t1, t2, bootId: link.bootId ?? "boot-A" }) } as unknown as Response;
    };
  }

  it("re-joins the roster, bursts probes, and reports fresh state on reconnect", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const fetchFn = vi.fn(mkFetch(clock, { offset: 100 })) as unknown as typeof fetch;
    const resyncs: Array<{ state: unknown; reason: string }> = [];
    const client = new NetronomeClient({
      role: "performer",
      socketFactory: () => socket as never,
      // Huge interval: the background timer never re-arms during the test.
      clockFactory: () => new ClockSync({ now: clock.now, fetch: fetchFn, intervalMs: 1_000_000 }),
      fetch: fetchFn,
      sync: { resyncGapMs: 0 },
      onResync: (state, reason) => resyncs.push({ state, reason }),
    });

    const connectPromise = client.connect();
    socket.emit("connect"); // FakeSocket: the driver resolves the handshake
    await connectPromise;
    await new Promise((r) => setTimeout(r, 10)); // drain the clock loop's start probe

    expect(resyncs).toHaveLength(0); // first connect does not resync
    expect(socket.emitted.filter((e) => e.event === "sync-orchestra")).toHaveLength(0);

    // Simulated outage + automatic reconnect:
    socket.emit("connect");
    await new Promise((r) => setTimeout(r, 30)); // resync is async

    const joins = socket.emitted.filter((e) => e.event === "sync-orchestra");
    expect(joins).toHaveLength(1);
    expect(joins[0]!.args[0]).toEqual([]);
    const stateCalls = mockOf(fetchFn).calls.filter((c) =>
      String(c[0]).includes("/api/state"),
    ).length;
    expect(stateCalls).toBe(1); // exactly one fresh GET /api/state
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]!.reason).toBe("reconnect");
    expect((resyncs[0]!.state as { playing: boolean }).playing).toBe(true);
    client.disconnect();
  });

  it("resets the seq guard and resyncs when the server restarts (bootId change)", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    let boot = 0;
    const bootSource = () => (boot >= 2 ? "boot-B" : "boot-A");
    const fetchFn = vi.fn((url: string) => mkFetch(clock, { offset: 50, bootId: bootSource() })(url)) as unknown as typeof fetch;
    const resyncs: Array<{ reason: string }> = [];
    const client = new NetronomeClient({
      role: "performer",
      socketFactory: () => socket as never,
      clockFactory: () => new ClockSync({ now: clock.now, fetch: fetchFn, intervalMs: 1_000_000 }),
      fetch: fetchFn,
      sync: { resyncGapMs: 0 },
      onResync: (_state, reason) => resyncs.push({ reason }),
    });
    const connectPromise = client.connect();
    socket.emit("connect");
    await connectPromise;

    const handler = vi.fn();
    client.on("beat", handler);
    socket.incoming("envelope", { seq: 9, type: "beat", at: 1, lead: 1, data: {} });
    expect(handler).toHaveBeenCalledTimes(1);

    boot = 1; // same boot still
    await client.clock.syncOnce();
    boot = 2; // NOW the restart is observed
    await client.clock.syncOnce();

    // The restarted server's fresh seq=1 must pass the guard again, and the
    // automatic resync must have run to completion.
    await new Promise((r) => setTimeout(r, 30));
    expect(resyncs.some((r) => r.reason === "restart")).toBe(true);
    socket.incoming("envelope", { seq: 1, type: "beat", at: 2, lead: 1, data: {} });
    expect(handler).toHaveBeenCalledTimes(2);
    client.disconnect();
  });

  it("registers fire-on-receipt delivery on every connect when opted in", async () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const fetchFn = mkFetch(clock, { offset: 10 });
    const client = new NetronomeClient({
      role: "performer",
      socketFactory: () => socket as never,
      clockFactory: () => new ClockSync({ now: clock.now, fetch: fetchFn as unknown as typeof fetch }),
      deliveryMode: "on-receipt",
    });
    const connectPromise = client.connect();
    socket.emit("connect");
    await connectPromise;

    const registered = socket.emitted.filter((e) => e.event === "delivery-mode");
    expect(registered).toHaveLength(1);
    expect(registered[0]!.args[0]).toBe("on-receipt");

    socket.emit("connect"); // reconnect — the new server-side socket needs re-registration
    expect(socket.emitted.filter((e) => e.event === "delivery-mode")).toHaveLength(2);
    client.disconnect();
  });
});
