import { Router } from "express";
import type { Request, Response } from "express";
import type { ClockSource } from "../core/clock.js";
import type { EnvelopeDispatcher } from "../core/dispatcher.js";
import type { TransportEngine } from "../core/transport.js";
import type { Envelope, TransportStartData } from "../core/types.js";
import type { Timers } from "../core/timers.js";
import { globalTimers } from "../core/timers.js";
import { formatPosition } from "../core/position.js";

/**
 * GET /api/stream — Server-Sent Events, the universal fallback channel.
 *
 * Every broadcast envelope rides the identical wire shape as Socket.IO
 * (`{seq, type, at, lead, data}` label one SSE frame):
 *
 *   id: 42
 *   event: transport.start      <- the envelope type
 *   data: {"seq":42,...}
 *
 * On top of the envelopes the hub periodically emits `clock` beacons
 * (`{type:"clock", at, data:{mono, epoch, bootId}}`) so SSE-only clients can
 * keep an offset estimate without leaving the stream.
 *
 * Resume: the hub keeps a ring buffer of recent broadcasts. Standard SSE
 * reconnects carry `Last-Event-ID` (plain `event:` + `id:` semantics), and
 * every buffered envelope with `seq > Last-Event-ID` is replayed before any
 * live traffic. When the buffer no longer covers the request (long
 * disconnect — or a restart, where the seq space restarted), the hub replays
 * everything it holds and re-establishes musical context with the same
 * late-joiner catch-up start envelope a fresh socket client receives.
 */

/** Structural sink for an SSE connection (an Express Response satisfies it). */
export type SseSink = {
  write(frame: string): unknown;
  on(event: string, listener: () => void): unknown;
};

export type SseHubOptions = {
  /** Ring buffer size (envelopes kept for `Last-Event-ID` replay). */
  ringSize?: number;
  /** Period between `clock` beacons (ms) while any client is connected. */
  beaconMs?: number;
  /** Period between SSE comment keep-alives (ms). */
  keepAliveMs?: number;
  /** Timer injection (tests); defaults to real timers. */
  timers?: Timers;
};

const DEFAULTS = { ringSize: 512, beaconMs: 2500, keepAliveMs: 15000 };

/** The clock surface the hub needs — ServerClock satisfies it (tests may fake it). */
export type SseClockSource = ClockSource & { toEpoch(mono: number): number; bootId: string };

type Client = { id: number; sink: SseSink };

export class SseHub {
  private readonly ringSize: number;
  private readonly beaconMs: number;
  private readonly keepAliveMs: number;
  private readonly timers: Timers;
  private readonly clock: SseClockSource;

  private readonly clients = new Map<number, Client>();
  private nextClientId = 0;

  /** Broadcast envelopes held for replay, oldest first. */
  private ring: Envelope[] = [];
  /** Lowest seq still held (the very first broadcast envelope has seq 1). */
  private ringStartSeq = 1;
  /** Highest seq ever broadcast (0 = none yet). Unicasts are not held. */
  private lastBroadcastSeq = 0;

  private engine: TransportEngine | null = null;
  private dispatcher: EnvelopeDispatcher | null = null;
  private beaconTimer: unknown = null;
  private keepAliveTimer: unknown = null;

  constructor(clock: SseClockSource, options: SseHubOptions = {}) {
    this.clock = clock;
    this.ringSize = options.ringSize ?? DEFAULTS.ringSize;
    this.beaconMs = options.beaconMs ?? DEFAULTS.beaconMs;
    this.keepAliveMs = options.keepAliveMs ?? DEFAULTS.keepAliveMs;
    this.timers = options.timers ?? globalTimers;
  }

  /**
   * Late construction wiring: the hub must exist before the dispatcher (its
   * broadcast hook holds the hub), while the hub's beacons/catch-up need the
   * dispatcher, and its catch-up needs the engine.
   */
  wire(engine: TransportEngine, dispatcher: EnvelopeDispatcher): void {
    this.engine = engine;
    this.dispatcher = dispatcher;
  }

  /** Connected client count (tests). */
  get size(): number {
    return this.clients.size;
  }

  /** Broadcast hook — called by the dispatcher for every envelope. */
  broadcast(envelope: Envelope): void {
    this.remember(envelope);
    for (const client of [...this.clients.values()]) {
      this.write(client.sink, envelope);
    }
  }

