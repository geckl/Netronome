/**
 * Netronome — vanilla third-party client.
 *
 * The whole point of GET /api/stream: a synchronized metronome visual + click
 * with NOTHING but the HTTP contract —
 *
 *   GET /api/state   one-shot transport snapshot (what's happening right now)
 *   GET /api/sync    NTP-style probe (offset estimation, ~1ms-scale on LAN)
 *   GET /api/stream  SSE: every envelope, `id: <seq>` resume, `clock` beacons
 *   POST /api/transport/*   drive the transport (local machine only)
 *
 * No socket.io, no SDK, no tempo math: `beat` envelopes already carry WHERE
 * (index) and WHEN (at, server-clock ms). The client's only job is mapping
 * server `at` onto its own clock, which is what the /api/sync probes estimate.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const conn = $("conn"), playing = $("playing"), tempoEl = $("tempo"),
  position = $("position"), offsetEl = $("offset"), rttEl = $("rtt"),
  seqEl = $("seq"), bootEl = $("boot"), banner = $("banner"), logEl = $("log");
const blinker = $("blinker"), clickOn = $("clickOn"), bpm = $("bpm");

// ─── State ────────────────────────────────────────────────────────────────────
let bootId = null;        // envelope domain: resets whenever the server restarts
const seenSeqs = new Set(); // de-dup: exact replays only (see REPLAY_WINDOW below)
let serverMinusLocal = null; // ms: server-mono instant - local-epoch instant (~offset)
let probeRtt = null;
let serverOrigin = null;  // epoch ms of the server's mono zero point (/api/clock anchor)
const pending = new Map(); // at -> index, beats awaiting their local flash moment

const show = (el, text) => void (el.textContent = text);
const log = (text) => {
  const line = document.createElement("div");
  line.textContent = text;
  logEl.prepend(line);
  while (logEl.childElementCount > 40) logEl.lastChild.remove();
};

// ─── Clock sync (GET /api/sync, NTP-style) ────────────────────────────────────
async function probeOnce() {
  const t0 = Date.now(); // local epoch ms
  const res = await fetch("/api/sync", { cache: "no-store" });
  const t3 = Date.now();
  const { t1, t2, bootId: probeBoot } = await res.json();
  if (bootId && probeBoot !== bootId) resetClockDomain(probeBoot); // server restarted
  // Server-mono minus local-epoch, least-noisy at the smallest round trip
  // (the t2−t1 dwell is measured server-side, so offsets stay clean).
  const rtt = t3 - t0;
  const d = (t1 + t2) / 2 - (t0 + t3) / 2;
  return { d, rtt };
}

/** Boot-time anchor: the server's epoch ↔ mono bridge (fixed per boot). */
async function fetchClockInfo() {
  try {
    const { epoch, mono, bootId: freshBoot } = await (await fetch("/api/clock", { cache: "no-store" })).json();
    serverOrigin = epoch - mono;
    if (bootId === null) {
      bootId = freshBoot;
      show(bootEl, freshBoot.slice(0, 8) + "…");
    }
  } catch { /* the probes still give a usable mapping without the anchor */ }
}

async function syncLoop() {
  try {
    await fetchClockInfo(); // boot anchor: timeOrigin + first bootId (silent)
    // Short burst on boot, then a slow keep-fresh loop.
    for (let i = 0; i < 3; i++) once(await probeOnce());
  } catch {
    show(offsetEl, "sync failed — blinking on local clocks");
  }
  setInterval(async () => {
    for (let i = 0; i < 2; i++) once(await probeOnce());
  }, 4000);
}

function once({ d, rtt }) {
  // Prefer the least-jittery (min-rtt) sample, NTP-style.
  if (probeRtt === null || rtt < probeRtt) {
    probeRtt = rtt;
    serverMinusLocal = d;
    renderSync();
  }
}

function renderSync() {
  // Human-readable form: bridge the server's mono instant into its own wall
  // clock (via the boot anchor) so this is a real clock-skew figure.
  const skew = probeRtt === null ? null : (serverMinusLocal ?? 0) + (serverOrigin ?? 0);
  show(offsetEl, skew === null ? "measuring…" : `${skew.toFixed(1)} ms (bridged)`);
  show(rttEl, probeRtt === null ? "measuring…" : `${Math.round(probeRtt)} ms`);
}

function resetClockDomain(newBoot) {
  const first = bootId === null;
  bootId = newBoot;
  seenSeqs.clear();
  pending.clear();
  show(bootEl, newBoot.slice(0, 8) + "…");
  serverOrigin = null;
  void fetchClockInfo(); // re-anchor for the new boot
  if (!first) log("server restarted (bootId changed) — clock domain reset");
}

// ─── Visual: rAF loop flashes exactly when a beat crosses its local instant ──
// `pending` maps LOCAL due instants (epoch ms) -> beat index.
let lastFlash = -1e9;
function frame() {
  const now = Date.now();
  const due = [...pending.entries()].filter(([at]) => at <= now);
  if (due.length > 0) {
    // If rAF was paused (hidden tab), only the newest beat visually matters.
    const [at, index] = due.reduce((a, b) => (b[0] > a[0] ? b : a));
    for (const [pastAt] of due) pending.delete(pastAt);
    if (at > lastFlash + 100) persistFlash(now, at, index);
  }
  requestAnimationFrame(frame);
}

function persistFlash(now, at, index) {
  lastFlash = at;
  blinker.classList.add("on");
  setTimeout(() => blinker.classList.remove("on"), 110);
  log(`beat ${index}  (${Math.max(0, at - now).toFixed(0)} ms late)`);
}

