import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { ClockSync, type ClockEstimate, type ClockSyncOptions } from "./clock-sync.js";
import { CtxRateCalibrator, type CtxRateFit } from "./audio-rate.js";
import { ENVELOPE_EVENT, type Envelope } from "./types.js";
import { parseTransportState, type TransportStateSnapshot } from "./transport-state.js";

/**
 * NetronomeClient — the one connection object every Netronome app uses.
 *
 * Responsibilities:
 *  1. Socket.IO connection per role ("performer" -> "/" [default], "conductor" -> "/conductor").
 *     The raw socket stays available for app-level plumbing (rosters, audio
 *     relay, WebRTC signaling) — those are not synchronization.
 *  2. HTTP NTP clock sync (HTTP against `GET /api/sync`) with a background loop
 *     and a robust drift model (Phase 5). `serverNow()` and `synced` are the
 *     only time facts the apps consult.
 *  3. Envelope consumption: every deadline-carrying server message arrives on
 *     the single `envelope` event; subscribe with `on(type, handler)` or
 *     `onEnvelope(theEverything handler)`. Exact replays (socket.io
 *     connection-state recovery, eager+scheduled double delivery) are
 *     dropped via a bounded seen-seq window; fresh envelopes that arrive
 *     out-of-seq order are processed — seq encodes commit order, not wire
 *     order, and a server restart resets them via the clock's bootId.
 *  4. Timeline conversion: `localAudioTime(envelope.at, audioContext)` maps a
 *     server-clock deadline onto the caller's own AudioContext clock,
 *     including the measured ctx-vs-monotonic rate (Phase 5). There are NO
 *     magic fudges (+500/+1000) left anywhere.
 *  5. Reconnect policy (Phase 5): on an automated socket reconnect (or a
 *     detected server restart) the client re-joins its roster channel and
 *     bursts a clock re-sync, then re-reads `GET /api/state` and reports via
 *     `onResync` — the server re-runs late-joiner catch-up for the app.
 *
 * Transport COMMAND emission rides the current server-contract events
 * (`conductor-start` / `conductor-stop` / `conductor-change-tempo`) with
 * server-clock targets.
 */

export type NetronomeClientRole = "performer" | "conductor";

/** Why an automatic resync ran (see NetronomeClientOptions.onResync). */
export type ResyncReason = "reconnect" | "restart";

/** How envelopes are delivered to this client from the dispatcher. */
export type DeliveryMode = "scheduled" | "on-receipt";

export type NetronomeClientOptions = {
  /** Server origin. Default: window.location.origin (buildless-script safe fallback: http://localhost:3000). */
  url?: string;
  /** Which namespace to join. Default "performer" (the root namespace "/"). */
  role?: NetronomeClientRole;
  /** Socket.IO path (server serves on "/socket.io" by default). */
  socketPath?: string;
  /** Socket.IO transport restrictions (e.g. ["websocket"] with no upgrade on the conductor plane). */
  transports?: string[];
  /** Disable Socket.IO transport upgrades (pairs with idempotent transports config). */
  upgrade?: boolean;
  /** Clock-sync tuning (see ClockSyncOptions). */
  sync?: Pick<ClockSyncOptions, "intervalMs" | "windowSize" | "onUpdate"> & {
    /** Gap (ms) between resync-burst probes after a reconnect/restart. Default 100. */
    resyncGapMs?: number;
  };
  /**
   * Opt into the server's fire-on-receipt delivery bias: envelopes reach this
   * client the moment they are built instead of at `at - lead`. Pick this only
   * for consumers that cannot schedule ahead.
   */
  deliveryMode?: DeliveryMode;
  /**
   * Called after an automatic resync (socket reconnect or server restart)
   * with the freshly-fetched transport state (null when the fetch failed);
   * the server has already re-run late-joiner catch-up by the time this fires.
   */
  onResync?: (state: TransportStateSnapshot | null, reason: ResyncReason) => void;
  /** Test injection: monotonic clock for the clock sync. */
  now?: () => number;
  /** Test injection: fetch for the clock sync AND state fetches. */
  fetch?: typeof fetch;
  /** Test injection: socket factory (bypasses the socket.io-client peer). */
  socketFactory?: () => Socket;
  /** Test injection: full clock replacement (overrides `now`/`fetch`/`sync`). */
  clockFactory?: () => ClockSync;
};

