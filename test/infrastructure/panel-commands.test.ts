import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExportChaptersResult } from "../../src/application/use-cases/stream-session";
import type { Highlight } from "../../src/domain/session/index";
import { observeExportDuration } from "../../src/infrastructure/electron/obs-export-duration";
import { createPanelCommands } from "../../src/infrastructure/electron/panel-commands";
import type { RecordingDurationResult } from "../../src/infrastructure/electron/session-export";
import { ObsWebsocketMarker } from "../../src/infrastructure/obs/obs-websocket-marker";
import {
  at,
  deferred,
  highlight,
  pulse,
  pulses,
  quickPolicy,
  fixture as sessionFixture,
} from "../application/fakes";
import { FakeObsClient } from "./obs-client-fake";

const startedAtUs = new Date(2026, 0, 8, 5, 9, 47).getTime() * 1_000;
const defaultChaptersPath = join(
  "/local",
  "heart-on-stream-chapters-2026-01-08-0509.txt",
);
const defaultHighlightsPath = join(
  "/local",
  "heart-on-stream-highlights-2026-01-08-0509.txt",
);
const highlightListHeader =
  "Highlight list — session time (OBS video time in brackets when recorded)";

function fixture() {
  const stream = {
    exportChapters: vi.fn(
      async (): Promise<ExportChaptersResult> => ({
        ok: true,
        text: "00:00 Intro\n00:10 First\n00:20 Second",
      }),
    ),
    deleteAllData: vi.fn(async () => {}),
  };
  const session = {
    startedAt: startedAtUs as number | null,
    durationMs: 60000,
    highlights: [
      {
        t: startedAtUs + 21_000_000,
        sessionStartedAt: startedAtUs,
        sessionOffsetUs: 21_000_000,
        recordingOffsetMs: null,
        label: "spike +18 vs baseline",
        deltaBpm: 18,
        talkingRecent: false,
      },
    ] as Highlight[],
  };
  const recordingDurationMs = vi.fn(
    async (): Promise<RecordingDurationResult> => ({ ok: true }),
  );
  const writeClipboard = vi.fn();
  const saveDialog = vi.fn(
    async (): Promise<{ canceled: boolean; filePath?: string }> => ({
      canceled: false,
      filePath: "/chosen/chapters.txt",
    }),
  );
  const writer = {
    write: vi.fn(
      async (_text: string, options: { path?: string }) => options.path ?? "",
    ),
  };
  const commands = createPanelCommands({
    stream,
    session: () => session,
    userData: "/local",
    overlayUrl: "http://127.0.0.1:7777/overlay",
    writeClipboard,
    recordingDurationMs,
    saveDialog,
    writer,
  });
  return {
    stream,
    session,
    writeClipboard,
    saveDialog,
    writer,
    commands,
    recordingDurationMs,
  };
}

