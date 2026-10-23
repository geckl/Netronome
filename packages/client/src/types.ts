/**
 * Wire-contract types of the Netronome server, mirrored for clients.
 *
 * Kept in lockstep with apps/Backend/src/core/types.ts (Phase 5 may move these
 * into a true shared package). One envelope shape is used on every transport
 * (Socket.IO now, SSE in Phase 4, REST payloads).
 *
 * All `at` values are milliseconds on the SERVER monotonic clock.
 */

export const ENVELOPE_EVENT = "envelope";

export type EnvelopeType =
  | "transport.start"
  | "transport.stop"
  | "transport.seek"
  | "transport.tempo"
  | "beat"
  | "clock"
  | (string & {}); // namespaced passthrough for app-level events

export type Envelope<K = unknown> = {
  /** Monotonic sequence number per dispatcher (per server run). */
  seq: number;
  type: EnvelopeType;
  /** Server-clock deadline: the instant `data` takes musical effect. */
  at: number;
  /** Recommended local schedule-ahead margin (ms) measured at emit time. */
  lead: number;
  data: K;
};

export type TransportStartData = {
  position: string; // bars:beats:sixteenths (Tone.js format)
  positionBeats: number;
  tempo: number;
};

export type TransportStopData = {
  position: string;
  positionBeats: number;
};

export type TransportSeekData = TransportStopData;
export type TransportTempoData = { bpm: number };
export type BeatData = { index: number };
