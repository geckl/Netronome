import type { ClockSource } from "./clock.js";
import type { EnvelopeDispatcher } from "./dispatcher.js";
import type { TransportEngine } from "./transport.js";
import type { Timers } from "./timers.js";
import { globalTimers } from "./timers.js";

/**
 * BeatScheduler — emits the quarter-note pulse as precisely-deadlined
 * `beat` envelopes, generated server-side from the transport timeline.
 *
 * The click *audio* itself is still scheduled by client apps against their
 * own AudioContext clock (from transport.* envelopes); this scheduler exists
 * so any third-party app can follow the beat with zero tempo math — it just
 * consumes envelopes.
 *
 * Drift-corrected by design: each emission decision is recomputed from the
 * real server clock, never accumulated through chained setTimeout deltas.
 */
export class BeatScheduler {
  private timer: unknown = null;
  /** Beat instant last handed to the dispatcher — guards against re-emission. */
  private lastBeatAt: number | null = null;

  constructor(
    private readonly engine: TransportEngine,
    private readonly dispatcher: EnvelopeDispatcher,
    private readonly clock: ClockSource,
    private readonly options: { padMs?: number; timers?: Timers } = {},
  ) {}

  start(): void {
    this.engine.on((event) => {
      switch (event.type) {
        case "start-scheduled":
          // Timeline is live from command time; pre-start probing jumps to the
          // head segment, so the first beat (the downbeat itself) arms here.
          this.sync();
          break;
        case "stopped":
          this.halt();
          break;
        case "tempo-scheduled":
        case "seek-scheduled":
          // Future segment changed — recompute the next beat from the timeline now.
          this.sync();
          break;
        default:
          break;
      }
    });
  }

  /** Cancel the pending emission timer and recompute from the timeline (if playing). */
  sync(): void {
    this.cancel();
    this.tick();
  }

  halt(): void {
    this.cancel();
    this.lastBeatAt = null;
  }

  private cancel(): void {
    if (this.timer === null) return;
    (this.options.timers ?? globalTimers).clear(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.engine.isPlaying()) return;
    let beatAt = this.nextCandidate(this.clock.now());
    // Skip beats that died long ago (machine stall, retro commit); keep marching.
    while (beatAt !== null && beatAt < this.clock.now() - 200) {
      this.lastBeatAt = beatAt;
      beatAt = this.nextCandidate(Math.max(this.clock.now(), beatAt + 1e-3));
    }
    if (beatAt === null) return;
    const emissionAt = beatAt - this.dispatcher.lead() - (this.options.padMs ?? 0);
    const delay = emissionAt - this.clock.now();
    const timer = this.options.timers ?? globalTimers;
    const due = beatAt!;
    if (delay > 0) {
      this.timer = timer.set(() => this.fire(due), delay);
    } else {
      // Emission window missed (jitter/late commit): deliver late rather than
      // drop — envelopes carry the exact `at`, receivers fast-forward.
      this.fire(due);
    }
  }

  private nextCandidate(from: number): number | null {
    const begin = this.lastBeatAt === null ? from : Math.max(from, this.lastBeatAt + 1e-3);
    return this.engine.nextBeatAt(begin);
  }

  private fire(at: number): void {
    this.timer = null;
    if (!this.engine.isPlaying()) return;
    this.lastBeatAt = at;
    this.dispatcher.emitNow("beat", at, { index: this.engine.indexAt(at) });
    this.tick(); // arm the next beat (recomputed from the clock, never accumulated)
  }
}
