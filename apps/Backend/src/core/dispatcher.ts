import type { ClockSource } from "./clock.js";
import type { SyncService } from "./sync-service.js";
import { formatPosition } from "./position.js";
import type { TransportEvent } from "./transport.js";
import type { Timers } from "./timers.js";
import { globalTimers } from "./timers.js";
import type {
  Envelope,
  EnvelopeType,
  TransportStartData,
  TransportStopData,
  TransportTempoData,
} from "./types.js";
import { ENVELOPE_EVENT } from "./types.js";

/**
 * EnvelopeDispatcher — builds and delivers precisely-deadlined envelopes.
 *
 * Clients never derive deadlines: every envelope carries the server-clock
 * instant `at` at which it takes musical effect, plus a measured `lead` hint.
 * The dispatcher schedules envelope emission early enough that each
 * connection can receive the message before its deadline:
 *
 *   emission time = at - lead,  lead = minLead + 1.0 x max(one-way)
 *
 * Broadcasts ride a single generic `envelope` Socket.IO event so every
 * downstream surface (Socket.IO, SSE) carries the identical frame shape.
 *
 * Phase 5 hardening:
 *  - `eagerRoom` — fire-on-receipt delivery bias. Consumers that cannot
 *    schedule ahead (sockets that joined EAGER_ROOM via "delivery-mode")
 *    receive the envelope the moment it is BUILT, instead of at `at - lead`.
 *    They still deduplicate the timed copy by sequence number.
 *  - `tempoCoalesceMs` — fluid-tempo coalescing. A freshly scheduled tempo
 *    supersedes a pending (un-emitted) one, and the newest pending envelope
 *    never emits sooner than `tempoCoalesceMs` after the previous tempo
 *    emission (never later than `at`). The timeline stays exact; slider
 *    churn collapses on the wire.
 */

/** Minimal structural socket so the dispatcher has no hard socket.io dependency. */
export type EnvelopeSocket = { emit(event: string, ...args: unknown[]): void };

/** Sink the fire-on-receipt room fans out into (a pair of Socket.IO rooms). */
export type EnvelopeSink = { emit(event: string, payload: Envelope): void };

/** Consumers opting into delivery via the "delivery-mode" socket event join this room. */
export const EAGER_ROOM = "__eager__";

export type DispatcherOptions = {
  /** Low-level transport: called for every envelope emission. */
  send: (event: string, payload: Envelope) => void;
  /** Floor for emission lead (ms). */
  minLead?: number;
  /**
   * Minimum spacing between two emitted `transport.tempo` envelopes (ms).
   * 0 disables coalescing. Default 40 (≈ the highest envelope rate a fluid
   * tempo drag needs: 25/s).
   */
  tempoCoalesceMs?: number;
  /** Fire-on-receipt room sink (see EAGER_ROOM); optional. */
  eagerRoom?: EnvelopeSink;
  /** Timer injection (tests); defaults to real timers. */
  timers?: Timers;
};

const DEFAULT_MIN_LEAD = 250;
const DEFAULT_TEMPO_COALESCE = 40;

export class EnvelopeDispatcher {
  private seq = 0;
  /** Armed tempo emission (superseded by the next tempo-scheduled event). */
  private pendingTempo: { cancel(): void; at: number } | null = null;
  /** Emission instant (server clock) of the last tempo envelope. */
  private lastTempoEmitAt: number | null = null;

  constructor(
    private readonly clock: ClockSource,
    private readonly sync: SyncService,
    private readonly options: DispatcherOptions,
  ) {}

  /**
   * Emission lead (ms): floor + 1.0 x max measured one-way latency across
   * connections with samples. Replaces every magic number (+500/+1000/x1.5).
   */
  lead(): number {
    const minLead = this.options.minLead ?? DEFAULT_MIN_LEAD;
    const oneways = this.sync.snapshot().map((estimate) => estimate.oneway);
    const maxOneway = oneways.length > 0 ? Math.max(...oneways) : 0;
    return Math.round(minLead + maxOneway);
  }

  /** Monotonic envelope counter (diagnostics / client de-dup). */
  get sequence(): number {
    return this.seq;
  }

  /** Build an envelope; assign the next sequence number. Private by design. */
  private envelope(type: EnvelopeType, at: number, data: unknown): Envelope {
    return { seq: ++this.seq, type, at, lead: this.lead(), data };
  }

  /** Immediate emission — use only when `at` is now (e.g. stop). */
  emitNow(type: EnvelopeType, at: number, data: unknown): void {
    this.options.send(ENVELOPE_EVENT, this.envelope(type, at, data));
  }

