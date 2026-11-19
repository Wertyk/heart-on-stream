import type {
  OverlayIntensity,
  OverlayState,
} from "../../domain/privacy/index";

export interface OverlayView {
  readonly visible: boolean;
  readonly replay: boolean;
  readonly paused: boolean;
  readonly content: "trace" | "readings" | null;
  readonly statusLabel: string | null;
  readonly statusDetail: string | null;
  readonly pulseLabel: string | null;
  readonly pulseFigure: string | null;
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
      content: null,
      statusLabel: null,
      statusDetail: null,
      pulseLabel: null,
      pulseFigure: null,
      breathingLabel: null,
      readingsCaption: null,
      intensity: "calm",
    };
  }
  const pulse = state.mode === "numbers" ? state.pulseBpm : null;
  const pulseFigure =
    typeof pulse === "number" ? String(Math.round(pulse)) : null;
  return {
    visible: true,
    replay: state.replay,
    paused: state.status === "paused",
    content:
      state.status === "live"
        ? state.mode === "vibe"
          ? "trace"
          : "readings"
        : null,
    statusLabel: state.status === "live" ? null : state.status,
    statusDetail:
      state.status === "calibrating" ? "Learning your baseline" : null,
    pulseLabel: pulseFigure
      ? `${pulseFigure} BPM`
      : pulse === "out_of_range"
        ? "out of range"
        : null,
    pulseFigure,
    breathingLabel:
      state.mode === "numbers" && state.breathingRate !== null
        ? `${Math.round(state.breathingRate)} breaths/min`
        : null,
    readingsCaption:
      state.mode === "numbers" ? "camera estimate · not medical" : null,
    intensity: state.intensity,
  };
}
