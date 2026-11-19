/** Chosen before a session and changeable while it runs; Vibe is the default. */
export type PrivacyMode = "off" | "vibe" | "numbers" | "highlightsOnly";

/** Relative pulse activity, never a physiological or medical classification. */
export type OverlayIntensity = "calm" | "elevated" | "spike";

/** Animation timing and amplitude without physiological readings or epoch times. */
export interface OverlayWavePoint {
  /** Normalized amplitude in 0–1, clamped upstream before publication. */
  readonly v: number;
  /** Milliseconds since the session started. */
  readonly atMs: number;
}

/**
 * A batch of normalized animation points in measurement order; empty when no
 * points are available. When the pulse waveform has gaps, the main process
 * synthesizes fallback beat points so Vibe never needs a pulse rate.
 */
export type OverlayWave = readonly OverlayWavePoint[];

/** Presentation status projected from the session phase without exposing readings. */
export type OverlayStatus = "calibrating" | "live" | "paused";

interface OverlayWaves {
  readonly beatWave: OverlayWave;
  readonly breathWave: OverlayWave;
  readonly intensity: OverlayIntensity;
  readonly status: OverlayStatus;
  readonly replay: boolean;
}

/** Animated activity with no physiological readings. */
export interface VibeOverlayState extends OverlayWaves {
  readonly mode: "vibe";
}

/**
 * Opt-in rate display in addition to the waves. Pulse is rounded BPM within
 * 40–110, or out_of_range; null means no usable estimate. Breathing is in
 * breaths/min. Confidence, baseline and SDK hints remain streamer-only.
 */
export interface NumbersOverlayState extends OverlayWaves {
  readonly mode: "numbers";
  readonly pulseBpm: number | "out_of_range" | null;
  readonly breathingRate: number | null;
}

/**
 * The only payload allowed across the overlay publication boundary. Every mode
 * carries the replay flag for its badge; Off and highlightsOnly carry only
 * mode and replay. Only Numbers includes pulse BPM and breathing rate.
 */
export type OverlayState =
  | { readonly mode: "off"; readonly replay: boolean }
  | VibeOverlayState
  | NumbersOverlayState
  | { readonly mode: "highlightsOnly"; readonly replay: boolean };

export {
  type BeatGapOptions,
  type BeatWindow,
  fillBeatWaveGaps,
} from "./fill-beat-gaps";
export {
  type NormalizedWaveBatch,
  normalizeWave,
  type WaveNormalizationOptions,
  type WaveNormalizationState,
} from "./normalize-wave";
export { type ProjectionInput, projectOverlay } from "./project-overlay";
