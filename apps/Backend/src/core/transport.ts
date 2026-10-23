import type { ClockSource } from "./clock.js";
import { formatPosition, parsePosition, type PositionInput } from "./position.js";

export type Segment = { anchorBeats: number; atMs: number; bpm: number };

export type TransportEvent =
  | { type: "start-scheduled"; at: number; positionBeats: number; tempo: number }
  | { type: "stopped"; at: number; positionBeats: number }
  | { type: "tempo-scheduled"; at: number; bpm: number }
  | { type: "seek-scheduled"; at: number; positionBeats: number };

/**
 * TransportEngine — the server-owned musical timeline.
 *
 * This is the single authority for "what position at which server instant".
 * Every transition (start / stop / seek / tempo) commits into a
 * piecewise-constant tempo timeline at COMMAND time, so musical position is
 * exactly computable at any server instant — past and future alike — which is
 * what makes late-joiner catch-up and fluid-tempo ramps correct without
 * consulting any client.
 *
 * Transitions are addressed by a server-clock instant `at`; commands arriving
 * without enough lead are clamped forward (never executed "retroactively").
 * A start lands in the future via `startAt`: positions before it stay frozen
 * (the transport is "playing" on the wire but not yet audible), and tempo /
 * seek commands addressed before `startAt` retune the head segment — a stop
 * therefore trivially kills an un-launched start (latest transition wins),
 * with zero commit timers to race.
 */
export class TransportEngine {
  private segments: { anchorBeats: number; atMs: number; bpm: number }[] = [];
  private lastTempo = 60;
  private lastPosition = 0;
  private playing = false;
  /** Server instant the current timeline begins; null once committed/stopped. */
  private startAtMs: number | null = null;

  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(
    private readonly clock: ClockSource,
    private readonly options: { minLead?: number } = {},
  ) {}

  // ─── Introspection ───────────────────────────────────────────────────────────

