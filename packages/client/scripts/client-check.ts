/**
 * client-check — Phase-3 end-to-end proof: a REAL NetronomeClient connecting
 * to a running Netronome server, doing the whole cycle the apps do:
 *
 *   connect -> HTTP NTP clock sync -> join roster -> consume transport.* and
 *   beat envelopes (server-clock deadlines) -> localAudioTime conversion.
 *
 * Run (in packages/client):  yarn verify [url]
 *   e.g.                     yarn verify http://localhost:3999
 *
 * The server must run in engine mode (default since Phase 3). Exit 0 = green.
 */
import { NetronomeClient, type Envelope, type TransportTempoData } from "../src/index.js";
import { io, type Socket } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3999";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}:`, detail);
  }
}
function stage(name: string): void {
  console.log(`…     ${name}`);
}
/** Race a promise against a timeout so a stuck step fails instead of hanging. */
function bound<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

/** Fake AudioContext probe (currentTime advances with real wall time). */
class FakeCtx {
  private base = performance.now();
  private offsetSec = 3.0;
  get currentTime(): number {
    return this.offsetSec + (performance.now() - this.base) / 1000;
  }
}

async function main(): Promise<void> {
  // Hard watchdog: never hang a CI run silently.
  const watchdog = setTimeout(() => {
    console.error("WATCHDOG: run exceeded 60s — aborting with failure.");
    process.exit(1);
  }, 60_000);

  // ── the client under test ─────────────────────────────────────────────────
  const client = new NetronomeClient({ role: "performer", url });
  stage("connecting player client");
  await bound(client.connect(), 10_000, "player connect");
  check("socket connected", client.socket.connected, client.socket.id);
  stage("HTTP NTP probe");
  await bound(client.clock.syncOnce(), 5_000, "first HTTP NTP probe");

  const estimate = client.estimate();
  check("HTTP NTP synced (offset present)", !!estimate, estimate);
  check("rtt plausible (< 500ms)", estimate!.rtt < 500, estimate);
  check("serverNow() available", client.serverNow() !== null, client.serverNow());

  // offset sanity WITHOUT an absolute bound: the server mono clock starts at
  // its process boot, so |offset| scales with server uptime. The meaningful
  // invariant is STABILITY: serverNow() must advance by the wall delta.
  const firstServerNow = client.serverNow()!;
  const wallDelta = 150;
  await wait(wallDelta);
  const secondServerNow = client.serverNow()!;
  check("offset stable (serverNow advanced by the wall delta)", Math.abs(secondServerNow - firstServerNow - wallDelta) < 30, {
    firstServerNow,
    secondServerNow,
    expectedDelta: wallDelta,
  });

  // ── roster join (app-level, no deadlines) ─────────────────────────────────
  stage("joining roster");
  client.socket.emit("request-join");
  client.socket.emit("sync-orchestra", []);
  await wait(150);

  const state = await bound(client.fetchTransportState(), 5_000, "GET /api/state");
  check("engine mode on", state.engineMode === true, state);

  // ── drive the transport through a raw conductor socket ────────────────────
  stage("conductor connect");
  // A private manager (forceNew) so the websocket-only restriction always
  // applies even when another socket.io manager already exists in-process.
  const conductor: Socket = io(`${url}/conductor`, { transports: ["websocket"], forceNew: true });
  await bound(
    new Promise<void>((resolve, reject) => {
      conductor.on("connect", () => resolve());
      conductor.on("connect_error", (err) => reject(err));
    }),
    10_000,
    "conductor connect",
  );
  stage("conductor claim");
  const claimed = await bound(
    new Promise<boolean>((resolve) => {
      conductor.emit("conductor-sync-orchestra", [10], (ok: boolean) => resolve(ok));
      setTimeout(() => resolve(false), 5_000);
    }),
    6_000,
    "conductor-sync-orchestra ack",
  );
  check("conductor seat claimed", claimed === true, claimed);

  const envelopes: Envelope[] = [];
  client.onEnvelope((env) => envelopes.push(env));
  const ctx = new FakeCtx();

  // Start (server clamps to its minLead; the ack carries the committed instant)
  stage("conductor-start");
  // The envelope (performer socket) and the ack (conductor socket) travel on
  // DIFFERENT sockets — no cross-socket ordering guarantee — so collect both
  // before comparing.
  let startCommitted = 0;
  const startAckPromise = new Promise<number>((resolve) => {
    conductor.emit("conductor-start", client.serverNow() ?? 0, "0:0:0", (committed: number) => resolve(committed));
    setTimeout(() => resolve(-1), 5_000);
  });
  const startEnv = await bound(
    new Promise<Envelope | null>((resolve) => {
      const off = client.on("transport.start", (env) => {
        off();
        resolve(env);
      });
      setTimeout(() => resolve(null), 5_000);
    }),
    6_000,
    "transport.start envelope",
  );
  startCommitted = await bound(startAckPromise, 6_000, "conductor-start ack");
  check("start ack committed at (server clamps forward)", startCommitted >= (client.serverNow() ?? 0), {
    committed: startCommitted,
    serverNow: client.serverNow(),
  });
  check("transport.start envelope arrived", startEnv !== null, startEnv);
  check(
    "start deadline == server ack",
    startEnv !== null && Math.abs(startEnv.at - startCommitted) < 1,
    { at: startEnv?.at, ack: startCommitted },
  );
  const startLocal = startEnv ? client.localAudioTime(startEnv.at, ctx as unknown as BaseAudioContext) : 0;
  check("start deadline was future when handled", startEnv !== null && startLocal > ctx.currentTime, {
    dueSeconds: startLocal,
    ctxNow: ctx.currentTime,
    at: startEnv?.at,
    serverNow: client.serverNow(),
  });

  // Tempo to 90 (engine retunes the head segment pre-start)
  stage("conductor-change-tempo");
  conductor.emit("conductor-change-tempo", client.serverNow() ?? 0, "0:0:0", 90, () => {});
  await bound(
    new Promise<void>((resolve) => {
      client.on("transport.tempo", () => resolve());
      setTimeout(() => resolve(), 3_000);
    }),
    4_000,
    "transport.tempo envelope",
  );
  const tempoEnv = envelopes.find((e) => e.type === "transport.tempo") ?? null;
  check("transport.tempo envelope arrived", tempoEnv !== null, envelopes.map((e) => e.type));
  check(
    "tempo envelope says 90",
    tempoEnv !== null && (tempoEnv.data as TransportTempoData).bpm === 90,
    tempoEnv,
  );

  // ── beat chain at 90 bpm = 666.67ms ───────────────────────────────────────
  stage("beat chain collection");
  const beats: Envelope[] = [];
  await bound(
    new Promise<void>((resolve) => {
      const off = client.on("beat", (env) => {
        beats.push(env);
        if (beats.length >= 3) {
          off();
          resolve();
        }
      });
      setTimeout(resolve, 4_000);
    }),
    5_000,
    "beat envelopes",
  );
  check("beat envelopes arrived (>=3)", beats.length >= 3, beats.length);
  if (beats.length >= 2) {
    const deltas = beats.slice(1).map((b, i) => b.at - beats[i]!.at);
    const expected = 60_000 / 90;
    const bad = deltas.filter((d) => Math.abs(d - expected) > 2);
    check(`inter-beat deltas ~= ${expected.toFixed(1)}ms`, bad.length === 0, deltas);
    const monotonic = beats.every((b, i, arr) => i === 0 || b.seq > arr[i - 1]!.seq);
    check("envelope seq monotonic", monotonic, beats.map((b) => b.seq));
  }

  // localAudioTime conversion sanity: the last beat deadline must map onto
  // the fake ctx timeline at (or before) wall-now + small tolerance, since it
  // was consumed around its arrival.
  if (beats.length > 0) {
    const dueSeconds = client.localAudioTime(beats[beats.length - 1]!.at, ctx as unknown as BaseAudioContext);
    check("localAudioTime lands deadlines on the ctx timeline", dueSeconds <= ctx.currentTime + 5, {
      lastBeatAt: beats[beats.length - 1]!.at,
      dueSeconds,
      ctxNow: ctx.currentTime,
      serverNow: client.serverNow(),
    });
  }

  // ── stop ──────────────────────────────────────────────────────────────────
  stage("conductor-stop");
  const stopEnv = await bound(
    new Promise<Envelope | null>((resolve) => {
      const off = client.on("transport.stop", (env) => {
        off();
        resolve(env);
      });
      conductor.emit("conductor-stop");
      setTimeout(() => resolve(null), 2_000);
    }),
    3_000,
    "transport.stop envelope",
  );
  check("transport.stop envelope arrived", stopEnv !== null, stopEnv);
  const finalState = await bound(client.fetchTransportState(), 5_000, "final GET /api/state");
  check("api/state stopped", finalState.playing === false, finalState);

  conductor.disconnect();
  client.disconnect();
  clearTimeout(watchdog);

  const label = failures ? `FAILED checks: ${failures}` : "All checks passed.";
  console.log(label);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("client-check crashed:", err);
  process.exit(1);
});
