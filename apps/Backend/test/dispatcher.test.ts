import { describe, it, expect } from "vitest";
import { EnvelopeDispatcher } from "../src/core/dispatcher.js";
import { SyncService } from "../src/core/sync-service.js";
import { ServerClock } from "../src/core/clock.js";
import type { Envelope } from "../src/core/types.js";
import { FakeClock } from "./helpers/fake-clock.js";

describe("EnvelopeDispatcher", () => {
  it("lead = minLead + max one-way across measured connections", () => {
    const clock = new ServerClock();
    const sync = new SyncService(clock);
    sync.register("a");
    sync.recordRtt("a", 30); // oneway 15
    sync.register("b");
    sync.recordRtt("b", 50); // oneway 25

    const dispatcher = new EnvelopeDispatcher(clock, sync, { send: () => {} });
    expect(dispatcher.lead()).toBe(250 + 25);
  });

  it("lead falls back to minLead when nothing is measured yet", () => {
    const clock = new ServerClock();
    const dispatcher = new EnvelopeDispatcher(clock, new SyncService(clock), { send: () => {} });
    expect(dispatcher.lead()).toBe(250);
  });

  it("envelopes carry monotonic seq, type, at, lead, data", () => {
    const clock = new ServerClock();
    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(clock, new SyncService(clock), {
      send: (_e, payload) => void sent.push(payload),
    });

    dispatcher.emitNow("transport.stop", 123.5, { positionBeats: 4 });
    dispatcher.emitNow("beat", 456.75, { index: 7 });

    expect(sent[0]).toMatchObject({ seq: 1, type: "transport.stop", at: 123.5, data: { positionBeats: 4 } });
    expect(sent[1]).toMatchObject({ seq: 2, type: "beat", at: 456.75, data: { index: 7 } });
  });

  it("schedule() emits early enough to beat the deadline (fake clock)", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      timers: fake.timers(),
    });

    const at = fake.now() + 1000;
    dispatcher.schedule(at, "transport.start", { positionBeats: 0 });
    expect(sent).toHaveLength(0); // not yet — emission is scheduled

    fake.stepTo(at - dispatcher.lead());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.at).toBe(at);
  });

  it("schedule() with a due-now deadline emits immediately", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      timers: fake.timers(),
    });

    dispatcher.schedule(fake.now(), "transport.stop", { positionBeats: 0 });
    expect(sent).toHaveLength(1);
  });

  it("unicast goes only to the given socket", () => {
    const clock = new ServerClock();
    const emitted: { event: string; payload: Envelope }[] = [];
    const socket = { emit: (event: string, payload: Envelope) => void emitted.push({ event, payload }) };
    const dispatcher = new EnvelopeDispatcher(clock, new SyncService(clock), { send: () => {} });

    dispatcher.unicast(socket, "transport.start", clock.now() + 500, { tempo: 60 });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe("envelope");
    expect(emitted[0]!.payload.type).toBe("transport.start");
  });

  it("handleEngineEvent maps engine events onto envelope emissions", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      timers: fake.timers(),
    });

    // scheduled start: position 5.25 beats -> "1:1:1", emitted before its deadline
    dispatcher.handleEngineEvent({ type: "start-scheduled", at: fake.now() + 1000, positionBeats: 5.25, tempo: 60 });
    fake.stepTo(fake.now() + 1000);
    expect(sent.filter((e) => e.type === "transport.start")[0]!.data).toEqual({
      position: "1:1:1",
      positionBeats: 5.25,
      tempo: 60,
    });

    // immediate stop
    const stopAt = fake.now();
    dispatcher.handleEngineEvent({ type: "stopped", at: stopAt, positionBeats: 12 });
    expect(sent[sent.length - 1]).toMatchObject({
      type: "transport.stop",
      at: stopAt,
      data: { position: "3:0:0", positionBeats: 12 },
    });

    // scheduled tempo
    const tempoAt = fake.now() + 500;
    dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: tempoAt, bpm: 128 });
    fake.stepTo(tempoAt);
    expect(sent.filter((e) => e.type === "transport.tempo")[0]!.data).toEqual({ bpm: 128 });
  });
});

