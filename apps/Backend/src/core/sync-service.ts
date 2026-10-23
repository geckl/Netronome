import type { ClockSource } from "./clock.js";
import { summarizeRtts, type RttSummary } from "./estimator.js";

const DEFAULT_MAX_RTTS = 64;

export type ConnectionRecord = {
  socketId: string;
  /** Rolling window of measured RTT samples (ms), newest last. */
  rtts: number[];
  /** Server-side instant of the last RTT observation. */
  lastRttAt?: number;
  /** Raw client->server probe observation (t0 lives on the CLIENT clock). */
  lastProbe?: { t0Client: number; t1: number; at: number };
  connectedAt: number;
};

export type ConnectionEstimate = RttSummary & {
  socketId: string;
  lastRttAt: number | null;
};

/**
 * SyncService — per-connection clock/latency statistics.
 *
 * Phase-1 role: centralize every timing measurement the current handlers
 * make (the `calculate-latency` echo and the server's `ping` ack loop), so
 * the transport engine / dispatcher (Phase 2+) can consume real per-connection
 * latency instead of the global ratcheting budget in orchestra.ts.
 *
 * With NETRONOME_CLOCK_STATS=1 every event is logged, which doubles as the
 * Phase-0 precision baseline instrumentation.
 */
export class SyncService {
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(
    private readonly clock: ClockSource,
    private readonly stats = false,
    private readonly maxRtts: number = DEFAULT_MAX_RTTS,
  ) {}

  register(socketId: string): void {
    this.connections.set(socketId, { socketId, rtts: [], connectedAt: this.clock.now() });
    if (this.stats) console.log(`[clock-stats] connect    ${socketId}`);
  }

  unregister(socketId: string): void {
    const record = this.connections.get(socketId);
    this.connections.delete(socketId);
    if (this.stats) {
      if (!record) {
        console.log(`[clock-stats] disconnect ${socketId} (unknown connection)`);
        return;
      }
      const lifetime = Math.round(this.clock.now() - record.connectedAt);
      console.log(
        `[clock-stats] disconnect ${socketId} after ${lifetime}ms, samples=${record.rtts.length}`,
      );
    }
  }

  /**
   * Record a client->server echo probe. `t0Client` is in the CLIENT clock
   * domain; the server only stamps its own receive time — offset estimation
   * stays client-side, exactly like today. Recorded for observability only.
   */
  recordProbe(socketId: string, t0Client: number): void {
    const record = this.get(socketId);
    const t1 = this.clock.now();
    record.lastProbe = { t0Client, t1, at: t1 };
    if (this.stats) {
      console.log(
        `[clock-stats] probe       ${socketId}: serverNow=${t1.toFixed(1)} clientT0=${t0Client} (mixed domains; the client derives its offset)`,
      );
    }
  }

  /** Record one RTT observation (ms) for a connection, e.g. a server-initiated ping. */
  recordRtt(socketId: string, rtt: number): void {
    const record = this.get(socketId);
    record.rtts.push(rtt);
    record.lastRttAt = this.clock.now();
    if (record.rtts.length > this.maxRtts) record.rtts.shift();
    if (this.stats) {
      const summary = summarizeRtts(record.rtts);
      console.log(
        `[clock-stats] rtt         ${socketId}: ${Math.round(rtt)}ms -> median ${Math.round(summary.rtt)}ms ±${summary.jitter.toFixed(1)} (oneway ≈ ${Math.round(summary.oneway)}ms, n=${summary.samples})`,
      );
    }
  }

  /** Current latency estimate for a connection, or null when nothing is known yet. */
  estimate(socketId: string): ConnectionEstimate | null {
    const record = this.connections.get(socketId);
    if (!record || record.rtts.length === 0) return null;
    const summary = summarizeRtts(record.rtts);
    return { socketId, ...summary, lastRttAt: record.lastRttAt ?? null };
  }

  /** Ids of all tracked connections (registered connections only). */
  ids(): string[] {
    return [...this.connections.keys()];
  }

  /** One estimate per connection that has RTT samples — future `GET /api/clients`. */
  snapshot(): ConnectionEstimate[] {
    const out: ConnectionEstimate[] = [];
    for (const id of this.ids()) {
      const estimate = this.estimate(id);
      if (estimate) out.push(estimate);
    }
    return out;
  }

  /** Get-or-create: probes from unregistered ids (e.g. REST-only clients) still land somewhere. */
  private get(socketId: string): ConnectionRecord {
    let record = this.connections.get(socketId);
    if (!record) {
      record = { socketId, rtts: [], connectedAt: this.clock.now() };
      this.connections.set(socketId, record);
    }
    return record;
  }
}
