/** SDK measurement time in microseconds since the Unix epoch, normalized to a number. */
export type TimestampUs = number;

/** A rate estimate; confidence is on the SDK's 0–100 scale, not a fraction. */
export interface Reading {
  readonly value: number;
  readonly confidence: number;
  readonly stable: boolean;
  readonly t: TimestampUs;
}

/** A raw waveform amplitude, not a rate or a calibrated physical measurement. */
export interface WaveSample {
  readonly value: number;
  readonly stable: boolean;
  readonly t: TimestampUs;
}

/** Domain names mirror the SDK validation codes without depending on its numeric enum. */
export type ValidationCode =
  | "ok"
  | "noFaceFound"
  | "multipleFacesFound"
  | "faceNotCentered"
  | "faceSizeOutOfRange"
  | "tooDark"
  | "tooBright"
  | "chestNotVisible"
  | "cameraTuning"
  | "frameRateTooLow"
  | "excessiveMotion"
  | "faceTooClose"
  | "faceTooFar"
  | "faceTooHigh"
  | "faceTooLow"
  | "faceNotForward";

/** The SDK's condition hint is preserved verbatim for the streamer's panel. */
export interface ValidationState {
  readonly t: TimestampUs;
  readonly code: ValidationCode;
  readonly hint: string;
}

/** Domain equivalents of the SDK processing lifecycle, independent of its enum. */
export type ProcessingStatus =
  | "uninitialized"
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "error";

/** Talking is a signal-quality input; its own SDK timestamp drives recency checks. */
export interface TalkingDetection {
  readonly t: TimestampUs;
  readonly detected: boolean;
  readonly stable: boolean;
}

/**
 * Normalized SDK input. Rates are BPM (pulse) or breaths/min (breathing).
 * Wave batches contain only the new samples in an SDK
 * window, in measurement order; each sample retains its own timestamp.
 * Processing events have no SDK timestamp, so the adapter supplies Clock time
 * in the same epoch-microsecond units. No camera frames belong in this union.
 */
export type SignalFrame =
  | { readonly kind: "pulseRate"; readonly reading: Reading }
  | { readonly kind: "pulseWave"; readonly samples: readonly WaveSample[] }
  | { readonly kind: "breathingRate"; readonly reading: Reading }
  | { readonly kind: "breathingWave"; readonly samples: readonly WaveSample[] }
  | ({ readonly kind: "talking" } & TalkingDetection)
  | ({ readonly kind: "validation" } & ValidationState)
  | {
      readonly kind: "processing";
      readonly t: TimestampUs;
      readonly status: ProcessingStatus;
    };

/** A host-clock boundary for a gap caused by releasing the camera. */
export interface CaptureFrame {
  readonly kind: "capture";
  readonly t: TimestampUs;
  readonly state: "paused" | "resumed";
}

/** The session machine accepts both SDK input and application capture boundaries. */
export type SessionFrame = SignalFrame | CaptureFrame;