describe("EnvelopeDispatcher — tempo coalescing (Phase 5)", () => {
  const mk = (fake: FakeClock, sent: Envelope[], extra = {}) =>
    new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      timers: fake.timers(),
      ...extra,
    });

  it("keeps the classic at - lead slot for spaced tempo changes", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = mk(fake, sent);
    const at1 = fake.now() + 500;
    dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: at1, bpm: 90 });
    fake.stepTo(at1);
    expect(sent.filter((e) => e.type === "transport.tempo")).toHaveLength(1);
    expect(sent[sent.length - 1]!.at).toBe(at1);

    // A second tempo far beyond the 40ms window keeps its own slot.
    const at2 = fake.now() + 500;
    dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: at2, bpm: 96 });
    fake.stepTo(at2);
    const tempos = sent.filter((e) => e.type === "transport.tempo");
    expect(tempos).toHaveLength(2);
    expect(tempos[1]!.at).toBe(at2);
  });

  it("collapses a fluid-drag burst into a single envelope", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = mk(fake, sent);
    // A slider pumping 10 retunes, ~5ms apart (60 Hz), deadlines now + 500.
    for (let i = 0; i < 10; i++) {
      fake.step(5);
      dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: fake.now() + 500, bpm: 100 + i });
    }
    // Nothing emitted yet — every pending one was superseded within the window.
    expect(sent.filter((e) => e.type === "transport.tempo")).toHaveLength(0);
    fake.step(600); // the drag pauses; the newest envelope fires
    const tempos = sent.filter((e) => e.type === "transport.tempo");
    expect(tempos).toHaveLength(1);
    expect(tempos[0]!.data).toEqual({ bpm: 109 }); // the newest state wins
  });

  it("stops coalescing entirely when tempoCoalesceMs = 0", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = mk(fake, sent, { tempoCoalesceMs: 0 });
    for (let i = 0; i < 5; i++) {
      fake.step(5);
      dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: fake.now() + 500, bpm: 100 + i });
    }
    fake.step(600);
    expect(sent.filter((e) => e.type === "transport.tempo")).toHaveLength(5);
  });

  it("a stop cancels any pending tempo envelope", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = mk(fake, sent);
    dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: fake.now() + 500, bpm: 130 });
    const stopAt = fake.now() + 50;
    dispatcher.handleEngineEvent({ type: "stopped", at: stopAt, positionBeats: 3 });
    fake.stepTo(stopAt + 1000);
    expect(sent.filter((e) => e.type === "transport.tempo")).toHaveLength(0);
    expect(sent.filter((e) => e.type === "transport.stop")).toHaveLength(1);
  });

  it("seq gaps from superseded pendings stay harmless (monotonic)", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = mk(fake, sent);
    for (let i = 0; i < 4; i++) {
      dispatcher.handleEngineEvent({ type: "tempo-scheduled", at: fake.now() + 500, bpm: 100 + i });
    }
    fake.step(600);
    const seqs = sent.filter((e) => e.type === "transport.tempo").map((e) => e.seq);
    // Only the final one emitted, but the counter counted every build.
    expect(seqs.length).toBeLessThan(4);
    expect(dispatcher.sequence).toBeGreaterThanOrEqual(seqs.length);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});

describe("EnvelopeDispatcher — fire-on-receipt delivery (Phase 5)", () => {
  it("eager consumers receive envelopes immediately; scheduled ones on time", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const eager: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      eagerRoom: { emit: (_e, payload) => void eager.push(payload) },
      timers: fake.timers(),
    });

    const at = fake.now() + 1000;
    dispatcher.handleEngineEvent({ type: "start-scheduled", at, positionBeats: 0, tempo: 60 });
    // The eager copy is built as soon as the commit lands…
    expect(eager).toHaveLength(1);
    expect(eager[0]!.at).toBe(at);
    // …while the scheduled bus has not emitted yet.
    expect(sent).toHaveLength(0);

    fake.stepTo(at - dispatcher.lead());
    expect(sent).toHaveLength(1);
    // Same envelope identity (same seq) on both paths — client-side dedupe.
    expect(sent[0]!.seq).toBe(eager[0]!.seq);

    // Immediate (due-now) emissions reach the scheduled bus directly — there
    // is nothing to advance: both paths are "now", an eager copy would only
    // duplicate the envelope with a fresh seq.
    dispatcher.handleEngineEvent({ type: "stopped", at: fake.now(), positionBeats: 4 });
    expect(eager).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it("no eagerRoom configured = no eager traffic (default wiring)", () => {
    const fake = new FakeClock();
    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake), {
      send: (_e, payload) => void sent.push(payload),
      timers: fake.timers(),
    });
    dispatcher.handleEngineEvent({ type: "start-scheduled", at: fake.now() + 400, positionBeats: 0, tempo: 60 });
    fake.stepTo(fake.now() + 400);
    expect(sent).toHaveLength(1);
  });
});

describe("ConnectionRegistry", () => {
  it("assigns auto names in join order and returns removals", async () => {
    const { ConnectionRegistry } = await import("../src/core/registry.js");
    const registry = new ConnectionRegistry();

    const p1 = registry.addPerformer("s1");
    const p2 = registry.addPerformer("s2");
    expect(p1.name).toBe("Performer #1");
    expect(p2.name).toBe("Performer #2");
    expect(p1.status).toBe("Disconnected");

    expect(registry.roster().map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(registry.roster()).not.toBe(registry.roster()); // snapshot copies

    registry.setPerformerStatus("s1", "Connected");
    expect(registry.getPerformer("s1")!.status).toBe("Connected");

    expect(registry.removePerformer("s1")).toMatchObject({ id: "s1" });
    expect(registry.removePerformer("s1")).toBeNull();
    expect(registry.roster().map((p) => p.id)).toEqual(["s2"]);
  });

  it("enforces the single-conductor rule", async () => {
    const { ConnectionRegistry } = await import("../src/core/registry.js");
    const registry = new ConnectionRegistry();

    expect(registry.claimConductor("c1")).toBe(true);
    expect(registry.claimConductor("c2")).toBe(false);
    expect(registry.claimConductor("c1")).toBe(true); // re-claim by same id holds
    expect(registry.conductorId).toBe("c1");

    registry.releaseConductor("c2"); // wrong id: no-op
    expect(registry.conductorId).toBe("c1");
    registry.releaseConductor("c1");
    expect(registry.conductorId).toBeNull();
    expect(registry.claimConductor("c2")).toBe(true);
  });
});
