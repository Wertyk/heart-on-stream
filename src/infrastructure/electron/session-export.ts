import type { Highlight } from "../../domain/session/index";

type ExportHighlight = Pick<
  Highlight,
  "sessionOffsetUs" | "recordingOffsetMs" | "label"
>;

export type RecordingDurationResult =
  | { readonly ok: true; readonly durationMs?: number }
  | {
      readonly ok: false;
      readonly reason: "mixedRecordings" | "timelineReplaced";
    };

export interface RecordingDurationReport {
  readonly durationMs: number;
  /** Monotonic time of a running report, cleared when progress is uncertain. */
  readonly reportedAtMs: number | null;
}

/** Extend a report to an observed stop only if recording kept running. */
export function estimateRecordingDurationMs(
  report: RecordingDurationReport | null,
  stoppedAtMs: number | null = null,
): number | undefined {
  if (report === null) return undefined;
  return (
    report.durationMs +
    (stoppedAtMs === null || report.reportedAtMs === null
      ? 0
      : Math.max(0, stoppedAtMs - report.reportedAtMs))
  );
}

function timestamp(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs < 0)
    throw new Error("Invalid highlight time.");
  const seconds = Math.floor(offsetMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  if (seconds < 3600) return `${String(minutes).padStart(2, "0")}:${ss}`;
  return `${Math.floor(seconds / 3600)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
}

/** Session time keeps every highlight comparable even across multiple OBS recordings. */
export function formatHighlightList(
  highlights: readonly ExportHighlight[],
): string {
  return [
    "Highlight list — session time (OBS video time in brackets when recorded)",
    ...[...highlights]
      .sort((a, b) => a.sessionOffsetUs - b.sessionOffsetUs)
      .map(({ sessionOffsetUs, recordingOffsetMs, label }) => {
        const sessionTime = timestamp(sessionOffsetUs / 1000);
        const videoTime =
          recordingOffsetMs === null
            ? ""
            : ` (video ${timestamp(recordingOffsetMs)})`;
        return `${sessionTime} ${label.trim().replace(/\s+/gu, " ")}${videoTime}`;
      }),
  ].join("\n");
}
