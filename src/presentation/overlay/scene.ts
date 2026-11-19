import type { OverlayState } from "../../domain/privacy/index";
import { emptyWaveBuffer, receiveWave, type WaveBuffer } from "./wave-buffer";

export interface OverlayScene {
  readonly state: OverlayState | null;
  readonly beat: WaveBuffer;
  readonly breath: WaveBuffer;
}

export function emptyScene(): OverlayScene {
  return { state: null, beat: emptyWaveBuffer(), breath: emptyWaveBuffer() };
}

/** Privacy/status changes discard old animation so it cannot reappear on resume. */
export function receiveSnapshot(
  scene: OverlayScene,
  state: OverlayState,
  nowMs: number,
): OverlayScene {
  if (
    state.mode === "off" ||
    state.mode === "highlightsOnly" ||
    state.status === "paused"
  ) {
    return { ...emptyScene(), state };
  }
  const previous = scene.state;
  const reset =
    previous?.mode !== state.mode ||
    (previous &&
      "status" in previous &&
      (previous.status === "paused" ||
        (previous.status !== "calibrating" && state.status === "calibrating")));
  return {
    state,
    beat: receiveWave(
      reset ? emptyWaveBuffer() : scene.beat,
      state.beatWave,
      nowMs,
    ),
    breath: receiveWave(
      reset ? emptyWaveBuffer() : scene.breath,
      state.breathWave,
      nowMs,
    ),
  };
}

/** Keep the last privacy choice while disconnected, but never show stale rates. */
export function disconnectScene(scene: OverlayScene): OverlayScene {
  return scene.state?.mode === "numbers"
    ? {
        ...scene,
        state: { ...scene.state, pulseBpm: null, breathingRate: null },
      }
    : scene;
}
