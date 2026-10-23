import {
  ntpSlice,
  summarizeRtts,
  theilSenSlope,
  type NtpSample,
  type RttSummary,
} from "./estimator.js";

/**
 * ClockSync — HTTP NTP against the backend's Phase-1 clock API.
 *
 * Every probe is one `GET /api/sync` round trip:
 *   t0 (client, send) -> t1 (server, receive) -> t2 (server, reply) -> t3 (client, receive)
 * The server's processing dwell (t2 - t1) is measured, not assumed, so offsets
 * stay clean without any magic fudge (+500ms and friends are retired here).
 *
 * `offset` estimates serverMillis - clientMillis; `serverNow()` therefore says
 * what the SERVER says right now, in the client's own monotonic domain. This
 * is the conversion point every envelope deadline flows through.
 *
 * Phase 5 hardening: the two clocks' rates differ by their quartz spread
 * (tens of ppm), so a one-shot offset slowly goes stale. The last `windowSize`
 * probes feed a robust Theil–Sen regression (offset vs. client time) and
 * serverNow() extrapolates that drift — a server restart (bootId change)
 * clears the window because offsets across the boundary belong to different
 * monotonic frames.
 */

export type ClockSyncOptions = {
  /** Base URL of the Netronome server ("http://host:3000"). Default: same origin. */
  baseUrl?: string;
  /** HTTP client injection (tests). Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Monotonic client clock injection (tests). Default: performance.now. */
  now?: () => number;
  /** Probe cadence for the background loop (ms). Default 1000. */
  intervalMs?: number;
  /** Rolling window size for RTT/offset statistics. Default 16. */
  windowSize?: number;
  /** Drift-regression tuning (window-based rate fit, clamped). */
  drift?: DriftOptions;
  /** Called after each successful probe with the current estimate. */
  onUpdate?: (estimate: ClockEstimate) => void;
  /** Called when the server bootId changes (server restart detected). */
  onBootChange?: (bootId: string) => void;
};

/** Drift-regression knobs (all optional; sane defaults hold for LAN + WAN). */
export type DriftOptions = {
  /** Slope needs this many window samples before the rate is applied. Default 6. */
  minSamples?: number;
  /** …and this much sample-time spread (ms) — short spans fit noise. Default 20000. */
  minSpreadMs?: number;
  /** Sane clock-rate bound (ppm); typical quartz is ±50 ppm. Default 250. */
  maxRatePpm?: number;
};

export type ClockEstimate = RttSummary & {
  /** serverMillis - clientMillis (best, lowest-RTT sample in the window). */
  offset: number;
  /** Measured clock drift: offset ms gained per client-ms elapsed (ms/ms). */
  driftRate: number;
  /** Reported server bootId (null before the first reply). */
  bootId: string | null;
};

type SyncReply = { t1?: unknown; t2?: unknown; bootId?: unknown };

type WindowEntry = { t: number; offset: number; rtt: number };

/** Defaults for the drift regression (see DriftOptions). */
const DRIFT_DEFAULTS = { minSamples: 6, minSpreadMs: 20_000, maxRatePpm: 250 };

export class ClockSync {
  private readonly options: Required<Pick<ClockSyncOptions, "baseUrl">> &
  Pick<ClockSyncOptions, "fetch" | "now" | "onUpdate" | "onBootChange" | "intervalMs" | "windowSize" | "drift">;

  private window: WindowEntry[] = [];
  private rtts: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private bootId: string | null = null;
  /** Anchor: the best (lowest-RTT) offset sample in the window + its client time. */
  private anchor: { t: number; offset: number } | null = null;
  /** Fitted clock drift (offset ms per client ms), clamped to a sane band. */
  private driftRate = 0;
  private probing = false;
  private readonly bootListeners = new Set<(bootId: string) => void>();

  constructor(options: ClockSyncOptions = {}) {
    this.options = { baseUrl: options.baseUrl ?? "", ...options };
    if (options.onBootChange) this.bootListeners.add(options.onBootChange);
  }

  /** Fully resolved base URL (trailing slashes dropped). */
  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  /** Finer-grained estimate — null before the first successful probe. */
  estimate(): ClockEstimate | null {
    if (this.anchor === null || this.rtts.length === 0) return null;
    const summary = summarizeRtts(this.rtts);
    return { ...summary, offset: this.anchor.offset, driftRate: this.driftRate, bootId: this.bootId };
  }

  /** What the server's monotonic clock reads "now", or null before syncing. */
  serverNow(): number | null {
    if (this.anchor === null) return null;
    const t = this.now();
    // The anchor is exact AT its sample time; the fitted drift carries it
    // forward, so a 40 ppm clock spread stops accumulating error over minutes.
    return t + this.anchor.offset + this.driftRate * (t - this.anchor.t);
  }

  /** True once at least one probe has produced an offset. */
  get synced(): boolean {
    return this.anchor !== null;
  }

