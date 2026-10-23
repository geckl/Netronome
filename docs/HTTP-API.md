# Netronome HTTP API — the "any app" contract

Everything an integrated client needs lives in plain HTTP: no socket.io, no SDK, no
build step. `examples/vanilla-sse/` is a dependency-free reference consumer of
exactly this document.

## Read side (CORS-open — any device may observe)

| Endpoint | Returns |
|---|---|
| `GET /api/clock` | `{ mono, epoch, bootId }` — server monotonic ms, epoch anchor (mono 0 ↔ wall-clock), boot id |
| `GET /api/sync` | `{ t1, t2, bootId }` — NTP-style probe: time the round trip client-side (`t0…t3`); the server's dwell `t2 − t1` is *measured*, so offsets stay clean. A few probes → solid offset estimate |
| `GET /api/state` | `{ bootId, engineMode, minLead, playing, pendingStart, tempo, beats, position, at, upcomingTransitions, clients[] }` |
| `GET /api/clients` | `{ bootId, count, clients: [{ id, role, name, status, rtt, oneway, jitter, samples, lastRttAt }] }` |
| `GET /api/stream` | **SSE** (see below) — all envelopes + clock beacons |

Positions are Tone.js-style `bars:beats:sixteenths` strings (0-indexed, 4 beats/bar,
4 sixteenths/beat); `at` values are **milliseconds on the server monotonic clock**
(fractional allowed). `GET /api/clock`'s `epoch − mono` is constant per boot and
bridges server mono ↔ wall time.

## Write side — `POST /api/transport/*` (local machine only)

Conductor-mutating actions are guarded by `onlyLocal`: requests must originate from
the machine running the server (loopback or its own LAN address) — remote devices
receive `403` and may only observe. Commands route through the server-owned
TransportEngine; the response is the **committed** dispatch (late commands clamp
forward to `now + minLead`, never executed retroactively):

```
POST /api/transport/start  { at?, position?, tempo? }   // arm/restart the transport
POST /api/transport/stop                            // freeze the position now
POST /api/transport/tempo  { bpm, at? }              // insert a tempo segment (position-continuous)
POST /api/transport/seek   { position, at? }          // jump the musical position at `at`
```

Every committed response carries the dispatch + post-state:

```json
{ "bootId": "…", "at": 123456.5, "position": "0:2:0", "positionBeats": 2,
  "tempo": 90, "playing": true, "pendingStart": true }
```

Defaults: omitted `at` → next commit window (`now + minLead`); `start` position
→ the frozen last position; tempo → the engine's current baseline (its last
commanded bpm). Errors: `400` for unparseable input (`at` not a number,
`position` neither a `bars:beats:sixteenths` string nor a beat count,
non-positive bpm).

## `GET /api/stream` — Server-Sent Events

The universal fallback channel. Every broadcast envelope rides the identical wire
shape as Socket.IO; the event name is the envelope type:

```
retry: 3000

id: 42
event: transport.start
data: {"seq":42,"type":"transport.start","at":173452.5,"lead":250,
       "data":{"position":"0:0:0","positionBeats":0,"tempo":60}}

id: 43
event: beat
data: {"seq":43,"type":"beat","at":173702.5,"lead":250,"data":{"index":0}}

id: 44
event: clock
data: {"seq":44,"type":"clock","at":175500,"lead":250,
       "data":{"mono":175500,"epoch":1792714838992.2,"bootId":"…"}}
```

Envelope contract (identical on every transport, see `core/types.ts`):

```
{ seq, type: "transport.start" | "transport.stop" | "transport.seek" | "transport.tempo"
       | "beat" | "clock" | tenant… , at, lead, data }
```

- `at` — server-clock deadline: the instant `data` takes musical effect. Clients
  map it onto their own clock via the `/api/sync` offset (or the `clock` beacons)
  and schedule visuals/audio there.
- `lead` — recommended schedule-ahead margin (ms), measured at emission:
  `minLead(250) + 1.0 × max(one-way across peers)`.
- `beat {index}` — the quarter-note pulse with **zero tempo math**: blinkers,
  lights and rig clocks consume it directly; precision audio is still scheduled
  client-side from `transport.*` envelopes against the AudioContext clock.
- `clock {mono, epoch, bootId}` — periodic beacon (~2.5 s while a stream has
  consumers) for offset estimation without leaving the stream. `bootId` changes
  whenever the server restarts → full clock-domain reset (drop de-dup state,
  re-probe).

**Resume.** Standard SSE semantics: reconnects carry `Last-Event-ID` (browsers do
this automatically for `EventSource`; non-browser clients may also pass
`?lastEventId=`). The server keeps a ring buffer of recent broadcasts and replays
every buffered envelope with `seq > Last-Event-ID`, in order, before any live
traffic. When the buffer no longer covers the gap (long disconnect, or a restart
reset the sequence space), the server replays what it holds and re-establishes
musical context with the same late-joiner catch-up `transport.start` envelope a
fresh socket client receives. Consume `clock` beacons locally to detect the
restart (bootId!) — a strict `seq <= lastSeq → drop` de-duper is only valid
within one boot.

Late joiners: an SSE client that connects (or resumes without enough history)
mid-play receives the catch-up `transport.start` at `now + lead` with the exact
live position — the same treatment every socket performer gets on `sync-orchestra`.

## Socket.IO vs SSE

Socket.IO remains the primary low-jitter path (and carries WebRTC signaling,
backtrack audio, roster updates); SSE is the simplified universal channel —
fine for beat visuals (REST probe jitter ~±2–5 ms on LAN) and acceptable for
click timing thanks to schedule-ahead margins. Precision-critical audio uses WS.

## Dispatcher behavior guarantees (Phase 5)

- **Fluid-tempo coalescing.** The dispatcher never emits `transport.tempo`
  envelopes faster than ~25/s (`NETRONOME_TEMPO_COALESCE_MS`, default 40; `0`
  disables). A fluid tempo drag supersedes pending un-emitted tempo envelopes:
  the **timeline stays exact** (the engine owns it), and the *newest* tempo
  state always reaches clients before it takes effect — only the envelope
  count shrinks. Single, spaced tempo changes keep their exact `at - lead`
  emission slot.
- **Fire-on-receipt delivery bias (`delivery-mode`).** A socket that emits
  `delivery-mode: "on-receipt"` joins the server's eager room and receives
  scheduled envelopes **the moment they are built** (at command-commit time)
  instead of at `at - lead` — for consumers that cannot schedule ahead. Timed
  centre copies still arrive (dedupe by `seq`); urgent emissions (stop) are
  immediate for everyone anyway.
- **Boot-regime identity.** `bootId` changes on every server restart; the
  envelope sequence space resets with it. Clients must re-anchor on the new
  boot (the SDK does: drops offsets, resets the `seq` guard, re-joins and
  re-syncs automatically).
