import { describe, expect, it } from "vitest";
import { at, fixture, highlight, pulse, pulses, quickPolicy } from "./fakes";

const start = { consentRecorded: true, privacyMode: "vibe" } as const;

describe("ExportChapters", () => {
  it("rejects the 65-second OBS export with one offset in a 100-second session", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20, 20_000), highlight(80)];
    expect(
      await f.session.exportChapters({
        recordingDurationMs: 65_000,
        sessionDurationMs: 100_000,
      }),
    ).toEqual({ ok: false, reason: "insufficient_chapters" });
  });

  it("retains only OBS offsets that fit the recording and its chapter spacing", async () => {
    const f = fixture();
    f.highlights.items = [
      highlight(40, 45_000),
      highlight(20, 20_000),
      highlight(10),
      highlight(25, 29_000),
      highlight(50, 56_000),
      highlight(60, 65_000),
      highlight(70, 80_000),
    ];
    expect(
      await f.session.exportChapters({
        recordingDurationMs: 65_000,
        sessionDurationMs: 100_000,
      }),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike at 20\n00:45 spike at 40",
    });
  });

  it("exports only the most recent stored session after restart, choosing its recording timeline independently", async () => {
    const f = fixture();
    f.highlights.items = [
      highlight(10, 20_000, at(3600)),
      highlight(20),
      highlight(30, 40_000, at(3600)),
      highlight(40),
    ];
    expect(
      await f.session.exportChapters({
        recordingDurationMs: 60_000,
        sessionDurationMs: 15_000,
      }),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike at 10\n00:40 spike at 30",
    });
    expect(f.session.panelState.highlights).toEqual([]);
    expect(f.highlights.items).toHaveLength(4);
    expect(f.source.starts).toBe(0);
  });

  it("exports an explicitly selected older session using only that session's fallback timeline", async () => {
    const f = fixture();
    f.highlights.items = [
      highlight(10, 10_000, at(3600)),
      highlight(20, 5000),
      highlight(30, 30_000, at(3600)),
      highlight(40),
    ];
    expect(
      await f.session.exportChapters({
        sessionStartedAt: at(0),
        sessionDurationMs: 60_000,
      }),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike at 20\n00:40 spike at 40",
    });
    expect(f.highlights.items[1]?.recordingOffsetMs).toBe(5000);
  });

  it("returns no_highlights for an empty repository", async () => {
    const f = fixture();
    expect(await f.session.exportChapters()).toEqual({
      ok: false,
      reason: "no_highlights",
    });
  });

  it("returns no_highlights for a missing selected session without falling back to another", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20), highlight(40)];
    expect(
      await f.session.exportChapters({
        sessionStartedAt: at(3600),
        sessionDurationMs: 60_000,
      }),
    ).toEqual({ ok: false, reason: "no_highlights" });
  });

  it("defaults to a prior session with highlights without borrowing the current session's duration", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20), highlight(40)];
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(1000));
    await f.session.ingestFrame(pulse(1080));
    expect(await f.session.exportChapters()).toEqual({
      ok: false,
      reason: "invalid_duration",
    });
    expect(
      await f.session.exportChapters({ sessionDurationMs: 60_000 }),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike at 20\n00:40 spike at 40",
    });
  });

  it("uses only recording offsets with recording duration when all offsets exist", async () => {
    const f = fixture();
    f.highlights.items = [highlight(10, 40_000), highlight(20, 80_000)];
    expect(
      await f.session.exportChapters({
        recordingDurationMs: 120_000,
        sessionDurationMs: 30_000,
        introLabel: "Stream start",
      }),
    ).toEqual({
      ok: true,
      text: "00:00 Stream start\n00:40 spike at 10\n01:20 spike at 20",
    });
    expect(f.highlights.lists).toBe(1);
    expect(f.source.starts).toBe(0);
  });

  it("uses only session offsets when OBS duration is unknown and coverage is mixed", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20, 5000), highlight(40)];
    expect(
      await f.session.exportChapters({
        sessionDurationMs: 60_000,
      }),
    ).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike at 20\n00:40 spike at 40",
    });
    expect(f.highlights.items[0]?.recordingOffsetMs).toBe(5000);
  });

  it("includes a trailing capture pause in session duration and freezes it at End", async () => {
    const f = fixture({ policy: quickPolicy });
    f.marker.results.push(
      { status: "unavailable", reason: "disconnected" },
      { status: "unavailable", reason: "disconnected" },
    );
    await f.session.startSession(start);
    await pulses(f.session, 0, 18);
    await pulses(f.session, 19, 20, 82);
    await pulses(f.session, 21, 58);
    await pulses(f.session, 59, 60, 82);
    f.clock.value = at(65);
    await f.session.setPaused(true);
    f.clock.value = at(80);
    await f.session.stopSession();
    f.clock.value += 1_000_000_000;
    expect(f.session.sessionDurationMs).toBe(80_000);
    expect(await f.session.exportChapters()).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike +12 vs baseline\n01:00 spike +12 vs baseline",
    });
  });

  it("returns domain refusal results without borrowing a duration from another timeline", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20, 40_000), highlight(40, 60_000)];
    expect(
      await f.session.exportChapters({ sessionDurationMs: 120_000 }),
    ).toEqual({ ok: false, reason: "invalid_duration" });
    f.highlights.items = [highlight(20)];
    expect(
      await f.session.exportChapters({ sessionDurationMs: 120_000 }),
    ).toEqual({ ok: false, reason: "insufficient_chapters" });
  });

  it("reports a repository read failure and does not export stale panel receipts", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20), highlight(40)];
    await f.session.startSession(start);
    f.highlights.failList = true;
    await expect(
      f.session.exportChapters({ sessionDurationMs: 60_000 }),
    ).rejects.toThrow("could not be loaded");
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "highlightLoad" }),
    );
    expect(f.logger.errors).toContain("Stored highlights could not be loaded.");
  });
});

