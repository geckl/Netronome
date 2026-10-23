/**
 * Env-driven configuration for the backend.
 * The TransportEngine is the one transport mode (Phase 5 removed the legacy
 * branches); every knob is env-tunable with a production-sane default.
 */

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),

  /** "1" enables verbose clock/latency statistics logging (precision baseline). */
  clockStats: process.env.NETRONOME_CLOCK_STATS === "1",

  /**
   * Fluid-tempo coalescing window (ms): a `transport.tempo` envelope emitted
   * by the dispatcher never emits sooner than this long after the previous
   * one, so a fluid slider flooding the engine with retunes (~30-60 Hz)
   * cannot flood the wire. The timeline stays exact; only the envelope count
   * shrinks. 0 disables coalescing.
   */
  tempoCoalesceMs: num(process.env.NETRONOME_TEMPO_COALESCE_MS, 40),

  /**
   * CORS origin for both the Express API and the Socket.IO handshake.
   * Default: reflect any requesting origin (an open LAN server).
   * To restrict, set e.g.:
   *   NETRONOME_CORS_ORIGIN=http://127.0.0.1:4000,http://192.168.1.5:3000
   * (Replaces the previously hard-coded, typo'd origin "http://127.0.0.1/:5173".)
   */
  corsOrigin: process.env.NETRONOME_CORS_ORIGIN ?? "true",
};

/** Parse the CORS origin setting into a value accepted by `cors`/socket.io. */
export function parseCorsOrigin(value: string): boolean | string[] {
  if (value === "true" || value === "*") return true;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * When set to "1", the server does not open the Conductor UI in a browser on
 * boot (used by smoke tests and CI).
 */
export const skipOpen = process.env.NETRONOME_SKIP_OPEN === "1";