export type EnvelopeArrival = {
  /** Server-clock instant this client believes "now" was when it arrived (null pre-sync). */
  receivedAtServer: number | null;
};

export type EnvelopeHandler = (envelope: Envelope, arrival: EnvelopeArrival) => void;

export class NetronomeClient {
  /** The underlying Socket.IO socket (app-level plumbing rides here). */
  readonly socket: Socket;
  readonly clock: ClockSync;
  readonly role: NetronomeClientRole;
  readonly baseUrl: string;

  private readonly envelopeHandlers = new Set<EnvelopeHandler>();
  private readonly byType = new Map<string, Set<(envelope: Envelope) => void>>();
  /**
   * Replay window: seq values seen THIS boot. `seq` is assigned at envelope
   * BUILD time (commit order), so healthy wire arrival can invert across
   * types (a beat built at its timer-fire may land before a tempo committed
   * earlier whose emission window opens later). Watermarks (`seq <= last`)
   * would eat those fresh envelopes — Exact duplicates (socket.io recovery
   * replays, eager+scheduled double delivery) are what actually get dropped.
   */
  private readonly seenSeqs = new Set<number>();
  private connected = false;
  private wasConnected = false;
  private resyncing = false;
  private readonly deliveryMode: DeliveryMode;
  private readonly resyncGapMs: number;
  private readonly ctxRate = new CtxRateCalibrator();
  private readonly stateFetch?: typeof fetch;
  private readonly nowFn?: () => number;

  constructor(options: NetronomeClientOptions = {}) {
    this.role = options.role ?? "performer";
    this.baseUrl = options.url ?? defaultOrigin();
    this.deliveryMode = options.deliveryMode ?? "scheduled";
    this.resyncGapMs = options.sync?.resyncGapMs ?? 100;
    this.stateFetch = options.fetch;
    this.nowFn = options.now;

    const namespace = this.role === "conductor" ? "/conductor" : "/";
    this.socket =
      options.socketFactory?.() ??
      io(`${this.baseUrl}${namespace}`, {
        path: options.socketPath ?? "/socket.io",
        autoConnect: false,
        // The SDK owns exactly one socket per instance. Sharing a manager with
        // another io() call in the process would drop these options silently
        // (socket.io caches managers by origin) and the socket may never open.
        forceNew: true,
        ...(options.transports !== undefined
          ? { transports: options.transports, upgrade: options.upgrade ?? false }
          : {}),
      });

    this.clock = options.clockFactory?.() ?? new ClockSync({ baseUrl: this.baseUrl, ...syncOptions(options) });
    if (options.onResync) this.resyncHandlers.add(options.onResync);
    this.socket.on("connect", () => void this.handleConnected());
    this.clock.onBootChange(() => {
      // Server restart: the envelope sequence restarted with it, and every
      // roster/catch-up server state died with the old process.
      this.seenSeqs.clear();
      if (this.wasConnected) void this.resync("restart");
    });
    this.socket.on(ENVELOPE_EVENT, (payload: unknown) => this.routeEnvelope(payload));
  }

  /**
   * Connect the socket, then immediately sync the clock and start the
   * background loop. Resolves once the socket is connected (the clock may
   * still be pre-offset on a very slow link; `synced` flags that).
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const arrived = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        this.socket.off("connect", arrived);
        this.socket.off("connect_error", failed);
      };
      this.socket.once("connect", arrived);
      this.socket.once("connect_error", failed);
      this.socket.connect();
    });
    this.connected = true;
    this.wasConnected = true;
    this.seenSeqs.clear();
    try {
      await this.clock.syncOnce();
    } catch {
      // Keep connecting: the background loop will retry; apps check `synced`.
    }
    this.clock.start();
  }

  /** Disconnect the socket and stop the clock loop (subscriptions survive). */
  disconnect(): void {
    this.clock.stop();
    this.socket.disconnect();
    this.connected = false;
  }