  /**
   * One NTP probe. Throws on network/payload failure; multiple failures are
   * soft — the caller decides whether to warn and keep marching.
   */
  async syncOnce(): Promise<ClockEstimate> {
    if (this.probing) return this.requireEstimate();
    this.probing = true;
    try {
      const fetchFn = this.options.fetch ?? globalThis.fetch;
      if (typeof fetchFn !== "function") throw new Error("no fetch available in this runtime");
      const t0 = this.now();
      const response = await fetchFn(`${this.baseUrl}/api/sync`, { cache: "no-store" });
      const t3 = this.now();
      if (!response.ok) throw new Error(`GET /api/sync failed: ${response.status}`);
      const reply = (await response.json()) as SyncReply;
      const t1 = reply.t1;
      const t2 = reply.t2;
      if (typeof t1 !== "number" || typeof t2 !== "number" || !Number.isFinite(t1) || !Number.isFinite(t2)) {
        throw new Error("GET /api/sync returned a malformed payload");
      }
      const sample: NtpSample = { t0, t1, t2, t3 };
      const bootId = typeof reply.bootId === "string" ? reply.bootId : null;
      const restarting = this.bootId !== null && bootId !== null && bootId !== this.bootId;
      if (restarting) {
        // Offset history spans the restart boundary — different monotonic
        // frames, so the window (and any fitted drift) is meaningless now.
        // Capture the restarted server's FIRST sample fresh.
        this.window = [];
        this.rtts = [];
        this.driftRate = 0;
        for (const listener of this.bootListeners) listener(bootId!);
      }
      this.bootId = bootId;
      this.absorb(sample);
      const estimate = this.requireEstimate();
      this.options.onUpdate?.(estimate);
      return estimate;
    } finally {
      this.probing = false;
    }
  }

  /** Begin the background probe loop. Safe to call twice. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop();
  }

  /** Stop the background probe loop. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Observe server restarts (the bootId reported by /api/sync changed). */
  onBootChange(handler: (bootId: string) => void): () => void {
    this.bootListeners.add(handler);
    return () => this.bootListeners.delete(handler);
  }

  /**
   * Re-sync burst — run right after a socket reconnect or a detected server
   * restart. `count` probes a few `gapMs` apart; failures are soft (the
   * background loop keeps marching).
   */
  async resync(count = 3, gapMs = 100): Promise<void> {
    for (let i = 0; i < count; i++) {
      try {
        await this.syncOnce();
      } catch {
        // Soft-fail: keep marching (the background loop re-probes anyway).
      }
      if (i < count - 1 && gapMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private absorb(sample: NtpSample): void {
    const windowSize = this.options.windowSize ?? 16;
    const slice = ntpSlice(sample);
    this.window.push({ t: sample.t3, offset: slice.offset, rtt: slice.rtt });
    this.rtts.push(slice.rtt);
    while (this.window.length > windowSize) this.window.shift();
    while (this.rtts.length > windowSize) this.rtts.shift();
    // Best offset in the window = the sample with the smallest round trip:
    // the shortest path has the least opportunity for queueing/interference.
    const best = this.window.reduce(
      (a, entry) => (entry.rtt < a.rtt ? entry : a),
      this.window[0]!,
    );
    this.anchor = { t: best.t, offset: best.offset };
    this.driftRate = this.fitRate();
  }

  /**
   * Theil–Sen slope of offset vs. sample time across the window, gated on
   * enough samples/spread and clamped to a sane rate band — a link whose
   * asymmetric queueing drifts can otherwise masquerade as clock rates.
   */
  private fitRate(): number {
    const drift = this.options.drift ?? {};
    const minSamples = drift.minSamples ?? DRIFT_DEFAULTS.minSamples;
    const minSpreadMs = drift.minSpreadMs ?? DRIFT_DEFAULTS.minSpreadMs;
    const maxRatePpm = drift.maxRatePpm ?? DRIFT_DEFAULTS.maxRatePpm;
    if (this.window.length < minSamples) return 0;
    const spread = this.window[this.window.length - 1]!.t - this.window[0]!.t;
    if (spread < minSpreadMs) return 0;
    const slope = theilSenSlope(this.window.map((e) => ({ x: e.t, y: e.offset })));
    const cap = maxRatePpm * 1e-6; // ppm -> ms/ms
    return Math.max(-cap, Math.min(cap, slope));
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.syncOnce();
    } catch {
      // Soft-fail: keep marching; `estimate()` still holds the last window.
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.options.intervalMs ?? 1000);
  }

  private requireEstimate(): ClockEstimate {
    const estimate = this.estimate();
    if (!estimate) throw new Error("clock estimate unavailable (no successful probe yet)");
    return estimate;
  }

  private now(): number {
    const injected = this.options.now;
    if (injected) return injected();
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    // Node fallback for renderer-less runtimes.
    return Date.now();
  }
}
