import type {
  RecordingMarker,
  RecordingMarkerResult,
} from "../../application/ports/recording-marker";

/** Keeps local receipts available when OBS integration is disabled. */
export class NoopMarker implements RecordingMarker {
  captureRecording(): null {
    return null;
  }

  async createChapter(_label: string): Promise<RecordingMarkerResult> {
    return { status: "unavailable", reason: "disconnected" };
  }
}
