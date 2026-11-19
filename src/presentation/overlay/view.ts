import type {
  OverlayIntensity,
  OverlayState,
} from "../../domain/privacy/index";

export interface OverlayView {
  readonly visible: boolean;
  readonly replay: boolean;
  readonly paused: boolean;
  readonly statusLabel: string | null;
  readonly pulseLabel: string | null;
  readonly breathingLabel: string | null;
  readonly readingsCaption: string | null;
  readonly intensity: OverlayIntensity;
}

/** Off and Highlights only suppress every mark, including the replay badge. */
export function overlayView(state: OverlayState | null): OverlayView {
  if (!state || state.mode === "off" || state.mode === "highlightsOnly") {
    return {
      visible: false,
      replay: false,
      paused: false,
      statusLabel: null,
      pulseLabel: null,
      breathingLabel: null,
      readingsCaption: null,
      intensity: "calm",
    };
  }
  return {
    visible: true,
    replay: state.replay,
    paused: state.status === "paused",
    statusLabel: state.status === "live" ? null : state.status,
    pulseLabel:
      state.mode === "numbers" && state.pulseBpm !== null
        ? state.pulseBpm === "out_of_range"
          ? "out of range"
          : `${Math.round(state.pulseBpm)} BPM`
        : null,
    breathingLabel:
      state.mode === "numbers" && state.breathingRate !== null
        ? `${Math.round(state.breathingRate)} breaths/min`
        : null,
    readingsCaption:
      state.mode === "numbers" ? "camera estimate · not medical" : null,
    intensity: state.intensity,
  };
}
