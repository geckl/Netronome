/**
 * Engine check — end-to-end proof for the server-owned transport, driving
 * conductor commands through the real server.
 *
 *   npx tsx scripts/engine-check.ts [url]
 *   e.g.                   npx tsx scripts/engine-check.ts http://localhost:3999
 *
 * Flow: fake performer joins `/`, fake conductor joins `/conductor`, then a
 * full transport cycle (start -> tempo -> catch-up -> fluid burst -> stop)
 * with envelope-based assertions + `GET /api/state` verification +
 * second-conductor rejection + tempo coalescing. Exit code 0 = all green.
 */
import { io, Socket } from "socket.io-client";

const url = process.argv[2] ?? "http://localhost:3000";
const minLead = 250;

let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}:`, detail);
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the tracked envelopes until `predicate` matches, or fail after `timeoutMs`. */
const waitForEnvelope = async (predicate: (env: EnvelopeShape) => boolean, timeoutMs = 2500): Promise<EnvelopeShape | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = envelopes.find((e) => predicate(e.env))?.env ?? null;
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await wait(30);
  }
};

/* ── clients ─────────────────────────────────────────────────────────────── */
const performer: Socket = io(url, { transports: ["websocket"] });
const conductor: Socket = io(`${url}/conductor`, { transports: ["websocket"] });
const intruder: Socket = io(`${url}/conductor`, { transports: ["websocket"] });

type EnvelopeShape = { seq: number; type: string; at: number; lead: number; data: unknown };
const envelopes: { from: string; env: EnvelopeShape }[] = [];
const dump = () => envelopes.map((e) => `${e.from}#${e.env.seq}:${e.env.type}@${Math.round(e.env.at)}`);

