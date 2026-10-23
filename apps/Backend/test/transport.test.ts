import { describe, it, expect } from "vitest";
import { TransportEngine, type TransportEvent } from "../src/core/transport.js";
import { formatPosition, parsePosition } from "../src/core/position.js";
import { FakeClock } from "./helpers/fake-clock.js";

/**
 * Phase-2 timeline tests, on a deterministic fake clock.
 *
 * Numbering cheat-sheet: 60 bpm = 1 beat / 1000 ms; 120 bpm = 1 beat / 500 ms.
 * `t0` is the fake clock's fixed boot instant (10_000). The timeline commits
 * at COMMAND time; a future start freezes positions until `startAt`.
 */
function makeEngine(opts?: { minLead?: number }) {
  const fake = new FakeClock();
  const t0 = fake.now();
  const events: TransportEvent[] = [];
  const engine = new TransportEngine(fake, { minLead: opts?.minLead ?? 100 });
  engine.on((event) => events.push(event));
  return { fake, engine, events, t0 };
}

describe("TransportEngine — timeline math", () => {
  it("commits a start's timeline at command time; positions freeze until startAt", () => {
    const { fake, engine, t0 } = makeEngine();
    const at = engine.start(t0 + 1000, 0, 60);
    expect(at).toBe(t0 + 1000);
    expect(engine.isPlaying()).toBe(true); // armed & driving the wire...
    expect(engine.isPendingStart()).toBe(true); // ...but still pre-downbeat
    expect(engine.beatsAt(t0 + 800)).toBeCloseTo(0); // frozen before startAt

    fake.stepTo(t0 + 1000);
    expect(engine.isPendingStart()).toBe(false);
    expect(engine.beatsAt(t0 + 1000)).toBeCloseTo(0);
    expect(engine.beatsAt(t0 + 1500)).toBeCloseTo(0.5); // 60 bpm -> 1 beat/s
    expect(engine.beatsAt(t0 + 2500)).toBeCloseTo(1.5);
  });

  it("tempo changes stay position-continuous across the boundary in both directions", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    fake.stepTo(t0 + 1000);

    expect(engine.tempo(t0 + 10_000, 120)).toBe(t0 + 10_000);
    // before: pure 60 bpm segment
    expect(engine.beatsAt(t0 + 9999)).toBeCloseTo(8.999, 1);
    // boundary: exactly 9 beats
    expect(engine.beatsAt(t0 + 10_000)).toBeCloseTo(9);
    // after: 9 + 1s x 120/60 beats
    expect(engine.beatsAt(t0 + 11_000)).toBeCloseTo(11);
    expect(engine.bpmAt(t0 + 11_000)).toBe(120);
  });

  it("stop freezes the exact position and a restart resumes from it", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    fake.stepTo(t0 + 1000);
    fake.stepTo(t0 + 4000); // 3 beats in

    const stopped = engine.stop();
    expect(stopped.positionBeats).toBeCloseTo(3);
    expect(engine.isPlaying()).toBe(false);
    expect(formatPosition(engine.getState().beats)).toBe("0:3:0");

    engine.start(t0 + 5000, undefined, 60); // position omitted -> resume
    fake.stepTo(t0 + 5000);
    expect(engine.beatsAt(t0 + 5500)).toBeCloseTo(3.5);
  });

  it("seek while playing jumps the position at the committed instant", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    fake.stepTo(t0 + 1000);

    engine.seek(t0 + 6000, "2:0:0"); // 8 beats
    fake.stepTo(t0 + 6000);
    expect(engine.beatsAt(t0 + 6500)).toBeCloseTo(8.5);
    expect(engine.getState().position).toBe("2:0:0");
  });

  it("clamps retro-time commands forward (guards against past deadlines)", () => {
    const { fake, engine } = makeEngine({ minLead: 100 });
    const at = engine.start(fake.now(), "1:0:0", 60);
    expect(at).toBe(fake.now() + 100);
  });

  it("a later start replaces the timeline (latest wins)", () => {
    const { fake, engine, events, t0 } = makeEngine();
    engine.start(t0 + 500, 0, 60);
    engine.start(t0 + 800, 4, 60); // conductor taps start twice
    fake.stepTo(t0 + 800);

    const scheduled = events.filter((e) => e.type === "start-scheduled");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]).toMatchObject({ at: t0 + 800, positionBeats: 4 });
    expect(engine.beatsAt(t0 + 1300)).toBeCloseTo(4.5); // second start owns the timeline
  });

  it("stop kills a scheduled start outright (latest transition wins)", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 500, 0, 60);
    engine.stop();
    fake.stepTo(t0 + 900); // well past the start instant

    expect(engine.isPlaying()).toBe(false);
    expect(engine.getState().beats).toBeCloseTo(0);
  });

  it("tempo addressed before a scheduled start retunes the upcoming start", () => {
    const { fake, engine, t0 } = makeEngine();
    const at = engine.start(t0 + 1000, 0, 60);
    const tempoAt = engine.tempo(t0 + 900, 120);
    expect(tempoAt).toBe(at); // the change takes effect with the downbeat

    fake.stepTo(t0 + 1000);
    expect(engine.bpmAt(t0 + 2000)).toBe(120);
    expect(engine.beatsAt(t0 + 1500)).toBeCloseTo(1); // 500ms x 120/60
  });

  it("tempo addressed after a scheduled start keeps its exact requested deadline", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    const tempoAt = engine.tempo(t0 + 1500, 120);
    expect(tempoAt).toBe(t0 + 1500); // deadline = max(requested, now + minLead)

    fake.stepTo(t0 + 1500);
    expect(engine.bpmAt(t0 + 1400)).toBe(60); // head segment untouched
    expect(engine.bpmAt(t0 + 1600)).toBe(120);
    expect(engine.beatsAt(t0 + 1600)).toBeCloseTo(0.7); // 0.5 + 100ms x 120/60
  });

  it("tempo while stopped only updates the baseline (no timeline, no playing)", () => {
    const { engine, t0 } = makeEngine();
    engine.tempo(t0 + 10_000, 90);

    expect(engine.isPlaying()).toBe(false);
    expect(engine.currentTempo()).toBe(90);
    expect(engine.getState().upcomingTransitions).toBe(0);
  });

  it("start while an earlier tempo baseline is pending adopts it (ordering: tempo -> start)", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.tempo(t0 + 800, 96); // baseline while stopped
    const at = engine.start(t0 + 1000, 0); // no explicit bpm -> baseline wins

    expect(at).toBe(t0 + 1000);
    fake.stepTo(t0 + 1200);
    expect(engine.bpmAt(t0 + 1200)).toBe(96);
  });
});

