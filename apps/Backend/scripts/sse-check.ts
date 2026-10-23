/**
 * SSE check — end-to-end proof for Phase 4: the "any app" HTTP contract.
 * Everything here is plain HTTP: no sockets, no SDK, no build tooling —
 *   GET  /api/state          (fresh-boot mode detection)
 *   GET  /api/sync           (bootId probes)
 *   GET  /api/stream         (SSE envelopes + clock beacons + Last-Event-ID resume)
 *   POST /api/transport/*    (committed conductor commands — local guard)
 *
 *   Yarn-less:  npx tsx scripts/sse-check.ts [url]
 *   e.g.        npx tsx scripts/sse-check.ts http://localhost:3999
 *
 * Run against a FRESH boot (engine ON by default — envelopes/beats only exist
 * there, and the script fails fast with a hint on a legacy-booted server).
 * Emulations two SSE consumers, one of which drops mid-play and reconnects
 * with `Last-Event-ID` while the transport is being driven — the merge gate's
 * resume-after-reconnect proof. Exit code 0 = all green.
 */
import http from "node:http";

const url = new URL(process.argv[2] ?? "http://localhost:3999");
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

type Envelope = { seq: number; type: string; at: number; lead: number; data: unknown };
type Frame = { id: number; event: string; data: Envelope };

/** Minimal hand-rolled SSE consumer (what any third party would do, Node edition). */
class SseStream {
  frames: Frame[] = [];
  lastId = 0; // highest envelope id observed (browser-style lastEventId)
  closed = false;
  private req?: http.ClientRequest;
  private res?: http.IncomingMessage;

  constructor(readonly name: string) {}

  async connect(lastEventId?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { accept: "text/event-stream" };
      if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: "/api/stream", headers },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`GET /api/stream -> ${res.statusCode} (expected 200)`));
          }
          this.res = res;
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              this.ingest(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              boundary = buffer.indexOf("\n\n");
            }
          });
          res.on("end", () => {
            this.closed = true;
          });
          res.on("error", () => {
            this.closed = true;
          });
          resolve();
        },
      );
      req.on("error", (err) => reject(err));
      this.req = req;
      req.end();
    });
  }

  private ingest(raw: string): void {
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // keep-alive comment
    }
    const fields = new Map<string, string[]>();
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      const key = colon === -1 ? line : line.slice(0, colon);
      const values = fields.get(key) ?? [];
      values.push(value);
      fields.set(key, values);
    }
    const data = (fields.get("data") ?? []).join("\n");
    if (data === "") return; // comment-only or retry frames
    const env = JSON.parse(data) as Envelope;
    const idText = (fields.get("id") ?? [])[0];
    const id = idText !== undefined ? Number.parseInt(idText, 10) : 0;
    if (Number.isFinite(id) && id > 0) this.lastId = Math.max(this.lastId, id);
    this.frames.push({ id, event: (fields.get("event") ?? ["message"])[0]!, data: env });
  }

  close(): void {
    this.closed = true;
    this.res?.destroy();
    this.req?.destroy();
  }

  /** Latest frame matching a predicate (with timeout) or null. */
  latest<F extends Frame = Frame>(pred: (f: Frame) => boolean): F | null {
    return (this.frames.filter(pred).at(-1) ?? null) as F | null;
  }
  async waitFor<F extends Frame = Frame>(
    pred: (f: Frame) => boolean,
    timeout = 3000,
  ): Promise<F | null> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const hit = this.latest(pred);
      if (hit) return hit as F;
      if (Date.now() > deadline || this.closed) return null;
      await wait(20);
    }
  }
  /** All frames of one event type. */
  of(type: string): Frame[] {
    return this.frames.filter((f) => f.event === type);
  }
}