  get minLead(): number {
    return this.options.minLead ?? 250;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** True while the timeline is armed but its head instant is still in the future. */
  isPendingStart(): boolean {
    return this.playing && this.startAtMs !== null && this.clock.now() < this.startAtMs;
  }

  /** Future instant the current timeline begins (null when stopped). */
  startAt(): number | null {
    return this.playing ? this.startAtMs : null;
  }

  /** Current tempo: the baseline while stopped, the active segment bpm while playing. */
  currentTempo(): number {
    return this.playing ? this.bpmAt(this.clock.now()) : this.lastTempo;
  }

  /** Musical position (absolute beats) at a server instant. */
  beatsAt(t: number): number {
    const segment = this.segmentAt(t);
    return segment
      ? segment.anchorBeats + ((t - segment.atMs) / 60000) * segment.bpm
      : this.lastPosition;
  }

  /** Tempo (bpm) active at a server instant. */
  bpmAt(t: number): number {
    return this.segmentAt(t)?.bpm ?? (this.playing && this.segments[0] ? this.segments[0].bpm : this.lastTempo);
  }

  /**
   * Next strictly-after-`t` beat instant (server clock), or null when stopped.
   * Walks across tempo-segment boundaries correctly, including from instants
   * before the head segment (pre-start probing).
   */
  nextBeatAt(t: number): number | null {
    if (!this.playing || this.segments.length === 0) return null;
    let probe = t;
    for (let hops = 0; hops < 1000; hops++) {
      const segment = this.segmentAt(probe) ?? this.segments[0];
      const atMs = segment.atMs;
      const anchor = segment.anchorBeats;
      if (probe < atMs) {
        // Ahead of this segment's head: the head itself is a beat only when
        // it lands on an integer beat index.
        const headIndex = Math.round(anchor);
        if (Math.abs(anchor - headIndex) < 1e-9) return atMs;
        probe = atMs;
      }
      const beatsNow = this.beatsAt(probe);
      const nextIndex = Math.floor(beatsNow + 1e-9) + 1; // next strict beat index
      const candidate = atMs + (nextIndex - anchor) * (60000 / segment.bpm);
      const nextSegment = this.followingSegment(segment);
      if (nextSegment && candidate >= nextSegment.atMs - 1e-9) {
        probe = nextSegment.atMs; // hand over to the continuation segment
        continue;
      }
      return candidate;
    }
    return null; // absurd walk — bail out safely
  }

  /** Integer beat index at a beat instant produced by nextBeatAt. */
  indexAt(t: number): number {
    return Math.round(this.beatsAt(t));
  }

  /** Snapshot for `GET /api/state` and tests. */
  getState(now = this.clock.now()) {
    const beats = this.playing ? this.beatsAt(now) : this.lastPosition;
    return {
      playing: this.playing,
      pendingStart: this.isPendingStart(),
      tempo: this.playing ? this.bpmAt(now) : this.lastTempo,
      beats,
      position: formatPosition(beats),
      at: now,
      upcomingTransitions: this.playing ? this.segments.filter((s) => s.atMs > now).length : 0,
    };
  }

  // ─── Transitions ─────────────────────────────────────────────────────────────

  /**
   * Start (or restart) the transport at `at` (clamped to now + minLead),
   * from `position` when given, otherwise from the frozen position.
   * The timeline commits immediately; sound begins at `at`.
   */
  start(requestedAt: number, position?: PositionInput, bpm?: number): number {
    const at = this.clampForward(requestedAt);
    const positionBeats =
      position === undefined ? this.lastPosition : (parsePosition(position) ?? this.lastPosition);
    const tempo = bpm ?? this.lastTempo;

    this.segments = [{ anchorBeats: positionBeats, atMs: at, bpm: tempo }]; // fresh timeline (restart semantics)
    this.startAtMs = at;
    this.playing = true;
    this.lastTempo = tempo;
    this.emit({ type: "start-scheduled", at, positionBeats, tempo });
    return at;
  }

  /**
   * Stop immediately (legacy feel) — freezes the current position (frozen
   * resume value while a start is scheduled) as the next resume point.
   * With no commit timers, an un-launched start dies here for free.
   */
  stop(): { at: number; positionBeats: number } {
    const at = this.clock.now();
    const positionBeats = this.playing ? this.beatsAt(at) : this.lastPosition;
    this.playing = false;
    this.segments = [];
    this.startAtMs = null;
    this.lastPosition = positionBeats;
    this.emit({ type: "stopped", at, positionBeats });
    return { at, positionBeats };
  }

  /**
   * Schedule a tempo change at `at` (clamped to now + minLead). While playing
   * this appends (or coalesces) a timeline segment — position continuity is
   * guaranteed by construction. Addressed before a scheduled start, it retunes
   * that upcoming start. While stopped it becomes the baseline tempo the next
   * start adopts.
   */
  tempo(requestedAt: number, bpm: number): number {
    const now = this.clock.now();
    if (!this.playing) {
      this.lastTempo = bpm; // baseline change; legacy clients schedule their own audio graph
      const at = Math.max(requestedAt, now);
      this.emit({ type: "tempo-scheduled", at, bpm });
      return at;
    }
    const at = this.clampForward(requestedAt);
    if (this.startAtMs !== null && at < this.startAtMs) {
      // Retune the upcoming start (fluid-slider ramping before the downbeat).
      const head = this.segments[0];
      if (head) head.bpm = bpm;
      this.lastTempo = bpm;
      const committedAt = this.startAtMs;
      this.emit({ type: "tempo-scheduled", at: committedAt, bpm });
      return committedAt;
    }
    this.insertSegment({ anchorBeats: this.beatsAt(at), atMs: at, bpm });
    this.lastTempo = bpm;
    this.emit({ type: "tempo-scheduled", at, bpm });
    return at;
  }

  /**
   * Jump the musical position at `at`. While playing this inserts an anchor
   * segment (position jumps at exactly `at`, tempo continues seamlessly).
   * Addressed before a scheduled start it re-anchors the head segment.
   * While stopped it only moves the frozen resume point.
   */
  seek(requestedAt: number, position: PositionInput): number {
    const positionBeats = parsePosition(position);
    const now = this.clock.now();
    if (positionBeats === undefined) return requestedAt;
    if (!this.playing) {
      this.lastPosition = positionBeats;
      return Math.max(requestedAt, now);
    }
    const at = this.clampForward(requestedAt);
    if (this.startAtMs !== null && at < this.startAtMs) {
      // Re-anchor the upcoming start itself.
      const head = this.segments[0];
      if (head) {
        head.anchorBeats = positionBeats;
        this.lastPosition = positionBeats;
        this.reanchorForward(1);
      }
      const committedAt = this.startAtMs;
      this.emit({ type: "seek-scheduled", at: committedAt, positionBeats });
      return committedAt;
    }
    this.insertSegment({ anchorBeats: positionBeats, atMs: at, bpm: this.bpmAt(at) });
    this.emit({ type: "seek-scheduled", at, positionBeats });
    return at;
  }

  /**
   * Late-joiner catch-up, pure server logic:
   *  - scheduled start  → join that upcoming start (as if you'd been there in time);
   *  - playing          → start from the exact current position at now + lead;
   *  - stopped          → nothing to catch up with.
   */
  catchUp(leadMs?: number): { at: number; positionBeats: number; tempo: number } | null {
    if (!this.playing) return null;
    const now = this.clock.now();
    if (this.startAtMs !== null && now < this.startAtMs) {
      const head = this.segments[0];
      return {
        at: this.startAtMs,
        positionBeats: head.anchorBeats,
        tempo: head.bpm,
      };
    }
    return {
      at: now + (leadMs ?? this.minLead),
      positionBeats: this.beatsAt(now),
      tempo: this.bpmAt(now),
    };
  }

  // ─── Event plumbing ──────────────────────────────────────────────────────────

  /** Subscribe to committed/scheduled transitions (dispatcher, scheduler...). */
  on(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private clampForward(at: number): number {
    return Math.max(at, this.clock.now() + this.minLead);
  }

  private segmentAt(t: number): Segment | undefined {
    // Timeline is tiny (human-rate events) — a reverse scan is plenty fast.
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const segment = this.segments[i]!;
      if (segment.atMs <= t) return segment;
    }
    return undefined;
  }

  private followingSegment(segment: Segment): Segment | undefined {
    const index = this.segments.indexOf(segment);
    return index >= 0 ? this.segments[index + 1] : undefined;
  }

  /** Insert keeping `atMs` order, coalescing same-instant edits, re-anchoring later segments. */
  private insertSegment(segment: Segment): void {
    let index = this.segments.findIndex((s) => s.atMs > segment.atMs);
    if (index === -1) index = this.segments.length;
    if (index > 0 && Math.abs(this.segments[index - 1]!.atMs - segment.atMs) < 1) {
      this.segments[index - 1] = segment; // coalesce fluid-slider edits at the same instant
      this.reanchorForward(Math.max(1, index - 1));
    } else {
      this.segments.splice(index, 0, segment);
      this.reanchorForward(index + 1);
    }
  }

  /** Recompute anchors of all segments after `fromIndex` from their predecessor. */
  private reanchorForward(fromIndex: number): void {
    for (let i = Math.max(1, fromIndex); i < this.segments.length; i++) {
      const prev = this.segments[i - 1]!;
      const segment = this.segments[i]!;
      segment.anchorBeats = prev.anchorBeats + ((segment.atMs - prev.atMs) / 60000) * prev.bpm;
    }
  }
}