describe("DeleteAllData", () => {
  it("stops intake and recording before deleting all owned data, idempotently", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    expect(f.highlights.items).toHaveLength(1);
    expect(f.recorder.files).toHaveLength(1);
    const deletion = f.session.deleteAllData();
    f.source.emit(pulse(100, 82));
    await deletion;
    await f.session.whenIdle();
    await f.session.ingestFrame(pulse(200, 82));
    expect(f.highlights.items).toEqual([]);
    expect(f.recorder.files).toEqual([]);
    expect(f.session.panelState.highlights).toEqual([]);
    expect(f.source.stops).toBe(1);
    expect(f.recorder.stops).toBe(1);
    expect(f.recorder.appends).toBe(4);
    await f.session.deleteAllData();
    expect(f.highlights.deletes).toBe(2);
    expect(f.recorder.deletes).toBe(2);
  });

  it.each(["highlights", "recordings"])(
    "attempts both deletions and reports a failed %s deletion",
    async (failure) => {
      const f = fixture();
      f.highlights.items = [highlight(20)];
      f.highlights.failDelete = failure === "highlights";
      f.recorder.failDelete = failure === "recordings";
      await expect(f.session.deleteAllData()).rejects.toThrow(
        "Some stored data",
      );
      expect(f.highlights.deletes).toBe(1);
      expect(f.recorder.deletes).toBe(1);
      expect(f.panels.at(-1)?.errors).toContainEqual(
        expect.objectContaining({
          operation:
            failure === "highlights" ? "highlightDelete" : "recordingDelete",
        }),
      );
      expect(f.logger.errors).toHaveLength(1);
      f.highlights.failDelete = false;
      f.recorder.failDelete = false;
      await f.session.deleteAllData();
      expect(f.highlights.items).toEqual([]);
      expect(f.recorder.files).toEqual([]);
    },
  );
});