  // ─── Reconnect policy (Phase 5) ─────────────────────────────────────────────

  private readonly resyncHandlers = new Set<
    (state: TransportStateSnapshot | null, reason: ResyncReason) => void
  >();

  /** Observe automatic resyncs (socket reconnects + server restarts). */
  onResync(handler: (state: TransportStateSnapshot | null, reason: ResyncReason) => void): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  private handleConnected(): void {
    // Delivery bias must be registered on EVERY (re)connect: a reconnect is a
    // brand-new server-side socket that holds no rooms.
    if (this.deliveryMode === "on-receipt") {
      this.socket.emit("delivery-mode", "on-receipt");
    }
    if (!this.wasConnected) return; // first connect: connect() owns the sequence
    void this.resync("reconnect");
  }

  /**
   * Automatic resync: re-join the roster channel (the server re-runs
   * late-joiner catch-up), burst a clock re-sync, then re-read and report the
   * authoritative transport state. Overlapping triggers coalesce.
   */
  private async resync(reason: ResyncReason): Promise<void> {
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      // Re-join BEFORE the clock burst so catch-up ASAP (deadlines map fine:
      // the old offset carries until fresh probes refine it).
      this.socket.emit(
        this.role === "conductor" ? "conductor-sync-orchestra" : "sync-orchestra",
        [],
      );
      await this.clock.resync(3, this.resyncGapMs);
      let state: TransportStateSnapshot | null = null;
      try {
        state = await this.fetchTransportState();
      } catch {
        // Stay null — the fan-out of transports recovered, /api/state didn't.
      }
      this.resyncHandlers.forEach((handler) => handler(state, reason));
    } finally {
      this.resyncing = false;
    }
  }

  // ─── Time ────────────────────────────────────────────────────────────────────

  /** True once the HTTP NTP loop has produced an offset. */
  get synced(): boolean {
    return this.clock.synced;
  }

  /** Latest estimate (offset/rtt/oneway/jitter) — null before the first probe. */
  estimate(): ClockEstimate | null {
    return this.clock.estimate();
  }

  /** Server-clock "now" (ms), or null before the first successful probe. */
  serverNow(): number | null {
    return this.clock.serverNow();
  }

  /**
   * The audio scheduling conversion — the ONLY place where a server instant
   * becomes a host time. Returns the deadline on the given AudioContext's
   * clock, in seconds. Each call also feeds the ctx-rate calibrator (Phase 5):
   * once enough samples have accumulated, the delta is scaled by the measured
   * Δctx/Δreal ratio, absorbing the audio hardware's clock spread. A returned
   * value <= ctx.currentTime simply fires immediately (late envelope), so
   * callers never wrap "play now" differently.
   */
  localAudioTime(atMs: number, ctx: BaseAudioContext): number {
    if (!this.synced) {
      throw new Error("NetronomeClient: clock not synced yet — no offset available");
    }
    const ctxNow = ctx.currentTime;
    const fit = this.ctxRate.observe(ctxNow, this.nowMs());
    const deltaSec = (atMs - (this.serverNow() as number)) / 1000;
    return ctxNow + deltaSec * fit.rate;
  }

  /** How far the ctx clock deviates from the monotonic clock right now. */
  audioCalibration(): CtxRateFit {
    return this.ctxRate.fit();
  }

  /** Monotonic client ms for the ctx-rate calibrator (mirrors ClockSync's now). */
  private nowMs(): number {
    if (this.nowFn) return this.nowFn();
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  // ─── Envelope consumption ────────────────────────────────────────────────────

  /** Subscribe to every envelope; returns an unsubscribe function. */
  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopeHandlers.add(handler);
    return () => this.envelopeHandlers.delete(handler);
  }

  /** Subscribe to one envelope type ("transport.start", "beat", ...). */
  on(type: string, handler: (envelope: Envelope) => void): () => void {
    let handlers = this.byType.get(type);
    if (!handlers) {
      handlers = new Set();
      this.byType.set(type, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) this.byType.delete(type);
    };
  }

  /** Replay-window ceiling: duplicates beyond this many newer arrivals are practically impossible. */
  private static readonly SEEN_WINDOW = 128;

  private routeEnvelope(payload: unknown): void {
    if (!isEnvelope(payload)) return;
    if (this.seenSeqs.has(payload.seq)) return; // recovery/eager+timed replay duplicate
    this.seenSeqs.add(payload.seq);
    if (this.seenSeqs.size > NetronomeClient.SEEN_WINDOW) {
      // Evict the OLDEST quarter (insertion order = arrival order); a genuine
      // replay always comes within this window of the newest arrivals.
      let evicted = 0;
      for (const seq of this.seenSeqs) {
        if (evicted++ >= NetronomeClient.SEEN_WINDOW / 4) break;
        this.seenSeqs.delete(seq);
      }
    }
    const arrival: EnvelopeArrival = { receivedAtServer: this.serverNow() };
    this.byType.get(payload.type)?.forEach((handler) => handler(payload));
    this.envelopeHandlers.forEach((handler) => handler(payload, arrival));
  }

  // ─── Transport state (read) ──────────────────────────────────────────────────

  /** `GET /api/state` — the engine's authoritative snapshot (+ who is connected). */
  async fetchTransportState(): Promise<TransportStateSnapshot> {
    const fetchFn = this.stateFetch ?? globalThis.fetch;
    if (typeof fetchFn !== "function") throw new Error("no fetch available in this runtime");
    const response = await fetchFn(`${this.baseUrl}/api/state`, { cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/state failed: ${response.status}`);
    return parseTransportState(await response.json());
  }

  // ─── Transport commands (conductor; server clamps deadlines) ─────────────────

  /**
   * Start the transport. `position` is a Tone.js "bars:beats:sixteenths"
   * string (or a plain beat count; undefined = resume). Resolves once the
   * server acks with the committed server-clock start instant.
   */
  sendStart(position?: string | number, onAck?: (committedAt: number) => void): void {
    const target = this.serverNow() ?? 0;
    this.socket.emit(
      "conductor-start",
      target,
      position ?? "",
      onAck ?? (() => {}),
    );
  }

  /** Stop the transport immediately (freezes the position server-side). */
  sendStop(): void {
    this.socket.emit("conductor-stop");
  }

  /**
   * Change the tempo. The server retunes the timeline (retuning the upcoming
   * start when addressed before it) and broadcasts `transport.tempo`.
   */
  sendTempo(bpm: number, position?: string, onAck?: (committedAt: number) => void): void {
    const target = this.serverNow() ?? 0;
    this.socket.emit("conductor-change-tempo", target, position ?? "", bpm, onAck ?? (() => {}));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function syncOptions(options: NetronomeClientOptions): Pick<ClockSyncOptions, "intervalMs" | "windowSize" | "onUpdate" | "now" | "fetch"> {
  return {
    ...(options.sync?.intervalMs !== undefined ? { intervalMs: options.sync.intervalMs } : {}),
    ...(options.sync?.windowSize !== undefined ? { windowSize: options.sync.windowSize } : {}),
    ...(options.sync?.onUpdate !== undefined ? { onUpdate: options.sync.onUpdate } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
}

function defaultOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") {
    return window.location.origin;
  }
  return "http://localhost:3000";
}

function isEnvelope(payload: unknown): payload is Envelope {
  if (typeof payload !== "object" || payload === null) return false;
  const raw = payload as Record<string, unknown>;
  return (
    typeof raw.seq === "number" && Number.isFinite(raw.seq) &&
    typeof raw.type === "string" &&
    typeof raw.at === "number" && Number.isFinite(raw.at) &&
    typeof raw.lead === "number" && Number.isFinite(raw.lead) &&
    "data" in raw
  );
}

