import type { Timers } from "../../src/core/timers.js";
import type { ClockSource } from "../../src/core/clock.js";

/**
 * Deterministic clock + timer queue for engine/scheduler tests.
 *
 * `stepTo` advances wall time, firing due timers (callbacks may schedule new
 * timers while running — the loop keeps going until nothing is due). This
 * makes the whole emission chain (start commit → beat envelopes → next beat)
 * fully synchronous and inspectable.
 */
export class FakeClock implements ClockSource {
  private current = 10_000; // start at a nonzero "boot" instant
  private queue: { at: number; fn: () => void; handle: number }[] = [];
  private nextHandle = 0;

  now(): number {
    return this.current;
  }

  /** Injectable timer set (engine, dispatcher, scheduler all accept a Timers). */
  timers(): Timers {
    return {
      set: (fn, ms) => {
        const handle = ++this.nextHandle;
        this.queue.push({ at: this.current + Math.max(0, ms), fn, handle });
        return handle;
      },
      clear: (handle) => {
        this.queue = this.queue.filter((t) => t.handle !== handle);
      },
    };
  }

  /** Advance to an absolute instant, firing all timers due along the way. */
  stepTo(target: number): void {
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.handle - b.handle);
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.current = next.at;
      next.fn();
    }
    this.current = Math.max(this.current, target);
  }

  /** Advance by a relative amount. */
  step(ms: number): void {
    this.stepTo(this.current + ms);
  }

  /** Are any timers pending? (idle assertions) */
  get hasTimers(): boolean {
    return this.queue.length > 0;
  }
}
