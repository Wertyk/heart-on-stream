import { describe, expect, it } from "vitest";
import {
  estimateRecordingDurationMs,
  formatHighlightList,
} from "../../src/infrastructure/electron/session-export";

function highlight(
  sessionOffsetUs: number,
  recordingOffsetMs: number | null,
  label = "spike +18 vs baseline",
) {
  return { sessionOffsetUs, recordingOffsetMs, label };
}

describe("recording duration estimate", () => {
  const report = { durationMs: 135000, reportedAtMs: 5000 };
  it("extends a report only to the observed stop using the same monotonic clock", () => {
    expect(estimateRecordingDurationMs(report, 10000)).toBe(140000);
    expect(estimateRecordingDurationMs(report, 5000)).toBe(135000);
  });
  it("keeps the last report as a conservative bound when the stop moment is unknown", () => {
    expect(estimateRecordingDurationMs(report)).toBe(135000);
    expect(estimateRecordingDurationMs(report, null)).toBe(135000);
  });
  it("keeps the last report when progress to the stop is uncertain", () => {
    expect(
      estimateRecordingDurationMs({ ...report, reportedAtMs: null }, 10000),
    ).toBe(135000);
  });
  it("never invents a duration without an OBS report or subtracts time from a report", () => {
    expect(estimateRecordingDurationMs(null, 10000)).toBeUndefined();
    expect(estimateRecordingDurationMs(report, 4000)).toBe(135000);
    expect(
      estimateRecordingDurationMs({ durationMs: 0, reportedAtMs: 0 }, 10000),
    ).toBe(10000);
  });
});

describe("plain highlight list", () => {
  const header =
    "Highlight list — session time (OBS video time in brackets when recorded)";

  it("uses sorted session times for the full list when OBS coverage is mixed", () => {
    expect(
      formatHighlightList([
        highlight(280_000_000, null, "Local"),
        highlight(207_000_000, 225_000, "spike +22 vs baseline"),
      ]),
    ).toBe(`${header}\n03:27 spike +22 vs baseline (video 03:45)\n04:40 Local`);
  });

  it("labels the file honestly and retains every nearby timestamp without adding Intro", () => {
    expect(
      formatHighlightList([
        highlight(1_900_000, null, "First"),
        highlight(3_000_000, null, "Second"),
      ]),
    ).toBe(`${header}\n00:01 First\n00:03 Second`);
  });
  it("keeps the session timeline when every highlight has an OBS offset", () => {
    expect(
      formatHighlightList([
        highlight(30_000_000, 0, "Zero"),
        highlight(20_000_000, 74000, "Recorded"),
      ]),
    ).toBe(`${header}\n00:20 Recorded (video 01:14)\n00:30 Zero (video 00:00)`);
  });
  it("formats minutes and hours, floors fractions and keeps labels on one line", () => {
    expect(
      formatHighlightList([
        highlight(3_599_999_000, 7_323_999, "  First\n highlight  "),
        highlight(3_600_000_000, null, "Hour"),
        highlight(7_323_999_000, null, "Long"),
      ]),
    ).toBe(
      `${header}\n59:59 First highlight (video 2:02:03)\n1:00:00 Hour\n2:02:03 Long`,
    );
  });
  it("supports an empty pure value and refuses malformed times", () => {
    expect(formatHighlightList([])).toBe(header);
    expect(() => formatHighlightList([highlight(-1, null)])).toThrow(
      "Invalid highlight time",
    );
    expect(() => formatHighlightList([highlight(Number.NaN, null)])).toThrow(
      "Invalid highlight time",
    );
    expect(() => formatHighlightList([highlight(0, -1)])).toThrow(
      "Invalid highlight time",
    );
  });
});
