import { describe, it, expect } from "vitest";
import { TransportEngine } from "../src/core/transport.js";
import { EnvelopeDispatcher } from "../src/core/dispatcher.js";
import { BeatScheduler } from "../src/core/scheduler.js";
import { SyncService } from "../src/core/sync-service.js";
import type { Envelope } from "../src/core/types.js";
import { FakeClock } from "./helpers/fake-clock.js";

/**
 * Full emission-chain test: engine -> dispatcher -> wire, driven purely by
 * the fake clock. 60 bpm start commits (command time) with startAt = 11_000;
 * 120 bpm commits at 12_800. Lead = 250ms with zero measured one-way:
 *
 *   transport.start emitted at 10_750   (at: 11_000)
 *   beat 0         emitted at 10_750    (at: 11_000 — the downbeat itself)
 *   beat 1         emitted at 11_750    (at: 12_000)
 *   transport.tempo emitted at 12_550   (at: 12_800)
 *   beat 2         emitted at 12_650    (at: 12_900)
 *   beat 3         emitted at 13_150    (at: 13_400)
 *   transport.stop emitted immediately  (at: the stop instant)
 */
describe("BeatScheduler — server-side beat chain", () => {
  it("emits transport + beat envelopes with exact deadlines, then halts on stop", () => {
    const fake = new FakeClock();
    const t0 = fake.now(); // 10_000

    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake, false), {
      send: (_event, payload) => void sent.push(payload),
      timers: fake.timers(),
    });
    const engine = new TransportEngine(fake, { minLead: 100 });
    engine.on((event) => dispatcher.handleEngineEvent(event));

    const scheduler = new BeatScheduler(engine, dispatcher, fake, { timers: fake.timers() });
    scheduler.start();

    engine.start(t0 + 1000, 0, 60); // timeline live from the command; downbeat at t0+1000
    fake.stepTo(t0 + 1756); // fires: start env + beat 0 @t0+750, beat 1 @t0+1750
    engine.tempo(t0 + 2800, 120); // commit at t0+2800 (12_800) — scheduler re-syncs
    fake.stepTo(t0 + 3401); // tempo env @t0+2550, beat 2 @t0+2650 (12_900), beat 3 @t0+3150 (13_400)

    engine.stop();
    const stopAt = fake.now();
    fake.step(2000); // no further emissions

    const types = sent.map((e) => e.type);
    expect(types).toEqual([
      "transport.start",
      "beat",
      "beat",
      "transport.tempo",
      "beat",
      "beat",
      "transport.stop",
    ]);

    const [start] = sent.filter((e) => e.type === "transport.start");
    expect(start.at).toBe(t0 + 1000);
    expect(start.lead).toBe(250); // unmeasured connections -> minLead
    expect(start.data).toEqual({ position: "0:0:0", positionBeats: 0, tempo: 60 });

    const beats = sent.filter((e) => e.type === "beat");
    expect(beats.map((e) => e.at)).toEqual([t0 + 1000, t0 + 2000, t0 + 2900, t0 + 3400]);
    expect(beats.map((e) => (e.data as { index: number }).index)).toEqual([0, 1, 2, 3]);

    const [tempo] = sent.filter((e) => e.type === "transport.tempo");
    expect(tempo.at).toBe(t0 + 2800);
    expect(tempo.data).toEqual({ bpm: 120 });

    const [stopped] = sent.filter((e) => e.type === "transport.stop");
    expect(stopped.at).toBe(stopAt); // stop carries the stop instant

    // Envelope sequence numbers are strictly monotonic.
    const seqs = sent.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("reschedules the chain when a tempo change lands mid-stream", () => {
    const fake = new FakeClock();
    const t0 = fake.now();

    const sent: Envelope[] = [];
    const dispatcher = new EnvelopeDispatcher(fake, new SyncService(fake, false), {
      send: (_event, payload) => void sent.push(payload),
      timers: fake.timers(),
    });
    const engine = new TransportEngine(fake, { minLead: 100 });
    engine.on((event) => dispatcher.handleEngineEvent(event));
    const scheduler = new BeatScheduler(engine, dispatcher, fake, { timers: fake.timers() });
    scheduler.start();

    engine.start(t0 + 1000, 0, 60); // downbeat (beat 0) at t0+1000
    fake.stepTo(t0 + 1200); // fires beat 0 (t0+1000); beat 1's emission armed for t0+1750

    // Tempo accelerates while beat 1 has *not* fired yet: at 1400, 0.4 beats
    // have elapsed; bpm 120 -> beat 1 lands at 1400 + (1 - 0.4) * 500 = 1700.
    engine.tempo(fake.now() + 200, 120); // commit at now+200
    fake.stepTo(t0 + 1800);

    const beats = sent.filter((e) => e.type === "beat");
    expect(beats.map((e) => e.at)).toEqual([t0 + 1000, t0 + 1700]);
    expect(beats[1]!.data).toEqual({ index: 1 });
  });
});
