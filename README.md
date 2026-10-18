# Netronome 🎵

**Netronome** (a portmanteau of *Network* + *Metronome*) is a networked, multi-device metronome. One machine acts as the **Conductor**; any number of phones, tablets, or laptops on the same network connect as **Performers**. Every device then ticks the metronome — and plays the backing track — in sync, at the same absolute wall-clock instant.

It was built for rehearsing and jamming when musicians can't all be in the same room with a shared click track.

---

## How It Works

```
┌──────────────┐         Socket.IO          ┌───────────────┐         Socket.IO        ┌──────────────┐
│  Conductor   │ ─────────────────────────▶ │    Backend    │ ────────────────────────▶│  Performer   │
│ (host machine│  /conductor namespace      │ Express +     │   broadcast to all       │ (any device  │
│  only)       │ ◀───────────────────────── │  Socket.IO    │ ◀────────────────────────│  on the LAN) │
└──────────────┘                            │   port 3000   │                          └──────────────┘
                                            └───────────────┘
```

- The **Backend** is a Node.js server (Express + Socket.IO, port 3000). It serves both web apps and relays every command, clock probe, and audio buffer.
- The **Conductor** controls tempo, playback, the backing track, and live microphone audio.
- The **Performers** receive precisely-timestamped commands and schedule their local metronome click so that every beat happens simultaneously on all devices.

### Synchronization in a nutshell

1. **Clock sync** — when joining, each client fires 5 timestamped latency probes at the server, trims the outliers, and averages the remaining server-clock offsets.
2. **Scheduled commands** — the Conductor never says "start now". It says "start at time *T*" (a future timestamp on the server clock). Each performer converts *T* into its own clock domain (server offset ± one-way latency) and schedules its Tone.js transport to fire exactly then. Network jitter on delivery doesn't cause drift — the beat was scheduled ahead of time.
3. **Orchestra latency compensation** — the server tracks every performer's measured latency and keeps a latency budget (`ceil(maxLatency × 1.5)`). This budget pads tempo changes and late-joiner catch-up starts so nobody is left chasing the beat.
4. **Ongoing monitoring** — while the orchestra is playing, the server re-pings every performer every 10 seconds and updates the latency budget.

---

## Conductor Mode

The Conductor app lives at **`/conductor`** on the backend and is restricted to the machine running Netronome itself (anyone else gets a `403 — Access denied`). All other devices are directed to the Performer app.

### Connecting

- A **Join / Disconnect** button manages the Socket.IO connection (a loading spinner shows while connecting). Joining claims the conductor slot — only **one conductor can be connected**; a second one is rejected with an "A conductor is already connected!" toast.
- On join, the app requests microphone/audio access from the browser (a required user gesture), arms the Tone.js audio engine, and runs the clock synchronization before going live.

### Metronome & Tempo

- **Tempo slider** — 40 to 200 BPM (default 60).
- **Metronome mode segmented control** with three options:
  - **Off** — mutes the click (transport keeps running silently).
  - **Static** — tempo changes only apply when you release the slider. Good for slow, deliberate tempo changes.
  - **Fluid** — *every* slider movement is immediately broadcast as a tempo change, producing a continuous stream of tempo shifts displayed smoothly (e.g., ritardando/accelerando in real time).
- The click plays on every quarter note using a woodblock sample; the position is tracked in bars–beats–sixteenths.
- **Beat blink** — the app logo flashes white on every beat so the conductor has a visual pulse without listening.

### Transport Controls

- **Play / Stop** — starts and stops everyone in sync. Starting emits a target timestamp ~500 ms in the future (padded server-side by an additional 1 s lead), and every performer begins at the exact same instant from the same musical position (e.g., resuming mid-bar after a stop).
- Synchronized **seek**: click anywhere on the backing-track waveform and the whole orchestra jumps there together, keeping bar/beat position consistent for late arrivals.

### Backing Track

- **Upload Backing Track** — accepts a single `.mp3` or `.wav` file. It is streamed to the backend in chunks and forwarded to every performer, so all devices play the same audio.
- The Conductor gets an interactive **waveform overview** (via peaks.js): zoomable waveform, playhead with time readout, and click-to-seek that keeps everyone in sync.
- Playhead position is broadcast to performers every 0.5 s so their views track the conductor.
- A close button clears the track everywhere.

### Microphone Streaming

- **Select an Audio Source** dropdown lists every audio input on the machine (`-- No Microphone --` by default).
- Picking a device starts continuously streaming the conductor's microphone (1 s chunks) to all performers — useful for count-ins, spoken cues, or letting the band hear the conductor live.
- Selecting a source also opens an **input mixer** showing every channel of that device (mono, stereo L/R, or multi-channel USB interfaces):
  - Per-channel **fader**, **mute** and **pan** controls, each with a canvas level meter (RMS bar, peak overshoot, peak-hold).
  - A **master** strip with its own fader, meter and **monitor level** so the conductor can hear the mix locally (headphones recommended to avoid feedback).
  - The **broadcast is post-fader**: performers receive exactly the mix as set in the mixer (faders, pan, mute, master all applied).
  - Master/monitor levels persist across source changes, and the browser's voice processing (echo cancellation, noise suppression, auto gain) is disabled for raw musical input.
- **Streaming transport** — the mix travels to performers in two tiers:
  1. **WebRTC unicast** (primary): one peer connection per performer, fed from the mixer's master stream. Audio flows device-to-device at ~150–350 ms latency; the backend only relays signaling. Track swaps when the input device changes are seamless (`replaceTrack`), and connected performers stop receiving the legacy chunks.
  2. **Legacy 1-second chunks** (fallback): browsers without WebRTC (or while a WebRTC channel is still being established) keep receiving the old `audioStream` base64 chunks — automatically scoped to just those performers.

