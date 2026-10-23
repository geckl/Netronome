# Netronome — Backend-Clock Migration Plan

> Move **all** synchronization and clocking into the Backend node server, so that *any*
> frontend app (the bundled Conductor/Performer, or a third-party app speaking plain
> Express APIs) can connect and receive precisely synchronized, absolutely-deadlined
> messages. The server becomes the only clock authority; clients become executors.

---

## 1. Where synchronization lives today

| Responsibility | Files (current) |
|---|---|
| Echo probe (`performance.now() - t` returned to caller) | `Backend/src/conductor.ts` (`calculate-latency`), `Backend/src/performer.ts` (same, ×2 variants) |
| Probe loop, offset estimation, clock-domain conversion (`synchronize`, `convertTime`) — **duplicated in both apps** | `Performer/src/util.tsx`, `Conductor/src/util.tsx` |
| Inline deadline math + Tone.js scheduling in feature code | `Conductor/src/App.tsx`, `Performer/src/SocketIO.ts`, `Performer/src/util.tsx` |
| Conductor → server transport commands | `Conductor/src/App.tsx` (`conductor-start`, `conductor-stop`, `conductor-change-tempo`) |
| Server-side deadline bumps & latency budget | `Backend/src/conductor.ts`, `Backend/src/orchestra.ts` (`totalLatency = ceil(maxLatency × 1.5)`) |
| Shared orchestra state (tempo, isPlaying, backtrack — musical position is **not** tracked) | `Backend/src/orchestra.ts` |
| Late-joiner catch-up (asks the conductor client for its state via a message that carries a whole callback function) | `Backend/src/performer.ts` (`status-update`), `Conductor/src/SocketIO.ts` |
| Periodic re-ping while playing (RTT only — refreshes the budget, never the clock offset) | `Backend/src/performer.ts` (`setInterval`, 10 s) |

### How the math works today (for the record)

1. **Probe.** Client sends `calculate-latency(start)` with `start = perfNow + 500`.
   Server acks with `serverPerfNow - start` = `offset + oneWay + 500`
   (where `offset = serverClock − clientClock`).