  /**
   * Deliver an envelope so it lands before its own deadline: emission is
   * scheduled at `at - lead()` when the deadline is still in the future,
   * otherwise sent right away (legacy parity for commands committing late).
   * The envelope is built NOW so fire-on-receipt consumers get it instantly;
   * the scheduled copy dedupes on the client by sequence number.
   *
   * Returns the near-instant emission of a due-now deadline, else the armed
   * timer handle (used by the tempo coalescer to supersede pending entries).
   */
  schedule(at: number, type: EnvelopeType, data: unknown): unknown | null {
    const envelope = this.envelope(type, at, data);
    this.options.eagerRoom?.emit(ENVELOPE_EVENT, envelope);
    const delay = at - this.lead() - this.clock.now();
    if (delay <= 0) {
      this.options.send(ENVELOPE_EVENT, envelope);
      return null;
    }
    return (this.options.timers ?? globalTimers).set(
      () => this.options.send(ENVELOPE_EVENT, envelope),
      delay,
    );
  }

  /** Unicast an envelope to one connection (late joiners, targeted replies). */
  unicast(socket: EnvelopeSocket, type: EnvelopeType, at: number, data: unknown): void {
    socket.emit(ENVELOPE_EVENT, this.envelope(type, at, data));
  }

  /**
   * Transport-engine hook: translate engine events into envelopes.
   * Scheduled events (start/tempo/seek) are emitted early enough to beat
   * their own deadline; `stopped` carries `at = now` semantics and goes out
   * immediately.
   */
  handleEngineEvent(event: TransportEvent): void {
    switch (event.type) {
      case "start-scheduled":
        this.schedule(event.at, "transport.start", {
          position: formatPosition(event.positionBeats),
          positionBeats: event.positionBeats,
          tempo: event.tempo,
        } satisfies TransportStartData);
        break;
      case "stopped":
        this.pendingTempo?.cancel(); // a pending tempo belongs to a dead timeline
        this.pendingTempo = null;
        this.emitNow("transport.stop", event.at, {
          position: formatPosition(event.positionBeats),
          positionBeats: event.positionBeats,
        } satisfies TransportStopData);
        break;
      case "tempo-scheduled":
        this.scheduleTempo(event.at, event.bpm);
        break;
      case "seek-scheduled":
        this.schedule(event.at, "transport.seek", {
          position: formatPosition(event.positionBeats),
          positionBeats: event.positionBeats,
        } satisfies TransportStopData);
        break;
      default:
        break; // start-committed etc. — the beat scheduler subscribes itself
    }
  }

  /**
   * Coalesced tempo schedule (Phase 5): the newest tempo event supersedes any
   * pending (un-emitted) one; its emission waits at least `tempoCoalesceMs`
   * past the last tempo envelope emission, capped at `at` itself. A single
   * tempo change keeps its classic `at - lead` slot; only bursts coalesce.
   * The timeline is unaffected — the engine's segments stay exact.
   */
  private scheduleTempo(at: number, bpm: number): void {
    const coalesceMs = this.options.tempoCoalesceMs ?? DEFAULT_TEMPO_COALESCE;
    this.pendingTempo?.cancel();
    this.pendingTempo = null;

    if (coalesceMs <= 0) {
      this.schedule(at, "transport.tempo", { bpm } satisfies TransportTempoData);
      return;
    }

    const envelope = this.envelope("transport.tempo", at, { bpm } satisfies TransportTempoData);
    this.options.eagerRoom?.emit(ENVELOPE_EVENT, envelope);

    // Emission window: at least `coalesceMs` after the last emitted tempo
    // envelope (rate cap), no later than the envelope's own musical instant
    // (a late envelope would retune nothing).
    const target = at - this.lead();
    const floor = this.lastTempoEmitAt === null ? target : this.lastTempoEmitAt + coalesceMs;
    const fireAt = Math.min(Math.max(target, floor), at);
    const delay = fireAt - this.clock.now();
    if (delay <= 0) {
      this.lastTempoEmitAt = this.clock.now();
      this.options.send(ENVELOPE_EVENT, envelope);
      return;
    }
    const timers = this.options.timers ?? globalTimers;
    const handle = timers.set(() => {
      this.pendingTempo = null;
      this.lastTempoEmitAt = this.clock.now();
      this.options.send(ENVELOPE_EVENT, envelope);
    }, delay);
    this.pendingTempo = { cancel: () => timers.clear(handle), at };
  }
}
