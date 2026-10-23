/**
 * AudioContext-vs-monotonic-clock rate calibration (Phase 5).
 *
 * `ctx.currentTime` is driven by the AUDIO HARDWARE clock, which can run tens
 * (sometimes hundreds) of ppm off the system monotonic clock — USB interfaces,
 * resampled device clocks, internal dial-back corrections. Deadlines mapped as
 * `ctxNow + deltaSec` are correct in the limit of a perfect ctx clock; with a
 * calibrated ratio `r = Δctx / ΔperfSec`, mapping becomes
 *
 *   audioTime(atMs) = ctxNow + (atMs - serverNowMs) / 1000 * r
 *
 * so long-horizon schedules (a full-bar pickup, a scheduled backtrack) stop
 * accumulating that hardware-clock error. Anchoring at the CURRENT ctx
 * reading each call means only the RATIO matters — absolute ctx-clock drift
 * is irrelevant.
 *
 * The fit is the Theil–Sen slope over (perf seconds, ctx seconds) samples:
 * robust, dependency-free, and precise enough that a modest sample spread
 * (seconds) resolves ppm-scale deviation with plain float64 math.
 */

export type CtxSample = {
  /** System monotonic clock in ms (performance.now()-domain). */
  perfMs: number;
  /** AudioContext time in seconds at that same instant. */
  ctxSec: number;
};

export type CtxRateFit = {
  /** Calibrated Δctx / ΔperfSec (1 == identical rates). */
  rate: number;
  /** Samples considered (0 = no fit usable, rate defaulted to 1). */
  samples: number;
  /** Time spread of the fit in perf-seconds. */
  spreadSec: number;
};

export type CtxRateOptions = {
  /** Sample spread (perf-seconds) required before the ratio is applied. Default 2. */
  minSpreadSec?: number;
  /** Sane deviation band around 1.0 (|rate - 1| clamp). Default 0.02 (±2%). */
  maxDeviation?: number;
};

const CTX_RATE_DEFAULTS = { minSpreadSec: 2, maxDeviation: 0.02 };

export function fitCtxRate(samples: CtxSample[], options: CtxRateOptions = {}): CtxRateFit {
  const minSpreadSec = options.minSpreadSec ?? CTX_RATE_DEFAULTS.minSpreadSec;
  const maxDeviation = options.maxDeviation ?? CTX_RATE_DEFAULTS.maxDeviation;
  if (samples.length === 0) return { rate: 1, samples: 0, spreadSec: 0 };
  const spreadSec = samples[samples.length - 1]!.perfMs / 1000 - samples[0]!.perfMs / 1000;
  if (samples.length < 2 || spreadSec < minSpreadSec) {
    return { rate: 1, samples: samples.length, spreadSec };
  }
  const slopes: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const dx = (samples[j]!.perfMs - samples[i]!.perfMs) / 1000;
      if (dx === 0) continue;
      slopes.push((samples[j]!.ctxSec - samples[i]!.ctxSec) / dx);
    }
  }
  if (slopes.length === 0) return { rate: 1, samples: samples.length, spreadSec };
  slopes.sort((a, b) => a - b);
  let rate = slopes[slopes.length >> 1]!;
  if (slopes.length % 2 === 0) rate = (slopes[(slopes.length >> 1) - 1]! + slopes[slopes.length >> 1]!) / 2;
  const cap = maxDeviation;
  rate = Math.max(1 - cap, Math.min(1 + cap, rate));
  return { rate, samples: samples.length, spreadSec };
}

/**
 * Rolling calibrator feeding localAudioTime. It keeps the oldest sample as the
 * spread anchor (dropping second-oldest ones when over budget) so the fit's
 * baseline stretches over minutes of playback while staying O(1) memory.
 */
export class CtxRateCalibrator {
  private samples: CtxSample[] = [];
  private readonly options: Required<CtxRateOptions>;

  constructor(options: CtxRateOptions = {}) {
    this.options = { ...CTX_RATE_DEFAULTS, ...options };
  }

  /** Current fit — 1.0 until enough spread has accumulated. */
  fit(): CtxRateFit {
    return fitCtxRate(this.samples, this.options);
  }

  /** Feed a fresh observation; duplicate instants are ignored (no new info). */
  observe(ctxSec: number, perfMs: number): CtxRateFit {
    const last = this.samples[this.samples.length - 1];
    if (!last || last.perfMs !== perfMs) {
      if (this.samples.length >= 16) this.samples.splice(1, 1); // keep the anchor, drop 2nd-oldest
      this.samples.push({ perfMs, ctxSec });
    }
    return fitCtxRate(this.samples, this.options);
  }
}