2. **Estimate offset.** Client computes `latency = (perfNow + 500) − start = RTT − 500`,
   then `serverOffset = latencyPlusOffset − latency/2` ≈ `realOffset + 500` (symmetric-link assumption).
   The `+500` therefore acts as an unconditional ~500 ms *safety predelay* baked into every
   offset estimate — and it is applied inconsistently across the codebase (some conversions
   add it again, some don't).
3. **Execute.** Each app re-derives its local deadline from `targetTime`:
   `targetLocal = T_server − (serverOffset ± oneWayEstimate)`, then converts that into
   AudioContext seconds with inline formulas like
   `(time − perfNow + Tone.immediate()*1000) / 1000` — with **three slightly different variants**
   scattered across `App.tsx` / `SocketIO.ts` / `util.tsx`.

### Problems (why this can't scale to arbitrary clients)

1. **Duplicated math.** Two near-identical `synchronize()` implementations (Performer/Conductor),
   and every third-party app would have to re-implement NTP + clock-domain conversion +
   audio scheduling. Nothing outside the two React apps can achieve the same precision today.
2. **Deadlines are derived per-device, not delivered.** `start`, `change-tempo`, and catch-up each
   reconstruct their own deadline from `targetTime`, per-client `serverOffset`,
   `oneWayOffsetAverage`, and `orc.totalLatency`. When those variants disagree (they already do),
   devices land off-beat.
3. **Magic numbers instead of measured latency.** `+500` (client-side fudge), `+1000`
   (server start bump in `conductor.ts:63`), `×1.5` (budget) — none tie the schedule margin
   to each connection's *measured* latency.
4. **Latency budget only ever grows** (`orchestra.ts:17`) and is global rather than
   per-connection: one Wi-Fi client inflates the budget for everyone, for the whole server run.
5. **Clock offset is frozen after join.** The 10-s ping loop updates RTT/budget only —
   `serverOffset.current` is never refreshed again, so oscillator drift accumulates silently
   over a session.
6. **Server doesn't own musical position.** Late-joiner catch-up must round-trip to the
   conductor client (the `status-update` event literally ships a callback function over the
   socket and the server invokes it with state it should already know) just to ask
   "where is the piece at?" — that belongs in the server.
7. **Precision is symmetric-latency-gated** (assumes `oneWay = RTT/2`). The experimental WebRTC
   `cyclicalSync` one-way estimator lives on as dead/commented code.
8. **Audio-timing inconsistencies.** Performer `start` sets `Tone transport bpm.value`
   immediately (not scheduled at the deadline), while `change-tempo` uses `setValueAtTime` —
   in-flight tempo corrections land at slightly different instants on different devices.

**Conclusion:** synchronization exists but it is *client-adapted* — every party comes up with
its own translation of a server-ish timestamp. The fix is to make the **server** the clock and
schedule authority, and make every app consume identical, already-deadlined envelopes.

---

## 2. Design goals

- **G1 — One clock.** The Backend server is the single authority. Every decision about *when*
  is computed on the server, in one place. Apps never derive deadlines.
- **G2 — Deadline-carrying envelopes.** Every synchronized message carries the server-clock
  instant at which it takes effect. Receiver logic is always "convert, then schedule",
  identically for every app.
- **G3 — Client-tech-agnostic API.** REST for probing/state/control, SSE for the event stream
  (fetch + EventSource only, any language), Socket.IO as the low-jitter path for the
  bundled apps.
- **G4 — Measured, per-connection margins.** The server continuously measures each
  connection's RTT and derives a schedule margin per client; a clean LAN gets tight margins,
  a bad Wi-Fi client only widens its own.
- **G5 — Server-owned musical position.** A piecewise-constant tempo timeline lives
  server-side: exact bar/beat/sixteenth at any server instant, no client consultation for
  late-joiner catch-up.
- **G6 — No breaking changes until the migration completes.** Legacy events stay alive
  (backed by the new engine) while the apps are migrated; old paths are deleted only in the
  final phase.

---

## 3. Target architecture

```
              ┌──────────────────────────── Backend (Node) ────────────────────────────┐
              │                                                                        │
              │  core/transport.ts        core/scheduler.ts       core/dispatcher.ts   │
              │  (tempo timeline,         (drift-corrected beat    (envelope build,     │
              │   position@server-time)    generation vs clock)     seq, fan-out, lead) │
              │         │                          │                        │          │
              │  core/sync-service.ts   core/registry.ts     core/clock.ts  ◀──────────┤
              │  (per-conn offset/rtt   (roster, roles,      (ServerClock:   bootId    │
              │   stats, re-probe loop)  statuses, single-    mono now(),     epoch)    │
              │                          conductor rule)      epoch anchor              │
              │                                    │                                   │
              │                            api/ (Express)  ── transport/control REST    │
              │  /api/clock  /api/sync  /api/state  /api/transport/*  /api/clients      │
              │  /api/stream (SSE: same envelopes + clock beacons + Last-Event-ID)      │
              │  namespaces/realtime.ts (Socket.IO adapter emitting the same envelopes) │
              └────────────────────────────────┬───────────────────────────────────────┘
                                               │  identical event envelopes over the wire
                 ┌─────────────────────────────┴──────────────────────────┐
                 │  packages/client — NetronomeClient (shared SDK)         │
                 │  sync() / estimate() / on(envelope)                     │
                 │  serverToLocal() / ctxTimeAt() / executeAt() + drift    │
                 └───────────┬─────────────────────────────┬───────────────┘
                             │                             │
                    Conductor app (React)          Performer app (React)
                    — consumes envelopes,          — consumes envelopes,
                      no clock math left             no clock math left

                 + Any third-party app: fetch + EventSource only, documented contract.
```

### 3.1 Module map (new files)

```
apps/Backend/src/
├── server.ts                      (slimmer: express wiring, static serving, app boot)
├── core/
│   ├── clock.ts                   ServerClock: monotonic now() (ms), epoch anchor, bootId
│   ├── sync-service.ts            per-connection offset/rtt estimation (rolling window,
│   │                              trimmed-median offset, jitter, drift slope, re-probe loop)
│   ├── registry.ts                ConnectionRegistry (absorbs `members[]` + `orc.conductor`)
│   ├── transport.ts               TransportEngine — server-owned piecewise-constant tempo
│   │                              timeline; start/stop/seek/tempo transitions; beatsAt(t),
│   │                              positionAt(t), late-joiner catchUp()
│   ├── scheduler.ts               server-side beat scheduler (drift-corrected timing loop)
│   ├── dispatcher.ts              envelope building (+seq), broadcast/unicast fan-out over
│   │                              Socket.IO namespaces and SSE channels, lead computation
│   └── types.ts                   wire contract types (below)
├── api/
│   ├── clock.ts                   GET /api/clock, GET /api/sync (REST probe)
│   ├── transport.ts               GET /api/state, POST /api/transport/{start,stop,seek,tempo}
│   ├── roster.ts                  GET /api/clients
│   └── sse.ts                     GET /api/stream (SSE: envelopes + clock beacons + keep-alive)
└── namespaces/
    └── realtime.ts                Socket.IO adapter: same handler semantics for both
                                   namespaces, emitting identical envelopes; keeps the
                                   WebRTC signaling relay + backtrack/audioStream relays
packages/client/                    NEW shared package "NetronomeClient" (TypeScript ESM,
                                    sockets optional) — consumed by Conductor, Performer,
                                    and available to third parties.
```

### 3.2 The wire contract

All times are **milliseconds on the server monotonic clock** (fractional allowed), except
fields explicitly marked `epoch`, which are wall-clock ms. One envelope shape is used on
every transport (REST payloads, SSE frames, Socket.IO events):

```ts
type Envelope<K = unknown> = {
  seq: number;      // monotonic per connection; clients de-dupe/resume with it
  type: "transport.start" | "transport.stop" | "transport.seek" | "transport.tempo"
      | "beat" | "clock" | "app.backtrack" | "app.audioStream" | string; // namespaced passthrough
  at: number;       // server-clock deadline: the instant `data` takes musical effect
  lead: number;     // recommended local schedule-ahead margin (ms), measured at emit time
  data: K;
};

// Command payloads (server → clients):
{ type: "transport.start", at, data: { position: "bars:beats:sixteenths", tempo } }
{ type: "transport.stop",  at, data: { positionAtStop } }
{ type: "transport.seek",  at, data: { position, tempo } }
{ type: "transport.tempo", at, data: { bpm } }                         // piecewise timeline event
{ type: "beat",            at, data: { index } }                       // single quarter-note instance
{ type: "clock",           at, data: { mono: number, epoch: number } } // SSE beacon
```

> Note on audio vs. beat events: the click sound itself is scheduled client-side against the
> AudioContext clock from `transport.*` envelopes (leading edges include everything a player
> needs). `beat` envelopes are the generic "synchronized pulse" for consumers that don't want
> any tempo math (blinkers, lights, external rigs) — they are still precisely deadlined.

### 3.3 Express API surface

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/clock` | GET | `{ mono, epoch, bootId }` — clock read, CORS open |
| `/api/sync` | GET | Probe: `{ t1: server-rx, t2: server-tx }` echoed for a compact NTP-style handshake. A few round trips (fetch loop, `cache: no-store`) gives a solid offset estimate for REST-only clients |
| `/api/state` | GET | Transport snapshot `{ playing, tempo, position, at, pending tempo events, clients[] }` |
| `/api/transport/start\|stop\|seek\|tempo` | POST | Drive the transport (conductor role); returns the committed `{ at, position }` |
| `/api/clients` | GET | Roster + per-client `{ role, status, rtt, oneway, offset }` stats |
| `/api/stream` | GET | **SSE**: all envelopes + periodic `clock` beacons; `Last-Event-ID` resume via a small server ring buffer |

Notes:
- `POST /api/transport/*` keeps the existing **local-only middleware** (`onlyLocal`) for
  conductor-mutating actions. Reads stay open so any device can observe state.
- CORS: GET endpoints open (`origin: *`); the Socket.IO origin stops being hard-coded to the
  typo'd `http://127.0.0.1/:5173` (env-configurable).
- Socket.IO remains the **primary low-jitter path**; SSE is the universal fallback.
  REST probe jitter on LAN is ~±2–5 ms — enough for beat visuals and acceptable for click
  timing thanks to schedule-ahead margins; precision-critical apps use the WS path.

### 3.4 What each core module owns

**`core/clock.ts` — ServerClock**

- `now()` — Node's `performance.now()` (monotonic; immune to host wall-clock steps).
- Publishes an epoch anchor (`{epoch, mono}` sampled at boot, bridged via `timeOrigin`), so
  external apps can convert server-time ↔ ISO-time when useful.
- `bootId` increments per process start and rides in `/api/clock`; clients detect a restart
  and re-sync (mitigates scheduling into a stale clock domain).

**`core/sync-service.ts` — connection timing intelligence (server side)**

- Probe endpoint in both REST and Socket.IO ack form, upgraded to a proper NTP-style
  4-timestamp handshake `(t0 client-sent, t1 server-rx, t2 server-tx, t3 client-rx)` —
  the server's own processing time (`t2 − t1`) is *measured*, not assumed to be zero
  (today's echo probe conflates it with link latency).
- Maintains per-connection rolling stats: trimmed-median **offset**, **RTT**, **jitter**,
  **drift slope**.
- Server-driven re-probe loop (replaces the per-performer `setInterval` inside
  `performer.ts`): fast burst at connect (e.g. 10 probes @ 50 ms), then ≤ 1 probe / 2.5 s
  during playback, feeding the dispatcher's `lead` calc.
- The same stats are exposed via `/api/clients` so the SDK (or any app) can piggyback on
  server-measured quality instead of guessing.

**`core/registry.ts` — connections, roles, statuses**

- Owns all connections (formerly `members[]` in `performer.ts` + `orc.conductor`).
- Roles: `performer` | `conductor` | `observer` (new: read-only/SSE-only apps).
- Enforces the single-conductor rule (behaviour-preserving) and publishes roster state as
  `app.roster` envelopes instead of the ad-hoc `update-members` fan-outs.

**`core/transport.ts` — TransportEngine (the mathematical heart)**

The musical position becomes a **piecewise-constant tempo timeline**:

```ts
type Segment = { anchorBeats: number; atMs: number; bpm: number }; // sorted by atMs
beatsAt(t) = anchorBeats + (t − atMs) / 60000 × bpm(segment(t))
```

Transitions, each carrying its own future `at` (every `at` must be ≥ now + minLead):
- `start(at, position)` — inserts an anchor segment; activates the beat scheduler.
- `stop(at)` — freezes `position = beatsAt(at)`.
- `seek(at, position)` — same freeze for resuming-from-there later.
- `tempo(at, bpm)` — appends a segment so position remains *exactly* correct at every
  instant, past and future — including for late joiners and in-flight fluid-tempo ramps.

Late joiner catch-up is pure server logic: `catchUp()` reads `beatsAt(now)` and emits
`transport.start {at: now + lead, position}` — no `status-update` round-trip to the
conductor client, no `totalLatency` arithmetic (the `performer.ts` lines that added
`totalLatency` to both time and position disappear).

Fluid-tempo handling (the slider broadcasting every delta) is simply a stream of `tempo`
segments. The dispatcher may coalesce envelopes above a rate (e.g. >25/s) with **no loss
of precision**, because the timeline itself is already exact — coalescing only reduces
message count, never correctness.

**`core/scheduler.ts` — beat scheduler**

- From the timeline, it emits `beat {index, at}` envelopes ~`lead + pad` ahead of `at`,
  with drift-corrected timing (a loop that re-checks the real server clock rather than
  trusting `setTimeout` accumulation).
- Precision-critical audio (click, backtrack, mic mix on `transport.*` envelopes) is
  scheduled client-side against the AudioContext clock — the scheduler never tries to
  "push" audio timing remotely; it only guarantees every app receives the same deadline.
- `beat` is the third-party showcase: a vanilla app renders a synced blinker with zero
  tempo math and zero Web Audio scheduling of its own.

**`core/dispatcher.ts` — envelope fan-out**

- Assigns monotonic `seq` per connection; builds envelopes from
  transport/scheduler/roster events.
- Computes `lead` from live per-connection stats:
  `lead = 250 ms floor + 1.0 × max(estimated one-way across active peers)`.
  This **replaces every magic number** (`+500`, `+1000`, `×1.5`).
- Fan-out to Socket.IO namespaces (`/` performers, `/conductor`) and all SSE channels
  through one broadcast bus; per-channel ring buffer enables `Last-Event-ID` resume.
- Targeted unicast for late joiners (catch-up start), backtrack fetches, RTC-adjacent
  app events, and command ACKs.

### 3.5 The shared SDK — `packages/client`

This is what makes "any frontend app" real: one package that both bundled apps and
third parties import instead of re-implementing network clock math.

```ts
export class NetronomeClient {
  constructor(opts: { url?: string; channel?: "ws" | "sse" | "rest"; role?: "performer" | "conductor" | "observer" });
  connect(): Promise<void>;

  sync(burst?: number): Promise<ClockEstimate>;  // run probes now, refresh offset estimate
  estimate(): ClockEstimate;                     // { offset, rtt, oneway, jitter, driftSlope, bootId }
  // background: continuous low-rate re-probe with linear drift correction

  on(type: string | "*", handler): Unsubscribe;  // envelopes, de-duped by (seq, bootId)

  serverToLocal(serverMs: number, marginMs?): number;            // → performance.now() domain
  ctxTimeAt(serverMs: number, ctx: BaseAudioContext, marginMs?): number; // → AudioContext seconds
  executeAt(serverMs: number, fn: () => void, opts?): { cancel(): void }; // drift-corrected timer
}
```

Execution detail (`ctxTimeAt`):

```ts
const targetPerf = serverMs − estimate().offset − margin;        // ms, performance.now() domain
return ctx.currentTime + (targetPerf − performance.now()) / 1000 − pad/1000;  // AudioContext sec
```

- Drift handling: the probe loop updates `offset`; `driftSlope = d(offset)/dt` is estimated
  by regression over samples, and `executeAt` applies it — so hour-long sessions hold
  their precision instead of silently skewing (today's offset is frozen at join).
- Tone.js interplay is documented: the SDK returns a raw AudioContext deadline; Tone's
  internal `lookAhead` (0.5 s in the bundled apps) must simply fit inside the schedule-ahead
  margin it hands to Tone — no change in how `scheduleRepeat`/`Player` are wired.

What this deletes from the apps (the actual payoff of the SDK):

| Current (duplicated per app) | Replacement |
|---|---|
| `Performer/src/util.tsx` — `synchronize`, `convertTime`, `togglePlayback` | SDK; the app keeps only Tone wiring (`Player`, `scheduleRepeat`, volume/delay UI) |
| `Conductor/src/util.tsx` — `synchronize`, `convertTime` | SDK |
| `Performer/src/SocketIO.ts` inline `start`/`change-tempo` math (3 variants of the same formula) | one `on("envelope")` handler using SDK helpers |
| `Backend/src/performer.ts` + `conductor.ts` handler blobs | thin `namespaces/realtime.ts` adapter calling core services |

### 3.6 Conductor / Performer app impact

- **User experience unchanged.** Same UI, buttons, sounds. Internally they now speak
  envelopes. Conductor's transport controls call `POST /api/transport/*` (or the WS
  equivalent).
- The conductor becomes just another consumer of `transport.*` envelopes — even its own
  playhead rides the same schedule — so conductor and performers can never disagree about
  tempo/position again.
- Performer's personal ±500 ms *Delay* slider remains — deliberately, the **only**
  client-domain correction (acoustic phase alignment), applied in local audio code,
  never in the shared clock path.
- Backtrack upload/remove, `audioStream`, and WebRTC signaling (`rtc-*`) are content
  relays, **not** clocking: they keep working during the migration and ride along as
  `app.backtrack` / `app.audioStream` envelopes at the end. The WebRTC media path itself
  is out of scope (device-to-device audio, server only relays signaling).

---

## 4. Migration plan (phased; each phase independently shippable)

### Phase 0 — Instrumentation & hygiene (≤ 0.5 day, zero behavior change)
- Timing/offset logs behind `NETRONOME_CLOCK_STATS=1` (current offsets, budget, RTT) to
  establish a precision baseline.
- Make the Socket.IO/Express CORS env-driven (removes the hard-coded typo'd origin).
- Merge gate: logs in place, behavior identical.

### Phase 1 — ServerClock + probe API (server-side only; no client changes)
- Add `core/clock.ts`, `core/sync-service.ts`, `api/clock.ts`; expose
  `GET /api/clock` + `GET /api/sync`; pipe Socket.IO `calculate-latency` handlers through
  the service (old clients keep working; estimation centralizes).
- Merge gate: unit tests of the 4-timestamp estimator under synthetic symmetric/asymmetric
  latency; server now measures RTT for every connection.

### Phase 2 — Server-owned TransportEngine (flag-gated; old clients keep working)
> **Status: implemented** (flag-gated behind `NETRONOME_NEW_ENGINE=1`; legacy mode passes the
> same integration check unchanged). See `test/transport.test.ts`, `test/scheduler.test.ts`,
> `test/dispatcher.test.ts` and `scripts/engine-check.ts` / `scripts/beat-check.ts`.
> One refinement vs. the plan text: the timeline commits at **command time** (`startAt` marks
> the future downbeat) instead of using a commit timer — commands addressed before `startAt`
> retune the head segment, commands after it keep their exact requested deadline, and an
> un-launched start dies with `stop()` because there is no timer to race.

- Add `core/transport.ts`, `core/registry.ts`, `core/dispatcher.ts`, `core/scheduler.ts`.
- Route conductor commands through the engine; deadline = `max(requested, now + lead)`
  (replaces `+1000` and `totalLatency` bumps). Late-joiner catch-up no longer consults
  the conductor. Expose `GET /api/state`.
- Legacy events (`start`/`stop`/`change-tempo` with old argument shapes) keep being emitted
  with **server-derived** target times, so current clients behave identically; new envelope
  emission is default-off behind `NETRONOME_NEW_ENGINE=1` until Phase 3.
- Merge gate: timeline unit tests (tempo boundaries, seek/stop chains, retro-time guards),
  ordering test ("start while a tempo change is pending"), catch-up test from mid-piece state.

### Phase 3 — Client SDK + migrate the apps
> **Status: implemented** (verified in-repo). Summary:
> - `packages/client` (`@netronome/client`, private, ESM to `dist/`): HTTP NTP `ClockSync`
>   (`GET /api/sync`, min-RTT offset over a rolling window, `bootId` restart detection),
>   `NetronomeClient` (role-based namespaces, `transport.*` envelope consumption with
>   seq dedup + boot-reset, `localAudioTime(at, ctx)` as the single server→audio-clock
>   conversion, `fetchTransportState()`, conductor command wrappers), plus lockstep
>   engine-estimator/position math. 32 vitest unit tests (fake socket/fetch/clock).
>   **Live checks:** `yarn verify` (20 checks — sync, envelopes, exact 666.7 ms deltas
>   @ 90 bpm, deadline `==` server ack, boot-restart seq reset) all pass.
> - Performer migrated: `Sync.ts` consumes envelopes (native `BufferSource` clicks +
>   `Tone.Draw` pulses, cancel via `source.stop(0)`); deleted `synchronize`, `convertTime`,
>   `cyclicalSync`, `WebRTC.ts`, `oneWayOffsetAverage`, all `+500` fudges, `scheduleRepeat`
>   beat math. Builds clean.
> - Conductor migrated: `ConductorSync.ts` consumes envelopes for its own timeline/clicks
>   (identical contract); commands via `sendStart/sendStop/sendTempo` (server clamps and
>   broadcasts — one code path); `status-update` consult deleted. Builds clean.
> - Late-joiner catch-up now rides a unicast `transport.start` envelope in engine mode
>   (performers AND conductors joining mid-play).
> - `NETRONOME_NEW_ENGINE` defaults ON (`"0"` disables explicitly); check scripts
>   auto-detect mode from `GET /api/state`. Batteries: engine 15/15, legacy 12/12,
>   beat-check exact 1000 ms deltas @ 60 bpm; Backend 56/56 unit tests green.
> - Remaining merge gate: the **manual two-device beat-onset bench** (user-side; target
>   < 8 ms on LAN). `POST /api/transport/*` lands in Phase 4.

### Phase 4 — Complete the "any app" Express API
> **Status: implemented** (verified in-repo). Summary:
> - `POST /api/transport/{start,stop,seek,tempo}` (`api/transport.ts`): guarded by the
>   extracted `onlyLocal` (loopback spellings + host LAN address; reads stay open),
>   routed through the TransportEngine, acknowledged with the **committed** dispatch
>   `{ at, position, positionBeats, tempo, playing, pendingStart }` (never the requested
>   values). Legacy `start`/`stop`/`change-tempo` broadcasts + orchestra bookkeeping
>   mirror the conductor socket handlers verbatim (removed in Phase 5); legacy-mode
>   servers answer `501`. `api/roster.ts` adds `GET /api/clients`
>   (registry roles merged with SyncService rtt/oneway stats).
> - `GET /api/stream` (`api/sse.ts`, `SseHub`): all broadcast envelopes as SSE frames
>   (`id: <seq>`, `event: <type>`, `data: <envelope>`), periodic `clock` beacons
>   `{mono, epoch, bootId}` (~2.5 s while consumers exist) + keep-alive comments on
>   one broadcast bus (dispatcher fans out to both namespaces AND the hub; beacons ride
>   the same seq space). `Last-Event-ID` resume: ring of the last 512 broadcasts,
>   replay of everything after the pin before any live traffic; uncurable gaps (long
>   disconnect / restart) replay what's held + the late-joiner catch-up `transport.start`,
>   which fresh mid-play joins also receive. `?lastEventId=` for hand-rolled clients.
> - Wire contract documented: `docs/HTTP-API.md` (endpoints, envelope contract, resume
>   semantics, SSE-vs-WS guidance).
> - `examples/vanilla-sse/` (`/examples/vanilla-sse` static mount, no build, no deps):
>   fetch + EventSource + WebAudio — beat blinker (rAF on local instants from
>   `/api/sync` offset) + click, transport display from envelopes, Start/Stop/tempo
>   conductor buttons via POST (403 banner on remote devices — the local-only rule as UX).
> - Beat scheduler on by default: the engine is ON by default and `BeatScheduler.start()`
>   is unconditional (inert until a transport start commits — pre-existing wiring, kept).
> - Batteries (fresh boots): new `scripts/sse-check.ts` **27/27** (frame shape, beacon
>   cadence, committed==envelope deadlines, exact beat deltas 90/150 bpm, seek
>   re-anchor cadence, **resume-after-reconnect with no missed/resent/out-of-order
>   ids**); engine-check 15/15; beat-check exact 1000 ms deltas @ 60 bpm; SDK `yarn
>   verify` 20/20 against the Phase-4 server; Backend **81/81** unit tests (25 new:
>   transport API engine+legacy, onlyLocal guard, roster, SseHub replay/beat/catch-up).
>   Example page verified live in-browser (SSE connected, offsets ~2 ms bridged,
>   manual tempo change propagated live to the page).
> - Remaining merge gate: the **two-device/browsers ±10 ms visual bench** on
>   `examples/vanilla-sse` (user-side).

- Beat scheduler on by default; `GET /api/stream` SSE with clock beacons + `Last-Event-ID`
  resume ring; `POST /api/transport/*` documented (keeps `onlyLocal`).
- Add `examples/vanilla-sse/` — a no-build, dependency-free page (fetch + EventSource +
  WebAudio) reproducing beat blinker + click, proving third parties need nothing but the
  HTTP contract.
- Merge gate: SSE end-to-end test, resume-after-reconnect test, example page verified in
  two browsers/devices (±10 ms visual acceptance).

### Phase 5 — Hardening & cleanup
- SDK: drift regression, ctx-vs-perf rate calibration, reconnect policy (auto-resync +
  re-fetch state), server-restart detection via `bootId`.
- Dispatcher: fluid-tempo coalescing throttle; optional per-client delivery bias
  ("fire-on-receipt" mode) for consumers that cannot schedule ahead.
- Remove the legacy emit branch and remaining dead experimental code.
- Update README ("How It Works") and the wire-contract docs; final precision bench.

> **Status: implemented (all work committed in this round; two-device precision bench is a manual, user-side gate).**
> - **SDK** (`packages/client`): `theilSenSlope` in `estimator.ts`; `ClockSync` fits offset-vs-sample-time
>   drift (`DriftOptions`: minSamples 6 / minSpread 20 s / clamp ±250 ppm) and extrapolates `serverNow()`;
>   a `bootId` change clears the window and history; `resync(count, gapMs)` re-anchor burst; new
>   `audio-rate.ts` (`fitCtxRate` + `CtxRateCalibrator`, ±2 % clamp) scales `localAudioTime` deltas by the
>   measured Δctx/Δreal ratio once ≥2 s of spread has accumulated. `NetronomeClient` grew `deliveryMode`,
>   `onResync`, `resyncGapMs`, and a reconnect policy (re-join roster → clock burst → re-fetch
>   `/api/state` → `onResync(state, reason)`; `"delivery-mode"` re-registered on every connect).
> - **Dispatcher**: envelopes are now BUILT at commit time (`seq` assigned at build — commit order, not
>   emission order); optional `eagerRoom` sink fires them the instant they are built for sockets that
>   joined `__eager__` via `"delivery-mode": "on-receipt"`; scheduled copies keep their `at − lead` slot
>   and dedupe by seq. Tempo coalescing: a new tempo event supersedes a pending un-emitted one, and the
>   newest pending never emits sooner than `lastTempoEmitAt + tempoCoalesceMs` (env
>   `NETRONOME_TEMPO_COALESCE_MS`, default 40, `0` disables), always ≤ `at` — timeline exact, single
>   spaced commands keep the classic slot; `transport.stop` cancels any pending tempo.
> - **seq semantics changed with the consumers**: build-order seq means healthy wire arrival can invert
>   ACROSS types (a beat built at its timer-fire may precede a tempo committed earlier whose emission
>   window opens later). The SDK's dedupe therefore switched from a `< lastSeq` watermark to a bounded
>   exact-duplicate seen-window (bootId/connect clears it); engine-check asserts seq uniqueness per
>   source + within-type growth. Consumers of the raw contract must dedupe the same way (documented in
>   `docs/HTTP-API.md`).
> - **Legacy removal**: `NETRONOME_NEW_ENGINE` is gone (`config.newEngine`, the legacy broadcast paths,
>   `legacyOnly`/501 responses, the legacy-mirror assertions + `transport-api-legacy.test.ts`, the dead
>   "engine visibility" branches in both apps). `orchestra.ts` slimmed to `{ conductor, backtrack }`
>   (roster → `ConnectionRegistry`, latency → `SyncService`, transport truth → engine). The performer
>   ping loop is engine-driven and cleared on disconnect. `/api/state` keeps `engineMode: true` as a
>   documented constant for older third-party parsers.
> - **Docs**: README "How It Works" rewritten (clock authority, envelope contract, SDK section, env
>   knobs incl. `NETRONOME_TEMPO_COALESCE_MS`); `docs/HTTP-API.md` dropped the 501/legacy paragraph and
>   gained the "Dispatcher behavior guarantees" section (coalescing, delivery bias, bootId regime).
> - **Gates**: Backend `tsc` clean + vitest 86/86; client `tsc` clean + vitest 45/45 + dist rebuilt;
>   root `yarn build` (SDK + both apps) Compiled successfully. Live battery on fresh boots: engine-check
>   (21 checks incl. coalescing burst + seq sanity), beat-check (1000 ms deltas), sse-check (full
>   replay/restart matrix), client-check — **all green**. Remaining (user-side): the two-device ±10 ms
>   visual bench + two-device click recording < 8 ms target.

### Estimated effort
Phases 0–2 ≈ 2–3 days · Phase 3 ≈ 2 days · Phase 4 ≈ 1.5 days · Phase 5 ≈ 1–2 days.
Total ≈ **1.5–2 working weeks** including tests.

---

## 5. Testing & simulation strategy

- **Unit (vitest)**: timeline math (position integration, tempo boundaries, seek/stop),
  offset/drift estimators on synthetic sample streams, envelope ordering/seq, catch-up math.
- **In-process fake-client harness with injected asymmetry**: Socket.IO middleware delaying
  sends per socket (`SIM_ONEWAY_IN_MS`, `SIM_ONEWAY_OUT_MS` — formalizing the one-way-delay
  experiments that today only exist as commented-out code). Assertions: every fake client
  executes `transport.start` within ±5 ms of `at` under 0 / ±50 / ±150 / ±300 ms
  asymmetric jitter, plus bursty-drop (Wi-Fi-ish) scenarios.
- **Real-device precision bench (documented procedure)**: two devices play the click into a
  shared recording; measure quarter-beat onset deltas (< 8 ms target on LAN).
- No phase merges without its test set.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Server restart resets `performance.now()` origin → clients schedule into a stale domain | `bootId` + epoch anchor in `/api/clock`; SDK detects discontinuity → full resync + state re-fetch |
| Audio-vs-wall-clock drift (>1 ms over long sessions, ctx clock rate error) | SDK samples ctx-vs-perf pairs and applies regression de-trending (Phase 5); Tone `lookAhead` interplay documented and kept within margins |
| WS vs SSE precision gap | SSE-only clients are fine for beat visuals (±2–5 ms probe jitter); precision-critical audio should use WS; documented |
| Fluid-tempo floods overwhelm slow clients | Dispatcher coalescing (timeline keeps exactness; only envelope count shrinks) + rate limit on `/api/transport/tempo` |
| Two conductors / role hand-off regressions | Registry enforces the single-conductor rule exactly as today; `POST /api/transport/*` keeps the local-host restriction |
| Legacy-path regressions during migration | Phase 2 keeps legacy event names/behavior behind the flag; the fake-client harness guards behavior; legacy branch removed only in Phase 5 |

---

## 7. Future options (explicitly out of scope here)

- Time-signature / meter configuration (timeline extends trivially with a `beatUnit` field).
- Tempo curves / automation (segment list → interpolation).
- WebTransport/QUIC transport upgrade (lower jitter than the SSE/WS layer).
- Server-side NTP/PTP exposure for non-JS rigs (the HTTP/SSE contract already covers most
  cases; worth it only if hardware integration became a real user story).
- Per-client delivery-bias scheduling for consumers that cannot schedule ahead.
