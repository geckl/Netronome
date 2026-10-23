/**
 * @netronome/client — the client SDK for the backend-owned sync engine.
 *
 * Any app (React, vanilla, SSE in Phase 4) does exactly this:
 *   const client = new NetronomeClient({ url, role: "performer" | "conductor" });
 *   await client.connect();
 *   client.on("transport.start", (env) => { ... client.localAudioTime(env.at, ctx) ... });
 *   client.on("beat", (env) => scheduleClick(client.localAudioTime(env.at, ctx)));
 */

export { ClockSync, type ClockEstimate, type ClockSyncOptions, type DriftOptions } from "./clock-sync.js";
export {
  fitCtxRate,
  CtxRateCalibrator,
  type CtxRateFit,
  type CtxRateOptions,
  type CtxSample,
} from "./audio-rate.js";
export {
  median,
  ntpSlice,
  stdev,
  summarizeRtts,
  theilSenSlope,
  trimmedMean,
  type DataPoint,
  type NtpSample,
  type NtpSlice,
  type RttSummary,
} from "./estimator.js";
export { formatPosition, parsePosition, type PositionInput } from "./position.js";
export {
  ENVELOPE_EVENT,
  type BeatData,
  type Envelope,
  type EnvelopeType,
  type TransportSeekData,
  type TransportStartData,
  type TransportStopData,
  type TransportTempoData,
} from "./types.js";
export {
  NetronomeClient,
  type DeliveryMode,
  type EnvelopeArrival,
  type EnvelopeHandler,
  type NetronomeClientOptions,
  type NetronomeClientRole,
  type ResyncReason,
} from "./netronome-client.js";
export {
  parseTransportState,
  type ClientEstimateSnapshot,
  type TransportStateSnapshot,
} from "./transport-state.js";