describe("native panel commands", () => {
  it("copies only the main-owned overlay URL", async () => {
    const f = fixture();
    expect(await f.commands.copyOverlayUrl()).toMatchObject({ ok: true });
    expect(f.writeClipboard).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:7777/overlay",
    );
    f.writeClipboard.mockImplementationOnce(() => {
      throw new Error("failed");
    });
    expect(await f.commands.copyOverlayUrl()).toMatchObject({ ok: false });
  });
  it("suggests a local timestamp for chapters and writes to the chosen path", async () => {
    const f = fixture();
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: true,
      path: "/chosen/chapters.txt",
    });
    expect(f.stream.exportChapters).toHaveBeenCalledExactlyOnceWith({
      sessionStartedAt: startedAtUs,
      sessionDurationMs: 60000,
    });
    expect(f.saveDialog).toHaveBeenCalledExactlyOnceWith(defaultChaptersPath);
    expect(f.writer.write).toHaveBeenCalledExactlyOnceWith(
      "00:00 Intro\n00:10 First\n00:20 Second",
      { sessionStartedAt: startedAtUs, path: "/chosen/chapters.txt" },
    );
  });
  it("passes the known OBS recording duration on its own timeline", async () => {
    const f = fixture();
    f.recordingDurationMs.mockResolvedValueOnce({
      ok: true,
      durationMs: 180000,
    });
    await f.commands.exportChapters();
    expect(f.stream.exportChapters).toHaveBeenCalledWith({
      sessionStartedAt: startedAtUs,
      sessionDurationMs: 60000,
      recordingDurationMs: 180000,
    });
  });

  it("uses the default path when the dialog returns no file path, and never writes after cancellation", async () => {
    const f = fixture();
    f.saveDialog.mockResolvedValueOnce({ canceled: false });
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: true,
      path: defaultChaptersPath,
    });
    f.saveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: false,
      message: "Chapter export canceled.",
    });
    expect(f.writer.write).toHaveBeenCalledOnce();
  });
  it.each([
    "no_highlights",
    "insufficient_chapters",
    "invalid_duration",
    "invalid_offset",
    "invalid_label",
  ] as const)(
    "surfaces export refusal %s without opening a dialog",
    async (reason) => {
      const f = fixture();
      f.stream.exportChapters.mockResolvedValueOnce({ ok: false, reason });
      const result = await f.commands.exportChapters();
      expect(result.ok).toBe(false);
      expect(result.message).not.toBe("");
      expect(f.saveDialog).not.toHaveBeenCalled();
      expect(f.writer.write).not.toHaveBeenCalled();
    },
  );
  it("reports no highlights before a first frame, export exceptions and write errors", async () => {
    const f = fixture();
    f.session.startedAt = null;
    expect(await f.commands.exportChapters()).toEqual({
      ok: false,
      message: "No highlights in this session.",
    });
    expect(f.stream.exportChapters).not.toHaveBeenCalled();
    f.session.startedAt = startedAtUs;
    f.stream.exportChapters.mockRejectedValueOnce(new Error("private content"));
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unable to export"),
    });
    f.writer.write.mockRejectedValueOnce(new Error("private path error"));
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unable to export"),
    });
  });
  it("does not export earlier replay highlights when this run has none", async () => {
    const f = fixture();
    f.session.highlights = [];
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: false,
      message: "No highlights in this session.",
    });
    expect(f.stream.exportChapters).not.toHaveBeenCalled();
  });

  it("saves every highlight of this session after YouTube formatting is refused", async () => {
    const f = fixture();
    f.session.highlights = [
      highlight(20, 74000, startedAtUs),
      highlight(25, null, startedAtUs),
      highlight(30, 100000, startedAtUs - 60_000_000),
    ];
    f.stream.exportChapters.mockResolvedValueOnce({
      ok: false,
      reason: "insufficient_chapters",
    });
    expect(await f.commands.exportChapters()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Save the highlight list"),
    });
    const result = await f.commands.saveHighlightList();
    expect(result).toMatchObject({
      ok: true,
      path: "/chosen/chapters.txt",
      message: "Highlight list saved to /chosen/chapters.txt",
    });
    expect(f.saveDialog).toHaveBeenCalledExactlyOnceWith(defaultHighlightsPath);
    expect(f.writer.write).toHaveBeenCalledExactlyOnceWith(
      `${highlightListHeader}\n00:20 spike at 20 (video 01:14)\n00:25 spike at 25`,
      { sessionStartedAt: startedAtUs, path: "/chosen/chapters.txt" },
    );
    expect(f.recordingDurationMs).toHaveBeenCalledOnce();
  });

  it("uses a local timestamp for the default highlight-list path and skips writes after cancellation", async () => {
    const f = fixture();
    f.saveDialog.mockResolvedValueOnce({ canceled: false });
    expect(await f.commands.saveHighlightList()).toMatchObject({
      ok: true,
      path: defaultHighlightsPath,
    });
    f.saveDialog.mockResolvedValueOnce({ canceled: true });
    expect(await f.commands.saveHighlightList()).toEqual({
      ok: false,
      message: "Highlight list save canceled.",
    });
    expect(f.writer.write).toHaveBeenCalledOnce();
    expect(f.stream.exportChapters).not.toHaveBeenCalled();
  });

  it("reports save failures and does not save an empty or unrelated highlight list", async () => {
    const f = fixture();
    f.writer.write.mockRejectedValueOnce(new Error("write error"));
    expect(await f.commands.saveHighlightList()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unable to save the highlight list"),
    });
    f.session.highlights = [highlight(10, null, 2000)];
    expect(await f.commands.saveHighlightList()).toEqual({
      ok: false,
      message: "No highlights in this session.",
    });
    expect(f.saveDialog).toHaveBeenCalledOnce();
  });

  it.each(["mixedRecordings", "timelineReplaced"] as const)(
    "explains %s and still permits saving a plain highlight list",
    async (reason) => {
      const f = fixture();
      f.recordingDurationMs.mockResolvedValueOnce({ ok: false, reason });
      expect(await f.commands.exportChapters()).toMatchObject({
        ok: false,
        message: expect.stringContaining(
          reason === "mixedRecordings"
            ? "several OBS recordings"
            : "timeline was replaced",
        ),
      });
      expect(f.stream.exportChapters).not.toHaveBeenCalled();
      expect(await f.commands.saveHighlightList()).toMatchObject({ ok: true });
    },
  );

  it("exports valid YouTube chapters after stopping OBS and then ending the measurement session", async () => {
    const ports = sessionFixture();
    ports.highlights.items = [
      highlight(20, 90000, 1000),
      highlight(60, 130000, 1000),
    ];
    await ports.session.startSession({
      consentRecorded: true,
      privacyMode: "vibe",
    });
    const client = new FakeObsClient();
    let now = 90000;
    const observer = observeExportDuration(client, { nowMs: () => now });
    client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    observer.marked(90000);
    now = 130000;
    client.recording.outputDuration = 130000;
    await observer.client.call("GetRecordStatus");
    observer.marked(130000);
    now = 150000;
    client.emit("RecordStateChanged", {
      outputActive: false,
      outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
    });
    await ports.session.stopSession();
    const f = fixture();
    const commands = createPanelCommands({
      stream: ports.session,
      session: () => ({
        startedAt: 1000,
        durationMs: 100000,
        highlights: ports.highlights.items,
      }),
      recordingDurationMs: (highlights) => observer.durationMs(highlights),
      userData: "/local",
      overlayUrl: "",
      writeClipboard: f.writeClipboard,
      saveDialog: f.saveDialog,
      writer: f.writer,
    });
    expect(await commands.exportChapters()).toMatchObject({ ok: true });
    expect(f.writer.write).toHaveBeenCalledWith(
      "00:00 Intro\n01:30 spike at 20\n02:10 spike at 60",
      { sessionStartedAt: 1000, path: "/chosen/chapters.txt" },
    );
    observer.dispose();
  });

  it.each([
    { lastChapter: 135, stoppedAt: 140, durationMs: 140000, pausedAt: null },
    { lastChapter: 130, stoppedAt: 141, durationMs: 139000, pausedAt: 139 },
  ])(
    "refuses YouTube export and keeps the highlight list when OBS stops at $stoppedAt s with pause at $pausedAt",
    async ({ lastChapter, stoppedAt, durationMs, pausedAt }) => {
      const ports = sessionFixture();
      ports.highlights.items = [
        highlight(90, 90000, 1000),
        highlight(lastChapter, lastChapter * 1000, 1000),
      ];
      const client = new FakeObsClient();
      let now = 90000;
      const observer = observeExportDuration(client, { nowMs: () => now });
      try {
        client.emit("RecordStateChanged", {
          outputActive: true,
          outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        });
        for (const offset of [90000, lastChapter * 1000]) {
          now = offset;
          client.recording.outputDuration = offset;
          await observer.client.call("GetRecordStatus");
          observer.marked(offset);
        }
        if (pausedAt !== null) {
          now = pausedAt * 1000;
          client.recording.outputDuration = now;
          client.recording.outputPaused = true;
          await observer.client.call("GetRecordStatus");
        }
        now = stoppedAt * 1000;
        client.emit("RecordStateChanged", {
          outputActive: false,
          outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
        });
        now = 240000;
        const f = fixture();
        const commands = createPanelCommands({
          stream: ports.session,
          session: () => ({
            startedAt: 1000,
            durationMs: 240000,
            highlights: ports.highlights.items,
          }),
          recordingDurationMs: (highlights) => observer.durationMs(highlights),
          userData: "/local",
          overlayUrl: "",
          writeClipboard: f.writeClipboard,
          saveDialog: f.saveDialog,
          writer: f.writer,
        });
        expect(await commands.exportChapters()).toMatchObject({
          ok: false,
          message: expect.stringContaining("Too few chapters"),
        });
        expect(await observer.durationMs(ports.highlights.items)).toEqual({
          ok: true,
          durationMs,
        });
        expect(
          await ports.session.exportChapters({
            sessionStartedAt: 1000,
            sessionDurationMs: 240000,
            recordingDurationMs: durationMs,
          }),
        ).toEqual({ ok: false, reason: "insufficient_chapters" });
        expect(f.saveDialog).not.toHaveBeenCalled();
        expect(await commands.saveHighlightList()).toMatchObject({ ok: true });
        expect(f.writer.write).toHaveBeenCalledExactlyOnceWith(
          `${highlightListHeader}\n01:30 spike at 90 (video 01:30)\n02:${lastChapter - 120} spike at ${lastChapter} (video 02:${lastChapter - 120})`,
          { sessionStartedAt: 1000, path: "/chosen/chapters.txt" },
        );
      } finally {
        observer.dispose();
      }
    },
  );

  it.each(["acknowledged", "timed out", "offset write held"] as const)(
    "uses the 65-second OBS video when exporting a 203-second session (%s)",
    async (outcome) => {
      const ports = sessionFixture({ policy: quickPolicy });
      const client = new FakeObsClient();
      const acknowledgement = deferred<void>();
      const persistence = deferred<void>();
      if (outcome === "offset write held") {
        const update = ports.highlights.updateRecordingOffset.bind(
          ports.highlights,
        );
        vi.spyOn(ports.highlights, "updateRecordingOffset").mockImplementation(
          async (receipt, offset) => {
            await persistence.promise;
            return update(receipt, offset);
          },
        );
      }
      if (outcome === "timed out")
        vi.useFakeTimers({
          toFake: [
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
          ],
        });
      client.chapter.mockReturnValue(acknowledgement.promise);
      let now = 0;
      const observer = observeExportDuration(client, { nowMs: () => now });
      const marker = new ObsWebsocketMarker({ client: observer.client });
      ports.marker.captureRecording = () => marker.captureRecording();
      const chapterPort: typeof marker.createChapter = async (
        label,
        signal,
        token,
      ) => {
        const recording = observer.recordingGeneration;
        const result = await marker.createChapter(label, signal, token);
        if (result.status === "created")
          observer.marked(result.recordingOffsetMs, recording);
        return result;
      };
      ports.marker.createChapter = chapterPort;
      try {
        await marker.start();
        await ports.session.startSession({
          consentRecorded: true,
          privacyMode: "highlightsOnly",
        });
        observer.startRun();
        await pulses(ports.session, 0, 58);
        for (const [time, offset] of [
          [60, 20],
          [130, 40],
          [200, 60],
        ] as const) {
          now = offset * 1000;
          client.recording.outputDuration = now;
          await pulses(ports.session, time - 1, time, 82);
          await new Promise<void>((resolve) => setImmediate(resolve));
          await pulses(ports.session, time + 1, time + 3);
        }
        expect(client.chapter).toHaveBeenCalledTimes(3);
        expect(ports.session.currentHighlights).toMatchObject(
          [60, 130, 200].map((time) => ({
            t: at(time),
            recordingOffsetMs: null,
          })),
        );
        now = 65_000;
        client.emit("RecordStateChanged", {
          outputActive: false,
          outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
        });
        await ports.session.ingestFrame(pulse(203));
        await ports.session.stopSession();
        observer.endRun();
        expect(ports.session.sessionDurationMs).toBe(203_000);
        const f = fixture();
        const commands = createPanelCommands({
          stream: ports.session,
          session: () => ({
            startedAt: ports.session.sessionStartedAt,
            durationMs: ports.session.sessionDurationMs,
            highlights: ports.session.currentHighlights,
          }),
          async recordingDurationMs() {
            await ports.session.settleChapters();
            return observer.durationMs(ports.session.currentHighlights);
          },
          userData: "/local",
          overlayUrl: "",
          writeClipboard: f.writeClipboard,
          saveDialog: f.saveDialog,
          writer: f.writer,
        });
        const exporting = commands.exportChapters();
        const completed = vi.fn();
        void exporting.then(completed);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.writer.write).not.toHaveBeenCalled();
        if (outcome === "timed out") {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(await exporting).toMatchObject({
            ok: false,
            message: expect.stringContaining("Too few chapters"),
          });
          expect(await commands.exportChapters()).toMatchObject({
            ok: false,
            message: expect.stringContaining("Too few chapters"),
          });
          expect(f.writer.write).not.toHaveBeenCalled();
        } else {
          acknowledgement.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(completed).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ ok: true }),
          );
          expect(f.writer.write.mock.calls[0]?.[0]).toBe(
            "00:00 Intro\n00:20 spike +12 vs baseline\n00:40 spike +12 vs baseline",
          );
          if (outcome === "offset write held") {
            expect(
              ports.highlights.items.every(
                (item) => item.recordingOffsetMs === null,
              ),
            ).toBe(true);
            expect(await commands.saveHighlightList()).toMatchObject({
              ok: true,
            });
            expect(f.writer.write.mock.calls[1]?.[0]).toContain(
              "(video 00:20)",
            );
          }
        }
      } finally {
        acknowledgement.resolve();
        persistence.resolve();
        await marker.stop();
        observer.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("keeps nearby timestamps when the real session service rejects YouTube chapters", async () => {
    const ports = sessionFixture();
    ports.highlights.items = [
      highlight(20, null, 1000),
      highlight(25, null, 1000),
    ];
    const f = fixture();
    const commands = createPanelCommands({
      stream: ports.session,
      session: () => ({
        startedAt: 1000,
        durationMs: 60000,
        highlights: ports.highlights.items,
      }),
      userData: "/local",
      overlayUrl: "",
      writeClipboard: f.writeClipboard,
      saveDialog: f.saveDialog,
      writer: f.writer,
    });
    expect(await commands.exportChapters()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Too few chapters"),
    });
    expect(await commands.saveHighlightList()).toMatchObject({ ok: true });
    expect(f.writer.write).toHaveBeenCalledWith(
      `${highlightListHeader}\n00:20 spike at 20\n00:25 spike at 25`,
      { sessionStartedAt: 1000, path: "/chosen/chapters.txt" },
    );
  });

  it("deletes through StreamSession and surfaces partial deletion failure", async () => {
    const f = fixture();
    expect(await f.commands.deleteAllData()).toMatchObject({
      ok: true,
      message: expect.stringContaining("deleted"),
    });
    expect(f.stream.deleteAllData).toHaveBeenCalledOnce();
    f.stream.deleteAllData.mockRejectedValueOnce(new Error("failed"));
    expect(await f.commands.deleteAllData()).toMatchObject({
      ok: false,
      message: expect.stringContaining("Some stored data"),
    });
  });
});