/* ── flow ────────────────────────────────────────────────────────────────── */
Promise.all([
  new Promise<void>((resolve) => performer.on("connect", () => resolve())),
  new Promise<void>((resolve) => conductor.on("connect", () => resolve())),
])
  .then(async () => {
    performer.on("envelope", (env: unknown) => void envelopes.push({ from: "performer", env: env as EnvelopeShape }));
    conductor.on("envelope", (env: unknown) => void envelopes.push({ from: "conductor", env: env as EnvelopeShape }));
    const fromPerformer = (type: string) =>
      envelopes.filter((e) => e.from === "performer" && e.env.type === type).map((e) => e.env);
    const allEnvelopes = () => envelopes.map((e) => e.env);

    const bootState = (await (await fetch(`${url}/api/state`)).json()) as {
      bootId: string;
      engineMode: boolean;
    };
    const bootId = bootState.bootId;
    check("engine mode is the only mode", bootState.engineMode === true, bootState.engineMode);

    // 1. conductor claims the seat
    const synched = await new Promise<boolean>((resolve) =>
      conductor.emit("conductor-sync-orchestra", [20], (ok: boolean) => resolve(ok)),
    );
    check("first conductor accepted", synched === true, synched);

    // 2. second conductor rejected (registry-enforced single-conductor rule)
    const intruders = await new Promise<boolean>((resolve) =>
      intruder.emit("conductor-sync-orchestra", [20], (ok: boolean) => resolve(ok)),
    );
    check("second conductor rejected", intruders === false, intruders);

    // 3. performer syncs into the roster (no conductor catch-up while stopped)
    performer.emit("sync-orchestra", [15]);
    await wait(150);

    // 4. conductor start. targetTime = server mono + 500 (via the REST clock)
    const clockState = (await (await fetch(`${url}/api/clock`)).json()) as { mono: number };
    const targetTime = clockState.mono + 500;
    const committedStart = await new Promise<number>((resolve) =>
      conductor.emit("conductor-start", targetTime, "0:0:0", (newTargetTime: number) => resolve(newTargetTime)),
    );
    check(
      "conductor-start deadline (engine clamp)",
      committedStart >= targetTime && committedStart <= targetTime + 50, // enough lead -> untouched
      { requested: targetTime, committed: committedStart },
    );
    // The timed emission lands ~lead() after the commit — wait for it instead
    // of racing it (Phase 5: envelopes are BUILT at commit, EMITTED at at-lead).
    const lastStart = await waitForEnvelope((e) => e.type === "transport.start" && Math.abs(e.at - committedStart) < 1);
    check("envelope transport.start deadline", !!lastStart && Math.abs(lastStart.at - committedStart) < 1, dump());
    check(
      "envelope transport.start data (position/tempo)",
      !!lastStart && (lastStart.data as { position: string }).position === "0:0:0" &&
        (lastStart.data as { tempo: number }).tempo === 60,
      lastStart,
    );

    // 5. /api/state reflects the armed timeline
    const armedState = (await (await fetch(`${url}/api/state`)).json()) as {
      playing: boolean;
      pendingStart: boolean;
      tempo: number;
    };
    check("api/state pendingStart until the head lands", armedState.pendingStart === true && armedState.playing === true, armedState);

    // 6. tempo change pre-start retunes the head segment
    const tempoTarget = (await (await fetch(`${url}/api/clock`)).json()).mono as number + 500;
    const committedTempo = await new Promise<number>((resolve) =>
      conductor.emit("conductor-change-tempo", tempoTarget, "0:0:0", 120, (newTargetTime: number) =>
        resolve(newTargetTime),
      ),
    );
    check("single tempo commits exactly", committedTempo === tempoTarget, {
      requested: tempoTarget,
      committed: committedTempo,
    });

    // 7. wait past the committed start instant, then check the live state
    await wait(650);
    const state = (await (await fetch(`${url}/api/state`)).json()) as {
      playing: boolean;
      tempo: number;
      position: string;
      engineMode: boolean;
    };
    check("api/state playing", state.playing === true, state);
    check("api/state tempo", state.tempo === 120, state.tempo);
    check("api/state engineMode flag", state.engineMode === true, state.engineMode);

    // 8. envelopes: deadlines + measured lead + per-source seq sanity.
    // Phase 5: seq is assigned at BUILD (commit) time, so wire arrival can
    // invert across types when emission windows interleave (a beat built at
    // its timer-fire precedes a tempo committed earlier whose at lands later).
    // The invariant that must hold: per-source seqs are UNIQUE (no replays)
    // and strictly GROWING across same-type emissions.
    const tempoEnv = fromPerformer("transport.tempo").at(-1);
    check("envelope transport.tempo deadline", !!tempoEnv && Math.abs(tempoEnv.at - committedTempo) < 1, tempoEnv);
    check(
      "envelope transport.tempo data",
      !!tempoEnv && (tempoEnv.data as { bpm: number }).bpm === 120,
      tempoEnv,
    );
    check("envelope lead >= minLead", allEnvelopes().every((e) => e.lead >= minLead), allEnvelopes().map((e) => e.lead));
    const uniquePerSource = ["performer", "conductor"].every((src) => {
      const ss = envelopes.filter((e) => e.from === src).map((e) => e.env.seq);
      return ss.length > 0 && new Set(ss).size === ss.length;
    });
    const sameTypeOrdered = ["performer", "conductor"].every((src) => {
      const byType = new Map<string, number[]>();
      for (const e of envelopes.filter((x) => x.from === src)) {
        if (!byType.has(e.env.type)) byType.set(e.env.type, []);
        byType.get(e.env.type)!.push(e.env.seq);
      }
      return [...byType.values()].every((ss) => ss.every((s, i) => i === 0 || s > ss[i - 1]!));
    });
    check("envelope seq unique per source (no replays)", uniquePerSource, dump());
    check("envelope seq grows within each type per source", sameTypeOrdered, dump());

    // 9. late joiner: server-side catch-up rides the unicast envelope
    const stateBeforeLate = (await (await fetch(`${url}/api/state`)).json()) as { beats: number };
    const latecomer: Socket = io(url, { transports: ["websocket"] });
    const lateStart = new Promise<EnvelopeShape>((resolve) => {
      const look = (env: EnvelopeShape): void => {
        if (env.type !== "transport.start") return; // a beat may arrive first
        latecomer.off("envelope", look);
        resolve(env);
      };
      latecomer.on("envelope", look);
    });
    latecomer.on("connect", () => latecomer.emit("sync-orchestra", [15]));
    const lateEnv = await Promise.race([lateStart, wait(1500).then(() => null as null | EnvelopeShape)]);
    if (lateEnv) {
      // Catch-up occurs at sync time, so the position differs by the few
      // dozen ms between the /api/state fetch and the server's catchUp() —
      // coarse bounds catch sign/format bugs without being clock-fragile.
      const [m, b, s] = ((lateEnv.data as { position: string }).position).split(":").map(Number);
      const lateBeats = m! * 4 + b! + (s ?? 0) / 4;
      check(
        "late joiner caught up by the server (pure server logic)",
        lateEnv.at > committedStart &&
          (lateEnv.data as { tempo: number }).tempo === 120 &&
          lateBeats >= 0 &&
          Math.abs(lateBeats - stateBeforeLate.beats) < 2,
        { lateEnv, serverBeatsAtFetch: stateBeforeLate.beats },
      );
    } else {
      check("late joiner caught up by the server (pure server logic)", false, "no catch-up envelope within 1500ms");
    }
    latecomer.disconnect();

    // 10. Phase 5: fluid-tempo coalescing — a rapid burst must collapse.
    const burstBefore = fromPerformer("transport.tempo").length;
    for (let i = 0; i < 8; i++) {
      const burstTarget = ((await (await fetch(`${url}/api/clock`)).json()).mono as number) + 500;
      conductor.emit("conductor-change-tempo", burstTarget, "0:0:0", 100 + i, () => {});
    }
    await wait(900); // let the final pending envelope fire; last retune lands
    const burstTempos = fromPerformer("transport.tempo").slice(burstBefore);
    check(
      "fluid-tempo burst coalesces (envelope count < command count)",
      burstTempos.length < 8 && burstTempos.length >= 1,
      { commands: 8, envelopes: burstTempos.length },
    );
    const burstState = (await (await fetch(`${url}/api/state`)).json()) as { tempo: number };
    check("api/state tempo after burst = newest value", burstState.tempo === 107, burstState.tempo);
    const lastBurst = burstTempos.at(-1)!;
    check("final tempo envelope carries the newest bpm", (lastBurst.data as { bpm: number }).bpm === 107, lastBurst);

    // 11. stop — immediate stop envelope + frozen state
    const stopEnvelope = new Promise<EnvelopeShape>((resolve) =>
      performer.once("envelope", ((env: EnvelopeShape) => {
        if (env.type === "transport.stop") resolve(env);
      }) as never),
    );
    conductor.emit("conductor-stop");
    const stopEnv = await Promise.race([stopEnvelope, wait(1500).then(() => null as null | EnvelopeShape)]);
    check("envelope transport.stop arrived (immediate)", !!stopEnv && (stopEnv.data as { positionBeats: number }).positionBeats >= 0, stopEnv);
    const stateAfter = (await (await fetch(`${url}/api/state`)).json()) as { playing: boolean };
    check("api/state stopped", stateAfter.playing === false, stateAfter);

    console.log(`${failures ? "\nFAILED checks: " + failures : "\nAll checks passed."} (bootId ${bootId})`);
    [performer, conductor, intruder].forEach((s) => s.disconnect());
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error("engine-check crashed:", err);
    [performer, conductor, intruder].forEach((s) => s.disconnect());
    process.exit(1);
  });