describe("TransportEngine — catch-up & state", () => {
  it("catchUp returns null when stopped", () => {
    const { engine } = makeEngine();
    expect(engine.catchUp()).toBeNull();
  });

  it("catchUp mirrors a scheduled start so late joiners join it too", () => {
    const { engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 12, 90);
    expect(engine.catchUp()).toEqual({ at: t0 + 1000, positionBeats: 12, tempo: 90 });
  });

  it("catchUp while playing starts from the exact current position with lead", () => {
    const { fake, engine, t0 } = makeEngine({ minLead: 100 });
    engine.start(t0 + 200, 0, 60);
    fake.stepTo(t0 + 3400); // 3.2 beats in

    const info = engine.catchUp()!;
    expect(info.at).toBeGreaterThanOrEqual(fake.now() + 100);
    expect(info.positionBeats).toBeCloseTo(engine.beatsAt(fake.now()), 6);
    expect(info.tempo).toBe(60);
  });

  it("getState reports forthcoming transitions", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 500, 0, 60);
    fake.stepTo(t0 + 500);
    engine.tempo(t0 + 2000, 120);

    const state = engine.getState();
    expect(state.playing).toBe(true);
    expect(state.pendingStart).toBe(false);
    expect(state.upcomingTransitions).toBe(1);
  });
});

describe("TransportEngine — beat enumeration across tempo boundaries", () => {
  it("nextBeatAt walks tempo boundaries exactly and continues on the new segment", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    fake.stepTo(t0 + 1000);
    engine.tempo(t0 + 2500, 120); // boundary anchor: 1.5 beats at 60 bpm

    // Beats: 1 at +2000 (60bpm), 2 at +2750, 3 at +3250 (120bpm).
    expect(engine.nextBeatAt(t0 + 1000)).toBe(t0 + 2000);
    expect(engine.nextBeatAt(t0 + 2000)).toBe(t0 + 2750);
    expect(engine.nextBeatAt(t0 + 2750)).toBe(t0 + 3250);
    expect(engine.indexAt(t0 + 3250)).toBe(3);
    expect(engine.beatsAt(t0 + 2500)).toBeCloseTo(1.5); // boundary continuity
  });

  it("pre-start probing jumps to the head; an integral head is the downbeat (beat 0)", () => {
    const { engine, t0 } = makeEngine();
    engine.start(t0 + 3000, 0, 60); // scheduled far ahead

    expect(engine.nextBeatAt(t0 + 100)).toBe(t0 + 3000); // beat 0 = the head
    expect(engine.indexAt(t0 + 3000)).toBe(0);
    expect(engine.nextBeatAt(t0 + 3000)).toBe(t0 + 4000); // regular grid after
  });

  it("fractional resumes skip the head and continue on the next integer beat", () => {
    const { fake, engine, t0 } = makeEngine();
    engine.start(t0 + 1000, 0, 60);
    fake.stepTo(t0 + 4200); // 3.2 beats in
    engine.stop(); // freezes 3.2 as the resume point
    engine.start(t0 + 6000, undefined, 60); // resume at 3.2

    const beat = engine.nextBeatAt(t0 + 5500)!;
    expect(beat).toBe(t0 + 6800); // head 3.2 is not an integer beat
    expect(engine.indexAt(beat)).toBe(4);
  });

  it("nextBeatAt returns null when stopped", () => {
    const { engine } = makeEngine();
    expect(engine.nextBeatAt(0)).toBeNull();
  });
});

describe("position conversions", () => {
  it("formatPosition snaps to the sixteenth grid", () => {
    expect(formatPosition(0)).toBe("0:0:0");
    expect(formatPosition(0.25)).toBe("0:0:1");
    expect(formatPosition(1)).toBe("0:1:0");
    expect(formatPosition(5.3)).toBe("1:1:1");
    expect(formatPosition(4.75)).toBe("1:0:3");
  });

  it("parsePosition reads Tone-style bars:beats:sixteenths", () => {
    expect(parsePosition("2:0:0")).toBe(8);
    expect(parsePosition("1:1:1")).toBeCloseTo(5.25);
    expect(parsePosition(6)).toBe(6);
    expect(parsePosition(undefined)).toBeUndefined();
    expect(parsePosition(null)).toBeUndefined();
    expect(parsePosition("")).toBeUndefined();
    expect(parsePosition("garbage")).toBeUndefined();
  });

  it("round-trips", () => {
    for (const beats of [0, 1.25, 5.25, 7.75, 31.5, 1024]) {
      const round = parsePosition(formatPosition(beats))!;
      expect(round).toBeCloseTo(Math.round(beats * 4) / 4, 9);
    }
  });
});
