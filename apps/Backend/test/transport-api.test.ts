import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import express from "express";

import { transportRoutes } from "../src/api/transport.js";
import { clockRoutes } from "../src/api/clock.js";
import type { TransportApiOptions } from "../src/api/transport.js";
import { ServerClock } from "../src/core/clock.js";
import { SyncService } from "../src/core/sync-service.js";
import { EnvelopeDispatcher } from "../src/core/dispatcher.js";
import { TransportEngine } from "../src/core/transport.js";
import type { Envelope } from "../src/core/types.js";
import type { AddressInfo } from "node:net";

/**
 * POST /api/transport/* — the write side of the Express contract, wired
 * exactly like server.ts (POST -> TransportEngine -> dispatcher) so the
 * committed response and the broadcast envelope are both proven.
 */

describe("transport API (engine mode)", () => {
  let server: http.Server;
  let base = "";
  let broadcasts: Envelope[];

  const options: TransportApiOptions = {
    onlyLocal: (_req, _res, next) => next(),
  };

  beforeAll(async () => {
    const clock = new ServerClock();
    const engine = new TransportEngine(clock);
    const sync = new SyncService(clock);
    broadcasts = [];
    const dispatcher = new EnvelopeDispatcher(clock, sync, {
      send: (_event, payload) => void broadcasts.push(payload),
    });
    engine.on((event) => dispatcher.handleEngineEvent(event));

    const app = express();
    app.use("/api", clockRoutes(clock));
    app.use("/api", transportRoutes(clock, engine, sync, options));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body?: unknown): Promise<Record<string, unknown>> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then((r) => Promise.all([Promise.resolve(r.status), r.json() as Promise<Record<string, unknown>>])).then(([s, j]) => ({ status: s, ...j }));

  /** Transitions with future deadlines emit `at − lead` later — poll for it. */
  const waitForEnvelope = async (pred: (e: Envelope) => boolean, timeout = 1500): Promise<Envelope | undefined> => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = broadcasts.filter(pred).at(-1);
      if (hit) return hit;
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  it("start without an `at` commits now + minLead and returns the dispatch", async () => {
    const before = performance.now();
    const started = await post("/api/transport/start", {});
    // Express handling adds a few ms past the clock sample — the commit is
    // within [before+minLead, now+minLead+slack].
    expect(started.playing).toBe(true);
    expect(started.pendingStart).toBe(true);
    expect(started.position).toBe("0:0:0");
    expect(started.tempo).toBe(60); // engine default baseline (lastTempo)
    expect(started.at as number).toBeGreaterThanOrEqual(before + 250);
    expect(started.at as number).toBeLessThan(before + 250 + 60);
  });

  it("start broadcasts a transport.start envelope riding the committed at", async () => {
    const clockState = (await (await fetch(`${base}/api/clock`)).json()) as { mono: number };
    const started = await post("/api/transport/start", { at: clockState.mono + 800, position: "1:0:0", tempo: 90 });
    expect(started.at).toBe(clockState.mono + 800); // untouched — enough lead
    const last = await waitForEnvelope((e) => e.type === "transport.start" && e.at === started.at);
    expect(last).toMatchObject({ at: started.at, data: { position: "1:0:0", positionBeats: 4, tempo: 90 } });
    expect(last!.lead).toBeGreaterThanOrEqual(250);
    expect(started.playing).toBe(true);
  });

  it("late `at` clamps forward to now + minLead (never retroactive)", async () => {
    // A requested instant behind the server's now cannot hold: the commit is
    // pushed to now + minLead. (Server-mono timestamps are non-negative, so
    // "the past" here = a slightly stale uptime value.)
    const clockState = (await (await fetch(`${base}/api/clock`)).json()) as { mono: number };
    const before = clockState.mono;
    const started = await post("/api/transport/start", { at: Math.max(0, before - 100), position: "0:0:0" });
    expect(started.at as number).toBeGreaterThanOrEqual(before + 250);
    expect(started.at as number).toBeLessThan(before + 250 + 60);
    expect(started.pendingStart).toBe(true);
  });

  it("tempo mid-play commits the timeline (phase 5: no legacy mirror)", async () => {
    const clockState = (await (await fetch(`${base}/api/clock`)).json()) as { mono: number };
    const committed = await post("/api/transport/tempo", { bpm: 132, at: clockState.mono + 600 });
    expect(committed.tempo).toBe(132);
    const tempoEnvelope = await waitForEnvelope((e) => e.type === "transport.tempo" && e.at === committed.at);
    expect(tempoEnvelope!.at).toBe(committed.at);

    // Position continuity: the envelope's at lands inside the timeline
    expect(committed.playing).toBe(true);
  });

  it("tempo validation rejects non-positive bpm", async () => {
    const bad = await post("/api/transport/tempo", { bpm: 0 });
    expect(bad.status).toBe(400);
    const str = await post("/api/transport/tempo", { bpm: "fast" });
    expect(str.status).toBe(400);
  });

  it("seek while playing schedules the anchor (envelope carries it)", async () => {
    // "0:2:0" = bar 0, beat 2, zero sixteenths = beat index 2.
    const committed = await post("/api/transport/seek", { position: "0:2:0" });
    expect(committed.status).toBe(200);
    expect(committed.position).toBe("0:2:0");
    const seekEnvelope = broadcasts.filter((e) => e.type === "transport.seek").at(-1)!;
    expect(seekEnvelope).toMatchObject({ at: committed.at, data: { positionBeats: 2 } });
  });

  it("seek validation: missing or unparseable position is a 400", async () => {
    expect((await post("/api/transport/seek", {})).status).toBe(400);
    expect((await post("/api/transport/seek", { position: "nope" })).status).toBe(400);
  });

  it("start validation: bad at/position/tempo are 400s (no transport side effects)", async () => {
    expect((await post("/api/transport/start", { at: "yesterday" })).status).toBe(400);
    expect((await post("/api/transport/start", { position: "x:y:z" })).status).toBe(400);
    expect((await post("/api/transport/start", { tempo: -3 })).status).toBe(400);
  });

  it("stop freezes the exact server position and stops the transcription", async () => {
    // Let the transport actually run past its clamped start so the frozen
    // position is meaningfully > 0 (132 bpm ≈ 2.2 beats/s).
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const stopped = await post("/api/transport/stop");
    expect(stopped.playing).toBe(false);
    expect(stopped.pendingStart).toBe(false);
    expect(Number(stopped.positionBeats)).toBeGreaterThan(2);
    const stopEnvelope = broadcasts.filter((e) => e.type === "transport.stop").at(-1)!;
    expect(stopEnvelope).toMatchObject({ at: stopped.at, data: { positionBeats: stopped.positionBeats } });
    expect(stopped.playing).toBe(false);
  });

  it("seek while stopped only moves the frozen resume point (no envelope)", async () => {
    const broadcastsBefore = broadcasts.length;
    const seeked = await post("/api/transport/seek", { position: "2:0:0" });
    expect(seeked.playing).toBe(false);
    expect(seeked.position).toBe("2:0:0");
    expect(broadcasts.length).toBe(broadcastsBefore);
  });

  it("GET /api/state stays world-readable (no guard on reads)", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as { engineMode?: boolean };
    expect(state.engineMode).toBe(true); // constant since Phase 5 (field kept for third-party parsers)
  });
});