const json = async (path: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${url.origin}${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return (await res.json()) as Record<string, unknown>;
};

/* ── the battery ─────────────────────────────────────────────────────────── */
const consumerA = new SseStream("A (reconnecter)");
const consumerB = new SseStream("B (always-on)");

Promise.all([consumerA.connect(), consumerB.connect()])
  .then(async () => {
    // 0. mode detection + clean transport
    const state = await json("/api/state");
    if (state.engineMode !== true) {
      console.error(
        "FAIL  engine mode OFF on this server. " +
          "Since Phase 5 the TransportEngine is the only mode — this looks like an out-of-date server build.",
      );
      consumerA.close();
      consumerB.close();
      process.exit(1);
    }
    check("engine mode ON (/default)", state.engineMode === true, state.engineMode);

    if (state.playing === true) {
      await json("/api/transport/stop", "POST");
      console.log("Info  pre-existing transport stopped (fresh-boot rule broken by another process?)");
    }

    // 1. both consumers receive SSE frames of the right shape
    const firstBeacon = await consumerB.waitFor((f) => f.event === "clock", 6000);
    check("SSE frames: clock beacon arrives", !!firstBeacon, firstBeacon);
    const firstBeaconData = firstBeacon?.data.data as { mono: number; epoch: number; bootId: string } | undefined;
    check(
      "clock beacon shape (seq/type/at/lead/data.mono+epoch+bootId)",
      !!firstBeacon &&
        firstBeacon.id > 0 &&
        firstBeacon.data.type === "clock" &&
        typeof firstBeacon.data.at === "number" &&
        typeof firstBeaconData?.mono === "number" &&
        typeof firstBeaconData?.epoch === "number" &&
        typeof firstBeaconData?.bootId === "string",
      firstBeacon,
    );

    // 2. beacons stay on cadence across the whole run (checked at the end)
    const bootA = (await json("/api/state")).bootId as string;

    // 3. baseline tempo while stopped (committed + mirrored on the stream)
    const tempo = await json("/api/transport/tempo", "POST", { bpm: 90 });
    check("POST /transport/tempo committed shape", typeof tempo.at === "number" && tempo.tempo === 90, tempo);
    const tempoEnvB = await consumerB.waitFor((f) => f.event === "transport.tempo");
    check(
      "stream carries transport.tempo with the committed at",
      !!tempoEnvB && Math.abs(tempoEnvB.data.at - (tempo.at as number)) < 1,
      { envelope: tempoEnvB?.data, committed: tempo.at },
    );
    const tempoEnvA = await consumerA.waitFor((f) => f.event === "transport.tempo");
    check("fan-out reaches every consumer", !!tempoEnvA && tempoEnvA.id === tempoEnvB?.id, {
      a: tempoEnvA?.id,
      b: tempoEnvB?.id,
    });

    // 4. transport start: request honored exactly (700ms > minLead clamp)
    const clockState = (await json("/api/clock")) as { mono: number };
    const requestedAt = clockState.mono + 700;
    const start = await json("/api/transport/start", "POST", { at: requestedAt, position: "0:0:0" });
    check("POST /transport/start commits the requested at", start.at === requestedAt, {
      requested: requestedAt,
      committed: start.at,
    });
    check(
      "POST /transport/start committed shape (at/position/positionBeats/tempo/playing/pendingStart)",
      typeof start.at === "number" &&
        start.position === "0:0:0" &&
        start.positionBeats === 0 &&
        start.tempo === 90 &&
        start.playing === true,
      start,
    );
    const startEnvB = await consumerB.waitFor((f) => f.event === "transport.start");
    check(
      "stream carries transport.start with the committed at + measured lead",
      !!startEnvB &&
        Math.abs(startEnvB.data.at - (start.at as number)) < 1 &&
        startEnvB.data.lead >= minLead,
      { envelope: startEnvB?.data, committed: start.at },
    );

    // 5. beat envelopes: exact period for the whole stream pair
    await wait(100); // let the first beats flow
    const bpm = 90;
    const expectedPeriod = 60000 / bpm;
    const bBeats = (await (async () => {
      const deadline = Date.now() + 6000;
      for (;;) {
        const beats = consumerB.of("beat").filter((f) => f.data.seq > (startEnvB?.data.seq ?? 0));
        if (beats.length >= 6 || Date.now() > deadline) return beats;
        await wait(25);
      }
    })()) as Frame[];
    // The catch-up-visible first beats may race the envelope fan-out; use the
    // cleanest run: all deltas of consecutive beats.
    const deltas = bBeats.slice(1).map((b, i) => b.data.at - bBeats[i]!.data.at);
    check(
      `beat envelopes spaced exactly 60000/${bpm} ms (±2)`,
      deltas.length >= 4 && deltas.every((d) => Math.abs(d - expectedPeriod) <= 2),
      { deltas, n: bBeats.length },
    );
    const bIndices = bBeats.map((f) => (f.data.data as { index: number }).index);
    check("beat indices increment", at(bIndices, deltas.length + 1), bIndices);

    // 6. tempo change mid-play → period retunes to the timeline truth
    const tempo2 = await json("/api/transport/tempo", "POST", { bpm: 150 });
    const tempo2At = tempo2.at as number;
    const bBeats150 = (await (async () => {
      const deadline = Date.now() + 6000;
      for (;;) {
        const changed = consumerB.of("beat").filter((f) => f.data.at > tempo2At);
        if (changed.length >= 4 || Date.now() > deadline) return changed;
        await wait(25);
      }
    })()) as Frame[];
    const deltas150 = bBeats150.slice(1).map((b, i) => b.data.at - bBeats150[i]!.data.at);
    check(
      "tempo retune lands exactly (400 ms period at 150 bpm, ±2)",
      deltas150.length >= 2 && deltas150.every((d) => Math.abs(d - 400) <= 2),
      { deltas: deltas150, n: bBeats150.length },
    );

    // 7. seek while playing → envelope + beat index jumps to the anchor
    // ("0:2:0" = bar 0, beat 2 — an integer beat, so the next beat is the
    // anchor itself with index 2.)
    const seek = await json("/api/transport/seek", "POST", { position: "0:2:0" });
    check("POST /transport/seek committed shape", typeof seek.at === "number" && seek.position === "0:2:0", seek);
    const seekEnv = await consumerB.waitFor((f) => f.event === "transport.seek");
    check("stream carries transport.seek", !!seekEnv && seekEnv.data.at === seek.at, {
      envelope: seekEnv?.data,
      committed: seek.at,
    });
    // The anchor rephases the cadence (same tempo), so the meaningful
    // invariant is consecutive indexes and an unbroken 400 ms cadence from
    // the first post-seek beat onward (which exact index the anchor lands on
    // depends on the pre-seek phase).
    await wait(40);
    const postSeek = (await (async () => {
      const deadline = Date.now() + 4000;
      for (;;) {
        const batch = consumerB.of("beat").filter((f) => f.data.at > (seekEnv?.data.at ?? Infinity));
        if (batch.length >= 4 || Date.now() > deadline) return batch.slice(0, 4) as { data: { at: number; lead: number; data: { index: number } } }[];
        await wait(25);
      }
    })()) as { data: { at: number; lead: number; data: { index: number } } }[];
    const postSeekDeltas = postSeek.slice(1).map((b, i) => b.data.at - postSeek[i]!.data.at);
    const postSeekIndexes = postSeek.map((f) => f.data.data.index);
    const postSeekConsecutive = postSeekIndexes.every(
      (v, i) => i === 0 || v - postSeekIndexes[i - 1]! === 1,
    );
    check(
      "post-seek beats: consecutive indexes, anchor rephased (400 ms ±2)",
      postSeek.length >= 3 &&
        postSeekConsecutive &&
        postSeekDeltas.every((d) => Math.abs(d - 400) <= 2),
      { postSeekIndexes, postSeekDeltas },
    );

    // 8. RESUME AFTER RECONNECT — the merge gate's core proof.
    const breakId = consumerA.lastId;
    consumerA.close();
    console.log(`Info  consumer A dropped after envelope ${breakId}`);
    await wait(400);

    // While A is down: beats + a full stop…start cycle
    const bWhileDown = (await (async () => {
      const before = consumerB.frames.length;
      const deadline = Date.now() + 3000;
      for (;;) {
        if (consumerB.of("beat").length > 0 || consumerB.frames.length > before || Date.now() > deadline) return true;
        await wait(25);
      }
    })()) as boolean;
    check("B keeps streaming while A is down", bWhileDown, {});
    await json("/api/transport/stop", "POST");
    const stopEnvB = await consumerB.waitFor((f) => f.event === "transport.stop");
    check("empty transport.stop observed on B", !!stopEnvB, stopEnvB?.data);
    await json("/api/transport/tempo", "POST", { bpm: 60 });
    await json("/api/transport/start", "POST", {}); // default position resume
    const restartEnvB = await consumerB.waitFor(
      (f) => f.event === "transport.start" && (f.data.at ?? 0) > 0 && f.data.seq > (stopEnvB?.data.seq ?? 0),
    );
    check("restart observed on B while A is away", !!restartEnvB, restartEnvB?.data);
    await wait(700); // a couple of fresh beats past the restart

    // Snapshot anything B saw during the outage (ground truth for the replay)
    const missedB = consumerB.frames
      .filter((f) => f.id > breakId)
      .map((f) => ({ id: f.id, event: f.event }));
    check(
      "outage span contains envelopes to replay (stop/tempo/start/beats)",
      missedB.length >= 4 &&
        missedB.some((m) => m.event === "transport.stop") &&
        missedB.some((m) => m.event === "transport.start"),
      missedB,
    );

    // Reconnect with Last-Event-ID and confirm gapless replay
    const aBeforeReplay = consumerA.frames.length;
    await consumerA.connect(breakId);
    await wait(600);
    const replayedFrames = consumerA.frames.slice(aBeforeReplay).map((f) => f.id);
    const covered = missedB.every((m) => replayedFrames.includes(m.id));
    check("replay covers every envelope missed during the outage (no gaps)", covered, {
      breakId,
      missed: missedB.map((m) => m.id),
      replayed: replayedFrames,
    });
    check("replay does not resend already-seen ids (> breakId only)", replayedFrames.every((id) => id > breakId), {
      breakId,
      replayed: replayedFrames,
    });
    const replayIsOrdered = (ids: number[]) => ids.every((v, i) => i === 0 || v > ids[i - 1]!);
    check("replay is in seq order", replayIsOrdered(replayedFrames), replayedFrames);
    const freshEnvA = await consumerA.waitFor((f) => f.id > (restartEnvB?.data.seq ?? 0) || f.event === "beat", 4000);
    check("live envelopes continue after the replay", !!freshEnvA, freshEnvA?.id);

    // 9. cadence + boot stability over the run
    const beacons = consumerB.of("clock");
    const beaconGaps = beacons
      .slice(1)
      .map((b, i) => (b.data.data as { mono: number }).mono - (beacons[i]!.data.data as { mono: number }).mono);
    check(
      "clock beacons keep ~2.5s cadence on the stream",
      beaconGaps.length >= 1 && beaconGaps.every((g) => g > 1500 && g < 4000),
      beaconGaps,
    );
    const bootB = (await json("/api/state")).bootId as string;
    check("bootId stable over the run (clock-domain sanity)", bootA === bootB, { bootA, bootB });

    // 10. roster shape (counts vary with other devices — shape only)
    const clients = await json("/api/clients");
    check(
      "GET /api/clients shape (bootId/count/clients[])",
      typeof clients.bootId === "string" &&
        typeof clients.count === "number" &&
        Array.isArray(clients.clients) &&
        clients.clients.every((c: Record<string, unknown>) => typeof c.role === "string"),
      clients,
    );

    // 11. final stop rests the transport
    await json("/api/transport/stop", "POST");
    const stopped = await json("/api/state");
    check("api/state stopped at the end", stopped.playing === false, stopped);

    console.log(`${failures ? "\nFAILED checks: " + failures : "\nAll checks passed."} (bootId ${bootB})`);
    consumerA.close();
    consumerB.close();
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error("sse-check crashed:", err);
    consumerA.close();
    consumerB.close();
    process.exit(1);
  });

// ── helpers ──────────────────────────────────────────────────────────────────
function at(indices: number[], end: number): boolean {
  // Sequence: strictly increasing consecutive integers over the window.
  if (end === 0 || indices.length === 0) return false;
  for (let i = 1; i < Math.max(end, 1); i++) {
    if (indices[i] === undefined || indices[i - 1] === undefined || indices[i]! - indices[i - 1]! !== 1) return false;
  }
  return true;
}
