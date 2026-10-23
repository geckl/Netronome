/**
 * Wire-contract types shared by the backend engine (and, in Phase 3, the
 * client SDK). One envelope shape is used on every transport (Socket.IO,
 * SSE in Phase 4, REST payloads).
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
