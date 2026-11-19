import type { SessionFrame, TimestampUs } from "../signal/index";

export { RollingBaseline } from "./rolling-baseline";
export {
  type CalibrationProgress,
  type PulseComparison,
  type SessionEvent,
  type SessionInput,
  SessionMachine,
  type SessionSnapshot,
  type SessionStep,
} from "./session-machine";
export {
  type SessionIntensity,
  SpikeDetector,
  type SpikeEvent,
} from "./spike-detector";
export {
  createSpikePolicy,
  DEFAULT_SPIKE_POLICY,
  type SpikePolicy,
} from "./spike-policy";

/** Session progression and interruptions; Off is a privacy mode, not a phase. */
export type SessionPhase =
  | "warming"
  | "baselining"
  | "live"
  | "paused"
  | "out_of_range";

/** The recording marks the recorder-only tail and final export duration outside the session machine. */
export type SessionRecord =
  | SessionFrame
  | { readonly kind: "drain" }
  | { readonly kind: "end"; readonly durationUs: number };

/**
 * A local spike receipt, retained even when an OBS chapter cannot be created.
 * Only relative change is stored; no absolute pulse or baseline is needed.
 */
export interface Highlight {
  /** Measurement time of the spike, in epoch microseconds. */
  readonly t: TimestampUs;
  /** Session start in epoch microseconds; groups persisted receipts across restarts. */
  readonly sessionStartedAt: TimestampUs;
  /** Elapsed measurement microseconds since this session started. */
  readonly sessionOffsetUs: number;
  /** OBS recording position in milliseconds, or null when unavailable. */
  readonly recordingOffsetMs: number | null;
  /** Chapter label, shared by local receipts and OBS. */
  readonly label: string;
  /** Pulse increase in BPM relative to the streamer's own baseline. */
  readonly deltaBpm: number;
  /** Whether talking was detected within the preceding three measurement seconds. */
  readonly talkingRecent: boolean;
}
