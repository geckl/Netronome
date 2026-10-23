import { randomUUID } from "node:crypto";

/**
 * ServerClock — the single monotonic time authority for the backend.
 *
 * `now()` returns Node's `performance.now()` (monotonic, fractional
 * milliseconds, immune to host wall-clock adjustments). Everything
 * time-related in the clock/sync engine is expressed on this server clock.
 *
 * The epoch anchor lets external apps bridge server-time <-> wall-clock when
 * needed, and `bootId` lets clients detect a server restart (clock domain
 * reset) so they can resync themselves.
 */
export type ClockInfo = {
  /** Monotonic server-clock ms since process start (fractional). */
  mono: number;
  /** Wall-clock epoch ms corresponding to `mono` (bridged anchor). */
  epoch: number;
  /** Unique per process start; changes whenever the server restarts. */
  bootId: string;
};

/** Minimal clock surface the sync/transport engine needs (fake-able in tests). */
export type ClockSource = { now(): number };

export class ServerClock {
  readonly bootId = randomUUID();
  /** `performance.timeOrigin`: wall-clock epoch ms of the monotonic zero point. */
  private readonly timeOrigin: number = performance.timeOrigin;

  /** Current monotonic server time in ms (fractional). */
  now(): number {
    return performance.now();
  }

  /** Convert a monotonic instant to wall-clock epoch ms. */
  toEpoch(mono: number): number {
    return this.timeOrigin + mono;
  }

  /** Convert wall-clock epoch ms back to monotonic server time. */
  fromEpoch(epoch: number): number {
    return epoch - this.timeOrigin;
  }

  /** Snapshot of the clock — the payload served at `GET /api/clock`. */
  info(): ClockInfo {
    const mono = this.now();
    return { mono, epoch: this.toEpoch(mono), bootId: this.bootId };
  }
}
