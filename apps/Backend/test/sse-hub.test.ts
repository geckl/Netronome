import { describe, expect, it } from "vitest";
import { SseHub, type SseSink } from "../src/api/sse.js";
import type { Envelope } from "../src/core/types.js";
import type { TransportEngine } from "../src/core/transport.js";
import type { EnvelopeDispatcher } from "../src/core/dispatcher.js";
import { FakeClock } from "./helpers/fake-clock.js";

type CatchUpValue = { at: number; positionBeats: number; tempo: number };

/**
 * SSE hub — framing, `Last-Event-ID` replay ring, late-joiner catch-up and
 * beacon/keep-alive timers (driven by the fake clock so everything is
 * synchronous and inspectable).
 */

const env = (seq: number, type: string, at = 100 + seq, data: unknown = {}): Envelope => ({
  seq,
  type,
  at,
  lead: 250,
  data,
});

/** Structural clock the hub consumes; FakeClock + epoch bridge. */
function fakeClockSource(): FakeClock & { toEpoch(mono: number): number; bootId: string } {
  return Object.assign(new FakeClock(), { toEpoch: (mono: number) => mono, bootId: "fake-boot" });
}

function stubDispatcher(hub: SseHub) {
  let seq = 0;
  return {
    lead: () => 250,
    emitNow: (type: string, at: number, data: unknown): Envelope => {
      // Mirrors the real bus: every emission fans out through hub.broadcast.
      const envelope = env(++seq, type, at, data);
      hub.broadcast(envelope);
      return envelope;
    },
    unicast: (socket: { emit(event: string, ...args: unknown[]): void }, type: string, at: number, data: unknown): Envelope => {
      const envelope = env(++seq, type, at, data);
      socket.emit("envelope", envelope);
      return envelope;
    },
  } as unknown as EnvelopeDispatcher;
}

function stubEngine(playing: boolean, catchUpValue: CatchUpValue | null = null) {
  return {
    isPlaying: () => playing,
    catchUp: () => catchUpValue,
  } as unknown as TransportEngine;
}

function stubSink() {
  const frames: string[] = [];
  const closeHandlers: (() => void)[] = [];
  const sink: SseSink = {
    write: (frame: string) => void frames.push(frame),
    on: (_event: string, listener: () => void) => void closeHandlers.push(listener),
  };
  return {
    sink,
    frames,
    envelopes: () => frames.filter((f) => f.startsWith("id: ")),
    triggerClose: () => closeHandlers.forEach((cb) => cb()),
  };
}