### Performers Panel

- A **Performers** button opens a drawer with a live roster table: each performer's **name** (auto-assigned as *Performer #1*, *Performer #2*, …), **status** with a color-coded dot (🟢 Connected / 🟡 Connecting / 🔴 Disconnected), and measured **latency in ms**.

### Share / QR Code

- A **Share** button shows the server's LAN address (`Connect to Netronome at <ip>:3000...`) alongside a **QR code** musicians can scan with a phone to join instantly. The QR image can be downloaded.

---

## Performer Mode

The Performer app is served at the backend's root (**`/`**) and is designed for phones and tablets — any device on the network can open it in a browser, or install it and run it standalone.

### Connecting

- A **Join** button starts the session: browser audio is unlocked (user gesture), the woodblock metronome player is created, clock sync runs, and the performer joins the orchestra.
- If the average measured latency is too high (> 1000 ms), joining aborts with a **"Failed To Connect: Average latency is too high…"** notification so you know to fix your network first.
- Once connected, the button becomes **Resync** — tap it any time (e.g., after switching Wi-Fi networks) to re-measure latency and re-sync with the orchestra.

### Automatic Catch-up

- Performers who join **while the orchestra is already playing** don't just join a stopped metronome: the server asks the conductor for the current playback state and sends a start command padded with the latency budget, so the newcomer begins at the correct position **mid-piece**, in phase with everyone else.
- New performers also automatically receive the current backing track.

### Playback

- Plays the woodblock click on every quarter note, scheduled with the same latency-aware target timestamps as everyone else. If a start command happens to arrive too late, the performer fast-forwards to the correct position rather than starting from bar 1.
- The app logo **blinks on every beat** — a silent, visual pulse.
- Received **backing tracks** (from the Conductor) are decoded and played synced with the transport, and removed when the conductor clears them.
- The conductor's **live microphone/mix stream** now arrives over a **WebRTC channel** whenever the browser supports it (~150–350 ms latency instead of the old ~1.5 s chunk delays); browsers without WebRTC fall back to the base64 chunk stream. Audio is unlocked by the Join/Resync tap (iOS Safari autoplay requirement). The **Volume** slider applies to click, backtrack and live stream alike; the live stream pauses while the browser tab is hidden.
- A **Delay slider (−500 to +500 ms, 1 ms steps)** shifts the click only, for personal phase alignment when standing apart from other players acoustically. Double-click the slider to reset it to 0 ms.

### Manual Calibration

- **Volume** slider (0–1) for the local click level.
- **Delay slider (−500 to +500 ms, 1 ms steps)** for personal phase alignment. Because sound takes time to travel, a performer standing far from the others can shift their click earlier/later to line up acoustically. Double-click the slider to reset to 0 ms.

---

## Running It

### Production (recommended)

```bash
# from the repo root
yarn install
yarn build        # builds the Conductor and Performer front-ends
yarn start        # starts the backend on port 3000 (runs with tsx, no precompile)
```

- The Conductor UI opens automatically in your browser, and is available at **http://localhost:3000/conductor**.
- Performers join by opening **http://<your-LAN-ip>:3000/** — the exact address is shown in the Conductor's Share dialog and QR code, and in the server console (`Connect to Metronome here: http://<ip>:3000`).
- The live mic/mix streams device-to-device over WebRTC on the LAN (no STUN/TURN needed); the backend relays signaling and serves both apps.

### Development

```bash
cd apps/Backend && yarn start          # backend on port 3000
cd apps/Conductor && yarn start        # or…
cd apps/Performer && yarn start        # CRA dev server on port 4000
```

> Both front-ends are configured with `PORT=4000`, so run **one at a time** in dev. The Conductor dev server proxies to the backend at `http://localhost:3000/conductor`.

### Packaging

The backend includes a `pkg` configuration to build self-contained binaries (`dist/`) that bundle both compiled front-ends — handy for distributing Netronome as a single executable.

---

## Tech Stack

| Layer      | Technologies |
|------------|-------------|
| Conductor  | React 19, TypeScript, Create React App, Chakra UI v3, Tone.js (transport/audio), Web Audio API + WebRTC (mic mixer & streaming), peaks.js (waveform), socket.io-client, react-icons |
| Performer  | React 19, TypeScript, Create React App, Tone.js, WebRTC (live audio), socket.io-client, react-toastify |
| Backend    | Node.js (ESM), Express 5, Socket.IO 4, tsx, `open`, `pkg` |

Both front-ends ship full **PWA manifests** (installable, standalone display) with icons, though no offline service worker is included.

## Repository Layout

```
Netronome/
├── apps/
│   ├── Backend/    # Express + Socket.IO server, relays everything, serves both apps
│   ├── Conductor/  # Conductor web app (tempo, transport, backtrack, mic, roster)
│   └── Performer/  # Performer web app (synced click, calibration, catch-up)
└── package.json    # monorepo build/start scripts
```

## Notes & Current Limitations

- Metronome clicks are fixed to **quarter notes** — there is no time-signature meter selection yet.
- The Conductor is limited to one instance and, by design, only the machine running Netronome can use Conductor mode.
- All devices must be reachable from the server over the local network (Socket.IO/WebSocket on port 3000).
- An experimental WebRTC-based latency layer (measuring one-way/asymmetric latency via data channels) exists in the code but is currently disabled.
