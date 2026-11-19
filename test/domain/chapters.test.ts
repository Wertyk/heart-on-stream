import { describe, expect, it } from "vitest";
import { toYouTubeChapters } from "../../src/domain/chapters/index";
import type { Highlight } from "../../src/domain/session/index";

function highlight(
  offsetMs: number,
  label: string,
  recordingOffsetMs: number | null = null,
): Highlight {
  return Object.freeze({
    t: 1_800_000_000_000_000 + offsetMs * 1_000,
    sessionStartedAt: 1_800_000_000_000_000,
    sessionOffsetUs: offsetMs * 1_000,
    recordingOffsetMs,
    label,
    deltaBpm: 12,
    talkingRecent: false,
  });
}

describe("YouTube chapter export", () => {
  it("starts at 00:00 and accepts exactly three chapters of exactly 10 seconds", () => {
    expect(
      toYouTubeChapters(
        [highlight(10_000, "First beat"), highlight(20_000, "Second beat")],
        { durationMs: 30_000, introLabel: "Welcome" },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Welcome\n00:10 First beat\n00:20 Second beat",
    });
  });

  it("drops close highlights deterministically, keeping the earliest label", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(25_000, "Too close after second"),
          highlight(9_999, "Too close to intro"),
          highlight(11_000, "Too close after first"),
          highlight(10_000, "First"),
          highlight(20_000, "Second"),
          highlight(20_000, "Duplicate time"),
          highlight(30_000, "Third"),
        ],
        { durationMs: 40_000 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:10 First\n00:20 Second\n00:30 Third",
    });
  });

  it("uses recording offsets when present and session offsets otherwise", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(90_000, "Recorded first", 10_000),
          highlight(20_000, "Session fallback"),
          highlight(120_000, "Recording zero", 0),
        ],
        { durationMs: 30_000 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:10 Recorded first\n00:20 Session fallback",
    });
  });

  it("floors to seconds before checking spacing and final duration", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(10_999, "First"),
          highlight(19_999, "Too close after flooring"),
          highlight(20_999, "Second"),
          highlight(30_000, "Final chapter too short"),
        ],
        { durationMs: 39_999 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:10 First\n00:20 Second",
    });
  });

  it("drops highlights at or beyond the end of the video", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(10_000, "First"),
          highlight(20_000, "Second"),
          highlight(30_000, "At end"),
          highlight(40_000, "After end"),
        ],
        { durationMs: 30_000 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:10 First\n00:20 Second",
    });
  });

  it("formats minute and hour boundaries without losing highlight labels", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(59_000, "💓 First"),
          highlight(70_000, "A minute later"),
          highlight(3_599_000, "Before hour"),
          highlight(3_610_000, "After hour"),
          highlight(36_000_000, "Ten hours"),
        ],
        { durationMs: 36_010_000 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:59 💓 First\n01:10 A minute later\n59:59 Before hour\n1:00:10 After hour\n10:00:00 Ten hours",
    });
  });

  it("formats the exact hour boundary as h:mm:ss", () => {
    expect(
      toYouTubeChapters(
        [highlight(10_000, "First"), highlight(3_600_000, "Hour")],
        { durationMs: 3_610_000 },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:10 First\n1:00:00 Hour",
    });
  });

  it.each([
    { highlights: [] },
    { highlights: [highlight(10_000, "Only one")] },
    {
      highlights: [highlight(10_000, "First"), highlight(19_999, "Too close")],
    },
    {
      highlights: [
        highlight(10_000, "First"),
        highlight(20_000, "Final too short"),
      ],
    },
  ])(
    "refuses fewer than three usable chapters ($highlights)",
    ({ highlights }) => {
      expect(toYouTubeChapters(highlights, { durationMs: 29_999 })).toEqual({
        ok: false,
        reason: "insufficient_chapters",
      });
    },
  );

  it("flattens label whitespace so a title cannot introduce extra chapter lines", () => {
    expect(
      toYouTubeChapters(
        [
          highlight(10_000, "  First\n beat  "),
          highlight(20_000, "Second\tbeat"),
        ],
        { durationMs: 30_000, introLabel: "  Our\nintro " },
      ),
    ).toEqual({
      ok: true,
      text: "00:00 Our intro\n00:10 First beat\n00:20 Second beat",
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid duration %s",
    (durationMs) => {
      expect(toYouTubeChapters([], { durationMs })).toEqual({
        ok: false,
        reason: "invalid_duration",
      });
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses invalid selected offset %s",
    (offsetMs) => {
      for (const item of [
        highlight(offsetMs, "Session"),
        highlight(0, "Recording", offsetMs),
      ]) {
        expect(toYouTubeChapters([item], { durationMs: 30_000 })).toEqual({
          ok: false,
          reason: "invalid_offset",
        });
      }
    },
  );

  it("refuses empty intro or highlight labels", () => {
    expect(
      toYouTubeChapters([], { durationMs: 30_000, introLabel: " \n " }),
    ).toEqual({ ok: false, reason: "invalid_label" });
    expect(
      toYouTubeChapters([highlight(10_000, " \t ")], { durationMs: 30_000 }),
    ).toEqual({ ok: false, reason: "invalid_label" });
  });

  it("does not reorder or mutate caller-owned highlights", () => {
    const highlights = Object.freeze([
      highlight(20_000, "Second"),
      highlight(10_000, "First"),
    ]);
    expect(toYouTubeChapters(highlights, { durationMs: 30_000 }).ok).toBe(true);
    expect(highlights.map((item) => item.label)).toEqual(["Second", "First"]);
  });
});