describe("SseHub", () => {
  it("frames carry the wire contract as id/event/data lines", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { timers: clock.timers() });
    const engine = stubEngine(false);
    const dispatcher = stubDispatcher(hub);
    hub.wire(engine, dispatcher);

    const client = stubSink();
    hub.connect(client.sink, null);
    hub.broadcast(env(7, "beat", 2000, { index: 3 }));

    expect(client.frames[0]).toBe("retry: 3000\n\n");
    const frame = client.frames[1]!;
    expect(frame).toContain("id: 7\n");
    expect(frame).toContain("event: beat\n");
    const data = JSON.parse(frame.split("\ndata: ")[1]!) as Envelope;
    expect(data).toMatchObject({ seq: 7, type: "beat", at: 2000, lead: 250, data: { index: 3 } });
    expect(hub.size).toBe(1);
  });

  it("replays exactly the buffered envelopes after the reconnect id", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { timers: clock.timers() });
    hub.wire(stubEngine(false), stubDispatcher(hub));

    hub.broadcast(env(1, "transport.stop"));
    hub.broadcast(env(2, "transport.start"));
    hub.broadcast(env(3, "beat"));

    const client = stubSink();
    hub.connect(client.sink, "2");
    const replayed = idOf(client.envelopes());
    expect(replayed).toEqual([3]); // seq 3 only — the pin already saw 1..2
  });

  it("a fresh connect mid-play catches up exactly like a late socket joiner", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { timers: clock.timers() });
    hub.wire(stubEngine(true, { at: 5555, positionBeats: 2.5, tempo: 120 }), stubDispatcher(hub));

    const client = stubSink();
    hub.connect(client.sink, null);
    const envelopes = client.envelopes();
    expect(envelopes).toHaveLength(1);
    const data = JSON.parse(envelopes[0]!.split("\ndata: ")[1]!) as Envelope;
    expect(data).toMatchObject({
      type: "transport.start",
      at: 5555,
      data: { position: "0:2:2", positionBeats: 2.5, tempo: 120 }, // 2 beats + 2 sixteenths
    });
  });

  it("broadcasts flow only to connected consumers, then continue live", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { timers: clock.timers() });
    hub.wire(stubEngine(false), stubDispatcher(hub));
    hub.broadcast(env(1, "transport.start")); // zero clients: intended for no one
    const client = stubSink();
    hub.connect(client.sink, null);

    // Live envelopes continue streaming; nothing from before the connect shows.
    hub.broadcast(env(2, "beat"));
    hub.broadcast(env(3, "beat"));
    expect(idOf(client.envelopes())).toEqual([2, 3]);
  });

  it("uncurable gap → replay everything held + late-joiner catch-up", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { ringSize: 2, timers: clock.timers() });
    hub.wire(stubEngine(true, { at: 999, positionBeats: 0, tempo: 60 }), stubDispatcher(hub));

    hub.broadcast(env(1, "beat"));
    hub.broadcast(env(2, "beat"));
    hub.broadcast(env(3, "beat")); // seq 1 evicted from a ring of 2

    const client = stubSink();
    hub.connect(client.sink, "1");
    const replayed = client.envelopes();
    // Held tail: 2,3. Then the catch-up start (its own seq).
    expect(idOf(replayed).slice(0, 2)).toEqual([2, 3]);
    const catchUp = JSON.parse(replayed[2]!.split("\ndata: ")[1]!) as Envelope;
    expect(catchUp.type).toBe("transport.start");
    expect(catchUp.seq).toBeGreaterThan(0); // the dispatcher's own counter continues
  });

  it("beacons flow on cadence while clients exist and stop after the last drop", () => {
    const clock = fakeClockSource();
    const timers = clock.timers();
    const hub = new SseHub(clock, { beaconMs: 2500, timers });
    hub.wire(stubEngine(false), stubDispatcher(hub));

    const client = stubSink();
    hub.connect(client.sink, null);
    clock.stepTo(clock.now() + 2500);
    expect(beaconIds(client.envelopes()).length).toBe(1); // one clock frame

    client.triggerClose();
    expect(hub.size).toBe(0);
    clock.stepTo(clock.now() + 5000);
    expect(beaconIds(client.frames)).toHaveLength(1); // timer disarmed — no second beacon
  });

  it("keep-alive comments ride along when nothing else is flowing", () => {
    const clock = fakeClockSource();
    const hub = new SseHub(clock, { beaconMs: 60_000, keepAliveMs: 15_000, timers: clock.timers() });
    hub.wire(stubEngine(false), stubDispatcher(hub));
    const client = stubSink();
    hub.connect(client.sink, null);
    clock.stepTo(clock.now() + 15_000);
    expect(client.frames.filter((f) => f === ": keep-alive\n\n")).toHaveLength(1);
  });
});

// ── parsing helpers over the stub frames ─────────────────────────────────────
function envelopeFrames(source: string[]): string[] {
  return source
    .map((f) => f.replace("retry: 3000\n\n", "").replace("\n\n", ""))
    .filter((f) => f.startsWith("id: "));
}

function idOf(source: string[]): number[] {
  return envelopeFrames(source).map((f) => Number.parseInt(f.match(/^id: (\d+)/)![1]!, 10));
}

function beaconIds(source: string[]): string[] {
  return envelopeFrames(source).filter((f) => f.includes("event: clock"));
}