describe("port failure recovery", () => {
  it("reports recording start failure, cleans up, and continues measurement without appending", async () => {
    const f = fixture({ policy: quickPolicy });
    f.recorder.failStart = true;
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    expect(f.session.panelState).toMatchObject({
      active: true,
      recording: false,
    });
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "recordingStart" }),
    );
    expect(f.recorder.stops).toBe(1);
    expect(f.recorder.appends).toBe(0);
    expect(f.highlights.items).toHaveLength(1);
  });

  it("reports recording append failures without ending detection or publication", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({ ...start, recordingEnabled: true });
    f.recorder.failAppend = true;
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    expect(f.highlights.items).toHaveLength(1);
    expect(f.publisher.states.at(-1)).toMatchObject({ intensity: "spike" });
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "recordingAppend" }),
    );
    f.recorder.failAppend = false;
    await f.session.ingestFrame(pulse(3));
    await f.session.stopSession();
    expect(f.recorder.files[0]).toEqual([
      pulse(3),
      { kind: "end", durationUs: 3_000_000 },
    ]);
    expect(f.recorder.stops).toBe(1);
  });

  it("still finalizes recording and publishes Off if source stop fails; retries cleanup", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, recordingEnabled: true });
    f.source.failStop = true;
    await f.session.stopSession();
    expect(f.recorder.stops).toBe(1);
    expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
    expect(f.session.panelState).toMatchObject({
      active: false,
      processing: "error",
    });
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "sourceStop" }),
    );
    await expect(f.session.startSession(start)).rejects.toThrow(
      "previous signal source",
    );
    expect(f.source.starts).toBe(1);
    f.source.failStop = false;
    await f.session.stopSession();
    expect(f.source.stops).toBe(3);
    expect(f.session.panelState.processing).toBe("idle");
  });

  it("reports recorder finalization failure and refuses a new session until cleanup works", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, recordingEnabled: true });
    f.recorder.failStop = true;
    await f.session.stopSession();
    expect(f.source.stops).toBe(1);
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "recordingStop" }),
    );
    await expect(f.session.startSession(start)).rejects.toThrow(
      "previous session recording",
    );
    expect(f.source.starts).toBe(1);
    f.recorder.failStop = false;
    await f.session.startSession(start);
    expect(f.source.starts).toBe(2);
    expect(f.session.panelState.recording).toBe(false);
  });

  it("surfaces unavailable stored highlights on start while allowing a new session", async () => {
    const f = fixture();
    f.highlights.failList = true;
    await f.session.startSession(start);
    expect(f.session.panelState.active).toBe(true);
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "highlightLoad" }),
    );
  });
});

it("runs a complete deterministic replay scenario through the subscribed source", async () => {
  const f = fixture({ replay: true });
  f.marker.results.push(
    { status: "created", recordingOffsetMs: 90_000 },
    new Error("OBS disconnected"),
  );
  await f.session.startSession({ ...start, recordingEnabled: true });
  const deliver = async (from: number, to: number, value = 70) => {
    for (let t = from; t <= to; t++) f.source.emit(pulse(t, value));
    await f.session.whenIdle();
  };
  await deliver(0, 11);
  expect(f.session.panelState.phase).toBe("warming");
  await deliver(12, 36);
  expect(f.session.panelState.phase).toBe("baselining");
  await deliver(37, 37);
  expect(f.session.panelState.phase).toBe("live");
  await deliver(38, 72);
  await deliver(73, 85, 88);
  expect(f.highlights.items[0]).toMatchObject({
    sessionOffsetUs: 78_000_000,
    recordingOffsetMs: 90_000,
    deltaBpm: 18,
  });
  await deliver(86, 129);
  await deliver(130, 140, 88);
  expect(f.highlights.items[1]).toMatchObject({
    sessionOffsetUs: 135_000_000,
    recordingOffsetMs: null,
  });
  await f.session.setPaused(true);
  await deliver(141, 155, 100);
  expect(f.highlights.items).toHaveLength(2);
  expect(f.publisher.states.at(-1)).toMatchObject({ status: "paused" });
  await f.session.setPaused(false);
  await f.session.setPrivacyMode("highlightsOnly");
  await deliver(156, 160);
  expect(f.publisher.states.at(-1)).toEqual({
    mode: "highlightsOnly",
    replay: true,
  });
  await f.session.setPrivacyMode("numbers");
  await deliver(161, 180);
  expect(f.publisher.states.at(-1)).toMatchObject({
    mode: "numbers",
    pulseBpm: 70,
    replay: true,
  });
  await f.session.stopSession();
  expect(f.recorder.stops).toBe(1);
  expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: true });
  expect(
    await f.session.exportChapters({ recordingDurationMs: 100_000 }),
  ).toEqual({ ok: false, reason: "insufficient_chapters" });
  expect(await f.session.exportChapters()).toEqual({
    ok: true,
    text: "00:00 Intro\n01:18 spike +18 vs baseline\n02:15 spike +18 vs baseline",
  });
  await f.session.deleteAllData();
  expect(f.highlights.items).toEqual([]);
  expect(f.recorder.files).toEqual([]);
  expect(f.session.panelState.highlights).toEqual([]);
});
