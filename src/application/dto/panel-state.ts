import type { PrivacyMode } from "../../domain/privacy/index";
import type {
  CalibrationProgress,
  Highlight,
  SessionIntensity,
  SessionPhase,
} from "../../domain/session/index";
import type {
  ProcessingStatus,
  Reading,
  TalkingDetection,
  TimestampUs,
  ValidationState,
} from "../../domain/signal/index";

/** Failed port operations are visible to the streamer without exposing adapter details. */
export type SessionOperation =
  | "sourceStart"
  | "sourceStop"
  | "overlayPublish"
  | "marker"
  | "highlightLoad"
  | "highlightAppend"
  | "highlightUpdate"
  | "highlightDelete"
  | "recordingStart"
  | "recordingAppend"
  | "recordingStop"
  | "recordingDelete";

export interface PanelError {
  readonly operation: SessionOperation;
  readonly message: string;
}

/** A latched pause cleared by the streamer's Resume action. */
export type CapturePauseReason = "manual" | "unusableInput";

/**
 * Streamer-only snapshot contract; raw readings never go to the overlay.
 * Null means no reading/session is available, not a zero-valued measurement.
 * Errors retain the latest failure per operation for the current session.
 */
export interface PanelState {
  readonly active: boolean;
  readonly t: TimestampUs | null;
  readonly phase: SessionPhase | null;
  readonly progress: CalibrationProgress | null;
  readonly baselineBpm: number | null;
  readonly intensity: SessionIntensity;
  readonly pauseReason: CapturePauseReason | null;
  readonly talkingRecent: boolean;
  readonly privacyMode: PrivacyMode;
  readonly replay: boolean;
  readonly recording: boolean;
  readonly pulse: Reading | null;
  readonly pulseOutOfRange: boolean;
  readonly breathing: Reading | null;
  readonly talking: TalkingDetection | null;
  readonly validation: ValidationState | null;
  readonly processing: ProcessingStatus;
  /** Highlights produced by the current run, retained for its receipt. */
  readonly highlights: readonly Highlight[];
  readonly errors: readonly PanelError[];
}
