import type { OverlayWave, OverlayWavePoint } from "./index";
import { copyOverlayWave } from "./normalize-wave";

/** A half-open animation interval in milliseconds since the session started. */
export interface BeatWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** The caller retains the last usable estimate and clears it when unusable. */
export interface BeatGapOptions extends BeatWindow {
  readonly pulseBpm: number | null;
}

/** The SDK's supported pulse range, checked before rounding or synthesis. */
export function isValidPulseBpm(bpm: number | null): bpm is number {
  return bpm !== null && Number.isFinite(bpm) && bpm >= 40 && bpm <= 110;
}

/**
 * Fill uncovered time at 20 Hz using the last valid pulse rate. Each real point
 * covers 125 ms on either side, so samples at most 250 ms apart form a real
 * span with no synthetic points. Real points always win, including at coverage
 * boundaries. Sampling and beat phase are anchored to session time zero, so
 * splitting a window does not change the synthesized shape. A null or invalid
 * rate emits only real points. The result contains only points in [from, to).
 */
export function fillBeatWaveGaps(
  realWave: OverlayWave,
  options: BeatGapOptions,
): OverlayWave {
  const { fromMs, toMs, pulseBpm } = options;
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs < 0 ||
    toMs < fromMs
  ) {
    throw new RangeError(
      "Beat window must be finite, ordered and nonnegative.",
    );
  }
  const real = copyOverlayWave(realWave);
  const wave: OverlayWavePoint[] = real.filter(
    (point) => point.atMs >= fromMs && point.atMs < toMs,
  );
  if (!isValidPulseBpm(pulseBpm)) return wave;

  const periodMs = 60_000 / pulseBpm;
  let realIndex = 0;
  for (let atMs = Math.ceil(fromMs / 50) * 50; atMs < toMs; atMs += 50) {
    let nextReal = real[realIndex];
    while (nextReal && nextReal.atMs < atMs - 125) {
      realIndex += 1;
      nextReal = real[realIndex];
    }
    if (nextReal && nextReal.atMs <= atMs + 125) continue;

    const phase = (atMs % periodMs) / periodMs;
    // A short smooth beat followed by rest; amplitude is animation-only.
    const v = phase < 0.25 ? Math.sin((Math.PI * phase) / 0.25) ** 2 : 0;
    wave.push({ v: Math.max(0, Math.min(1, v)), atMs });
  }
  return wave.sort((a, b) => a.atMs - b.atMs);
}
