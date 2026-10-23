/**
 * Shape of the backend's `GET /api/state` response (apps/Backend at
 * src/api/transport.ts); mirrored so the SDK can parse it verbatim.
 */

export type ClientEstimateSnapshot = {
  socketId: string;
  rtt: number;
  oneway: number;
  jitter: number;
  samples: number;
  lastRttAt: number | null;
};

export type TransportStateSnapshot = {
  bootId: string;
  engineMode: boolean;
  minLead: number;
  playing: boolean;
  pendingStart: boolean;
  tempo: number;
  beats: number | null;
  position: string | null;
  at: number;
  upcomingTransitions: number | null;
  clients: ClientEstimateSnapshot[];
};

export function parseTransportState(payload: unknown): TransportStateSnapshot {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("GET /api/state returned a non-object payload");
  }
  const raw = payload as Record<string, unknown>;
  const required: Array<keyof TransportStateSnapshot> = [
    "bootId",
    "engineMode",
    "minLead",
    "playing",
    "tempo",
    "at",
  ];
  for (const key of required) {
    if (!(key in raw)) throw new Error(`GET /api/state is missing "${String(key)}"`);
  }
  return {
    bootId: raw.bootId as string,
    engineMode: raw.engineMode as boolean,
    minLead: raw.minLead as number,
    playing: raw.playing as boolean,
    pendingStart: raw.pendingStart as boolean,
    tempo: raw.tempo as number,
    beats: raw.beats == null ? null : (raw.beats as number),
    position: raw.position == null ? null : (raw.position as string),
    at: raw.at as number,
    upcomingTransitions:
      raw.upcomingTransitions == null ? null : (raw.upcomingTransitions as number),
    clients: Array.isArray(raw.clients)
      ? (raw.clients as ClientEstimateSnapshot[])
      : [],
  };
}