  /**
   * Adopt a new stream connection. `lastEventId` is the SSE `Last-Event-ID`
   * header (or `?lastEventId=` for hand-rolled clients); null for fresh joins.
   */
  connect(sink: SseSink, lastEventId: string | null): void {
    const id = ++this.nextClientId;
    this.clients.set(id, { id, sink });
    sink.on("close", () => this.drop(id));
    // Reconnect hint for browsers: resumption with Last-Event-ID is expected.
    sink.write("retry: 3000\n\n");

    const parsed = Number.parseInt((lastEventId ?? "").trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      // Replay window: everything after the client's last seen seq.
      if (this.lastBroadcastSeq === 0 || parsed >= this.ringStartSeq) {
        // Buffer covers the gap: replay each broadcast envelope with seq > id,
        // in order (unicast-only seqs may be absent — they had one receiver).
        for (const envelope of this.ring) {
          if (envelope.seq > parsed) this.write(sink, envelope);
        }
      } else {
        // Uncurable gap (long disconnect, or a restart reset the seq space):
        // replay what we hold and re-arm the client's musical context with the
        // late-joiner catch-up start.
        for (const envelope of this.ring) this.write(sink, envelope);
        this.sendCatchUp(sink);
      }
    } else if (this.engine?.isPlaying()) {
      // Fresh join mid-play: exactly what every late socket joiner gets.
      this.sendCatchUp(sink);
    }

    this.ensureTimers();
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private drop(id: number): void {
    this.clients.delete(id);
    if (this.clients.size > 0) return;
    if (this.beaconTimer !== null) {
      this.timers.clear(this.beaconTimer);
      this.beaconTimer = null;
    }
    if (this.keepAliveTimer !== null) {
      this.timers.clear(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private remember(envelope: Envelope): void {
    this.ring.push(envelope);
    this.lastBroadcastSeq = Math.max(this.lastBroadcastSeq, envelope.seq);
    while (this.ring.length > this.ringSize) {
      this.ring.shift();
      this.ringStartSeq = this.ring[0]?.seq ?? this.lastBroadcastSeq + 1;
    }
  }

  private ensureTimers(): void {
    if (this.clients.size === 0) return;
    if (this.beaconTimer === null) {
      const armBeacon = (): void => {
        this.beaconTimer = this.timers.set(() => {
          this.beaconTimer = null;
          if (this.clients.size === 0) return;
          const mono = this.clock.now();
          this.dispatcher?.emitNow("clock", mono, {
            mono,
            epoch: this.clock.toEpoch(mono),
            bootId: this.clock.bootId,
          });
          armBeacon();
        }, this.beaconMs);
      };
      armBeacon();
    }
    if (this.keepAliveTimer === null) {
      const armKeepAlive = (): void => {
        this.keepAliveTimer = this.timers.set(() => {
          this.keepAliveTimer = null;
          if (this.clients.size === 0) return;
          for (const client of [...this.clients.values()]) client.sink.write(": keep-alive\n\n");
          armKeepAlive();
        }, this.keepAliveMs);
      };
      armKeepAlive();
    }
  }

  /** Late-joiner catch-up start written directly to one stream (no broadcast). */
  private sendCatchUp(sink: SseSink): void {
    if (!this.engine || !this.dispatcher) return;
    const catchUp = this.engine.catchUp(this.dispatcher.lead());
    if (!catchUp) return;
    const adapter = {
      emit: (_event: string, payload: unknown): void => {
        this.write(sink, payload as Envelope);
      },
    };
    this.dispatcher.unicast(adapter, "transport.start", catchUp.at, {
      position: formatPosition(catchUp.positionBeats),
      positionBeats: catchUp.positionBeats,
      tempo: catchUp.tempo,
    } satisfies TransportStartData);
  }

  private write(sink: SseSink, envelope: Envelope): void {
    const frame =
      `id: ${envelope.seq}\n` +
      `event: ${envelope.type}\n` +
      `data: ${JSON.stringify(envelope)}\n\n`;
    try {
      sink.write(frame);
    } catch {
      // Dead connection — the close event unregisters it.
    }
  }
}

/** SSE request headers an intermediary would mangle. */
function sseHeaders(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

/** `Last-Event-ID` header (standard reconnects) or `?lastEventId=` escape hatch. */
function requestedId(req: Request): string | null {
  const header = req.get("Last-Event-ID");
  if (typeof header === "string" && header !== "") return header;
  if (typeof req.query.lastEventId === "string" && req.query.lastEventId !== "") {
    return req.query.lastEventId;
  }
  return null;
}

/**
 * Mount GET /api/stream.
 *
 * Reads are CORS-open: watching the orchestra is world-accessible; only the
 * POST conductor mutations are local-only.
 */
export function sseRoutes(hub: SseHub): Router {
  const router = Router();
  router.get("/stream", (req, res) => {
    sseHeaders(res);
    // The Response object satisfies SseSink structurally (write + on); the
    // hub owns framing, replay, beacons and cleanup from here.
    hub.connect(res as unknown as SseSink, requestedId(req));
  });
  return router;
}