// ─── Audio: the click, scheduled on the AudioContext clock ───────────────────
let ctx = null;
clickOn.addEventListener("change", async () => {
  if (!clickOn.checked) return;
  // AudioContexts need a user gesture to start — this is it.
  ctx = ctx ?? new AudioContext();
  await ctx.resume();
  log("click enabled");
});

function scheduleClick(localDueEpoch) {
  if (!ctx || !clickOn.checked) return;
  // Envelopes arrive reliably ahead of their deadline (the server schedules
  // emissions at `at − lead`); late arrivals still click, just immediately.
  const when = Math.max(ctx.currentTime, ctx.currentTime + (localDueEpoch - Date.now()) / 1000);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = (indexByEpoch.get(localDueEpoch) ?? 0) % 4 === 0 ? 1760 : 1180; // downbeat accent
  osc.connect(gain).connect(ctx.destination);
  gain.gain.setValueAtTime(0.16, when);
  gain.gain.exponentialRampToValueAtTime(1e-4, when + 0.08);
  osc.start(when);
  osc.stop(when + 0.09);
}

const indexByEpoch = new Map(); // localDue epoch -> beat index (for the click accent)

// ─── Envelope consumption (all event types share one shape) ──────────────────
function onEnvelope(env) {
  // Seq numbers are assigned at commit (build) time, so healthy wire arrival
  // can invert across types (a beat built at its timer-fire may precede a
  // tempo committed earlier whose emission window opens later). Drop only
  // EXACT duplicates (EventSource-reconnect replays / recover deliveries) —
  // never a `< lastSeq` watermark, which would eat fresh inverted envelopes.
  if (seenSeqs.has(env.seq)) return; // replay/duplicate — EventSource reconnects resend ids
  seenSeqs.add(env.seq);
  if (seenSeqs.size > 128) {
    // Evict the oldest quarter (insertion order = arrival order).
    let evicted = 0;
    for (const seq of seenSeqs) {
      if (evicted++ >= 32) break;
      seenSeqs.delete(seq);
    }
  }

  switch (env.type) {
    case "clock": // { mono, epoch, bootId }
      if (env.data.bootId && env.data.bootId !== bootId) resetClockDomain(env.data.bootId);
      break;
    case "beat": {
      if (env.data === null || env.data.index === undefined) break;
      const localDue = env.at - (serverMinusLocal ?? 0);
      if (localDue < Date.now() - 400) break; // long-gone beat (post-hidden-tab replay)
      pending.set(localDue, env.data.index);
      indexByEpoch.set(localDue, env.data.index);
      if (pending.size > 64) {
        const oldest = Math.min(...pending.keys());
        pending.delete(oldest);
        indexByEpoch.delete(oldest);
      }
      if (localDue >= Date.now()) scheduleClick(localDue);
      break;
    }
    case "transport.start": {
      const d = env.data;
      show(playing, "▶ playing");
      show(tempoEl, `${d.tempo} bpm`);
      show(position, d.position);
      log(`transport.start @${Math.round(env.at)}  position=${d.position} tempo=${d.tempo}`);
      break;
    }
    case "transport.stop":
      show(playing, "■ stopped");
      show(position, env.data.position);
      pending.clear();
      log(`transport.stop @${Math.round(env.at)}  frozen=${env.data.position}`);
      break;
    case "transport.seek":
      show(position, env.data.position);
      pending.clear();
      log(`transport.seek @${Math.round(env.at)}  position=${env.data.position}`);
      break;
    case "transport.tempo":
      show(tempoEl, `${env.data.bpm} bpm`);
      log(`transport.tempo @${Math.round(env.at)}  bpm=${env.data.bpm}`);
      break;
    default:
      break; // app.* envelopes are a passthrough for other integrations
  }
  show(seqEl, String(env.seq));
}

// ─── Stream lifecycle ────────────────────────────────────────────────────────
const es = new EventSource("/api/stream");
for (const type of ["clock", "beat", "transport.start", "transport.stop", "transport.seek", "transport.tempo"]) {
  es.addEventListener(type, (e) => onEnvelope(JSON.parse(e.data)));
}
es.onopen = () => {
  show(conn, `connected ✓ (EventSource resumes with Last-Event-ID automatically)`);
  refreshState(); // one-shot catch-up display: state reads are open, no auth
};
es.onerror = () => show(conn, "reconnecting… (the server replays missed envelopes)");

async function refreshState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const state = await res.json();
    if (state.bootId && state.bootId !== bootId) resetClockDomain(state.bootId);
    show(playing, state.playing ? "▶ playing" : "■ stopped");
    show(tempoEl, `${state.tempo} bpm`);
    show(position, state.position ?? "—");
  } catch { /* offline; the stream will re-display */ }
}

// ─── Conductor buttons — POST /api/transport/* (local machine only) ──────────
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (res.ok) {
    log(`POST ${path} ✓`);
    await refreshState();
  } else if (res.status === 403) {
    show(banner, "Conductor actions are local-only (you're on a remote device — you can still watch)");
  } else {
    const err = await res.json().catch(() => ({}));
    show(banner, `POST ${path} → ${res.status} ${err.error ?? ""}`);
  }
}
$("btnStart").addEventListener("click", () => post("/api/transport/start", { position: "0:0:0" }));
$("btnStop").addEventListener("click", () => post("/api/transport/stop"));
$("btnTempo").addEventListener("click", () => post("/api/transport/tempo", { bpm: Number(bpm.value) }));

// ─── Boot ────────────────────────────────────────────────────────────────────
refreshState();
syncLoop();
requestAnimationFrame(frame);
show(conn, "connecting…");
