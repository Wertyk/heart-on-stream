import type { WaveSample } from "../signal/index";
import type { OverlayWave, OverlayWavePoint } from "./index";

/** Keep a separate normalization history for each waveform and each session. */
export interface WaveNormalizationState {
  readonly history: readonly WaveSample[];
}

/** Epoch timestamps stay inside the domain; published points use elapsed ms. */
export interface WaveNormalizationOptions {
  readonly sessionStartUs: number;
  /** Inclusive rolling amplitude window; defaults to five seconds. */
  readonly windowUs?: number;
}

/** Explicit state makes batching and replay deterministic without a clock. */
export interface NormalizedWaveBatch {
  readonly wave: OverlayWave;
  readonly state: WaveNormalizationState;
}

/** Copy only animation fields, dropping invalid points and clamping amplitude. */
export function copyOverlayWave(wave: OverlayWave): OverlayWavePoint[] {
  return wave
    .filter(
      (point) =>
        Number.isFinite(point.v) &&
        Number.isFinite(point.atMs) &&
        point.atMs >= 0,
    )
    .map((point) => ({
      v: Math.max(0, Math.min(1, point.v)),
      atMs: point.atMs,
    }))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Normalize each new sample against its rolling min/max, including itself.
 * Flat or single-sample windows map to 0.5. Invalid/pre-session samples and
 * samples at or before the last accepted timestamp are ignored. Pass the
 * returned state to the next batch; inputs are never mutated.
 */
export function normalizeWave(
  samples: readonly WaveSample[],
  options: WaveNormalizationOptions,
  state: WaveNormalizationState = { history: [] },
): NormalizedWaveBatch {
  const windowUs = options.windowUs ?? 5_000_000;
  if (!Number.isFinite(options.sessionStartUs)) {
    throw new RangeError("Session start must be finite.");
  }
  if (!Number.isFinite(windowUs) || windowUs <= 0) {
    throw new RangeError("Normalization window must be positive and finite.");
  }

  const usable = (sample: WaveSample): boolean =>
    Number.isFinite(sample.value) &&
    Number.isFinite(sample.t) &&
    sample.t >= options.sessionStartUs;
  let history = state.history
    .filter(usable)
    .map((sample) => ({
      value: sample.value,
      stable: sample.stable,
      t: sample.t,
    }))
    .sort((a, b) => a.t - b.t);
  let lastTime = history.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
  const wave: OverlayWavePoint[] = [];

  for (const sample of samples.filter(usable).sort((a, b) => a.t - b.t)) {
    if (sample.t <= lastTime) continue;
    history = history.filter((past) => past.t >= sample.t - windowUs);
    history.push({ value: sample.value, stable: sample.stable, t: sample.t });
    let min = sample.value;
    let max = sample.value;
    for (const past of history) {
      min = Math.min(min, past.value);
      max = Math.max(max, past.value);
    }
    // Scaling first avoids overflow for large, opposite-sign amplitudes.
    const scale = Math.max(Math.abs(min), Math.abs(max));
    const v =
      min === max
        ? 0.5
        : (sample.value / scale - min / scale) / (max / scale - min / scale);
    wave.push({
      v: Math.max(0, Math.min(1, v)),
      atMs: (sample.t - options.sessionStartUs) / 1_000,
    });
    lastTime = sample.t;
  }

  history = history.filter((sample) => sample.t >= lastTime - windowUs);
  return { wave, state: { history } };
}
