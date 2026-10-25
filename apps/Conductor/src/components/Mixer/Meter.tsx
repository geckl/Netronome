import { useEffect, useRef } from "react";

/**
 * Canvas level meter driven by an AnalyserNode.
 * Shows an RMS bar with a peak overshoot region and a decaying peak-hold line.
 * Shared dB scale: -60 dB .. 0 dB mapped to the full bar height.
 */
export const Meter = ({
  getAnalyser,
  width = 14,
  height = 150,
}: {
  getAnalyser: () => AnalyserNode | null;
  width?: number;
  height?: number;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      return;
    }

    // Draw in physical pixels so it stays crisp on HiDPI screens
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx2d.scale(dpr, dpr);

    let data = new Float32Array(1024);
    let peakHold = 0;
    let peakHoldTime = 0;
    let raf = 0;
    // -60..0 dB → 0..1
    const toLevel = (x: number) =>
      x <= 0.00001 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(x) + 60) / 60));

    const colorFor = (fraction: number) =>
      fraction > 0.9 ? "#e74c3c" : fraction > 0.7 ? "#f1c40f" : "#2ecc71";

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);

      const analyser = getAnalyser();
      if (!analyser) {
        return;
      }
      if (data.length !== analyser.fftSize) {
        data = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(data);

      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        sum += v * v;
        const abs = Math.abs(v);
        if (abs > peak) {
          peak = abs;
        }
      }
      const rmsLevel = toLevel(Math.sqrt(sum / data.length));
      const peakLevel = toLevel(peak);

      // Peak hold: rises instantly, decays after 800 ms
      if (peakLevel >= peakHold || now - peakHoldTime > 800) {
        peakHold = peakLevel;
        peakHoldTime = now;
      }

      const w = width;
      const h = height;

      // Background track
      ctx2d.fillStyle = "#0b1116";
      ctx2d.fillRect(0, 0, w, h);

      // RMS bar (drawn bottom-up so green→red zone colors stay fixed)
      const rmsHeight = rmsLevel * h;
      const step = 2;
      for (let y = 0; y < rmsHeight; y += step) {
        ctx2d.fillStyle = colorFor(y / h);
        ctx2d.fillRect(0, h - y - step, w, step);
      }

      // Dim overshoot up to the current peak (0.7 dB-fraction of brightness)
      if (peakLevel > rmsLevel) {
        ctx2d.globalAlpha = 0.35;
        const start = Math.floor(rmsHeight / step) * step;
        for (let y = start; y < peakLevel * h; y += step) {
          ctx2d.fillStyle = colorFor(y / h);
          ctx2d.fillRect(0, h - y - step, w, step);
        }
        ctx2d.globalAlpha = 1.0;
      }

      // Peak-hold line
      if (peakHold > 0) {
        ctx2d.fillStyle = "#FFFFFF";
        ctx2d.fillRect(0, Math.max(0, h - peakHold * h - 1), w, 2);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [getAnalyser, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        borderRadius: 4,
        border: "1px solid #1b2830",
      }}
    />
  );
};

export default Meter;
