import {
  type BeatWindow,
  fillBeatWaveGaps,
  isValidPulseBpm,
} from "./fill-beat-gaps";
import type {
  OverlayIntensity,
  OverlayState,
  OverlayStatus,
  OverlayWave,
  PrivacyMode,
} from "./index";
import { copyOverlayWave } from "./normalize-wave";

/** The application maps session state here without exposing machine internals. */
export interface ProjectionInput {
  readonly status: OverlayStatus;
  readonly intensity: OverlayIntensity;
  /** Last usable rate, or an explicit invalidation; no stale fallback on none. */
  readonly pulse:
    | { readonly kind: "valid"; readonly bpm: number }
    | { readonly kind: "outOfRange" }
    | { readonly kind: "none" };
  readonly breathingRate: number | null;
  readonly beatWave: OverlayWave;
  readonly breathWave: OverlayWave;
  /** The application supplies elapsed time even when no SDK wave arrives. */
  readonly beatWindow: BeatWindow;
  readonly replay: boolean;
}

function projectPulse(
  pulse: ProjectionInput["pulse"],
): number | "out_of_range" | null {
  if (pulse.kind === "outOfRange") return "out_of_range";
  if (pulse.kind === "none" || !Number.isFinite(pulse.bpm)) return null;
  return isValidPulseBpm(pulse.bpm) ? Math.round(pulse.bpm) : "out_of_range";
}

/**
 * The sole overlay privacy policy: construct every field, including nested
 * points, from an allowlist. No input object is forwarded to the overlay.
 * Pausing disables fallback beats; replay remains visible in every mode.
 */
export function projectOverlay(
  input: ProjectionInput,
  mode: PrivacyMode,
): OverlayState {
  if (mode === "off" || mode === "highlightsOnly") {
    return { mode, replay: input.replay };
  }
  const beatWave = fillBeatWaveGaps(input.beatWave, {
    fromMs: input.beatWindow.fromMs,
    toMs: input.beatWindow.toMs,
    pulseBpm:
      input.status !== "paused" && input.pulse.kind === "valid"
        ? input.pulse.bpm
        : null,
  });
  const breathWave = copyOverlayWave(input.breathWave);
  if (mode === "vibe") {
    return {
      mode,
      beatWave,
      breathWave,
      intensity: input.intensity,
      status: input.status,
      replay: input.replay,
    };
  }
  return {
    mode,
    beatWave,
    breathWave,
    intensity: input.intensity,
    status: input.status,
    replay: input.replay,
    pulseBpm: projectPulse(input.pulse),
    breathingRate:
      input.breathingRate !== null && Number.isFinite(input.breathingRate)
        ? Math.round(input.breathingRate)
        : null,
  };
}
