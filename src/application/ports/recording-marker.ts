/** Adapter-owned identity of a recording, if one is known to be active. */
export type RecordingToken = symbol | null;

/** Expected OBS unavailability is a result, allowing local highlights to continue. */
export type RecordingMarkerResult =
  | { readonly status: "created"; readonly recordingOffsetMs: number }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "cancelled"
        | "disconnected"
        | "notRecording"
        | "unsupported";
    };

/**
 * Attempts an OBS recording chapter and returns its recording position in ms.
 * A no-op adapter returns unavailable. Unexpected failures may reject; neither
 * unavailability nor failure may end the session or discard a local highlight.
 */
export interface RecordingMarker {
  /** Capture recording identity synchronously when a spike is confirmed. */
  captureRecording(): RecordingToken;
  /** The adapter bounds the reply wait and checks cancellation before sending. */
  createChapter(
    label: string,
    signal: AbortSignal,
    recording: RecordingToken,
  ): Promise<RecordingMarkerResult>;
}
