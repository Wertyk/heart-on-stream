import type { Highlight } from "../session/index";

/** Duration must use the same recording/session timeline as the chapter offsets. */
export interface YouTubeChapterOptions {
  readonly durationMs: number;
  readonly introLabel?: string;
}

/** Refuse an invalid chapter list instead of returning text YouTube cannot use. */
export type YouTubeChaptersResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_duration"
        | "invalid_offset"
        | "invalid_label"
        | "insufficient_chapters";
    };

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  if (seconds < 3_600) return `${String(minutes).padStart(2, "0")}:${ss}`;
  return `${Math.floor(seconds / 3_600)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
}

function singleLineLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ");
}

/**
 * Prefer recordingOffsetMs when present (including zero), otherwise convert
 * sessionOffsetUs to ms. Floor offsets to whole seconds before checking gaps.
 * Keep the earliest highlight at least 10 s after the previous chapter; drop
 * closer highlights and those leaving less than 10 s before the video ends.
 * Input order breaks ties. Labels retain their text with whitespace flattened.
 * The intro is always at zero, and fewer than three retained chapters fails.
 */
export function toYouTubeChapters(
  highlights: readonly Highlight[],
  options: YouTubeChapterOptions,
): YouTubeChaptersResult {
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
    return { ok: false, reason: "invalid_duration" };
  }
  const introLabel = singleLineLabel(options.introLabel ?? "Intro");
  if (!introLabel) return { ok: false, reason: "invalid_label" };

  const candidates: { seconds: number; label: string }[] = [];
  for (const highlight of highlights) {
    const offsetMs =
      highlight.recordingOffsetMs ?? highlight.sessionOffsetUs / 1_000;
    if (!Number.isFinite(offsetMs) || offsetMs < 0) {
      return { ok: false, reason: "invalid_offset" };
    }
    const label = singleLineLabel(highlight.label);
    if (!label) return { ok: false, reason: "invalid_label" };
    candidates.push({ seconds: Math.floor(offsetMs / 1_000), label });
  }
  candidates.sort((a, b) => a.seconds - b.seconds);

  const durationSeconds = Math.floor(options.durationMs / 1_000);
  const chapters = [{ seconds: 0, label: introLabel }];
  let previousSeconds = 0;
  for (const candidate of candidates) {
    if (
      candidate.seconds - previousSeconds < 10 ||
      durationSeconds - candidate.seconds < 10
    ) {
      continue;
    }
    chapters.push(candidate);
    previousSeconds = candidate.seconds;
  }
  if (chapters.length < 3)
    return { ok: false, reason: "insufficient_chapters" };
  return {
    ok: true,
    text: chapters
      .map((chapter) => `${formatTimestamp(chapter.seconds)} ${chapter.label}`)
      .join("\n"),
  };
}
