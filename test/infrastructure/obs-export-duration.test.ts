import { afterEach, describe, expect, it, vi } from "vitest";
import { observeExportDuration } from "../../src/infrastructure/electron/obs-export-duration";
import { ObsWebsocketMarker } from "../../src/infrastructure/obs/obs-websocket-marker";
import { highlight } from "../application/fakes";
import { FakeObsClient } from "./obs-client-fake";

const highlights = [highlight(90, 90000), highlight(135, 135000)];
const sessionOnlyHighlights = [highlight(60), highlight(130), highlight(200)];
const disposers: (() => void)[] = [];

function fixture({ observedStart = true } = {}) {
  let now = 135000;
  const client = new FakeObsClient();
  client.recording.outputDuration = 135000;
  const observer = observeExportDuration(client, { nowMs: () => now });
  if (observedStart)
    client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
  disposers.push(() => observer.dispose());
  const setNow = (value: number) => {
    now = value;
  };
  const duration = () => observer.durationMs(highlights);
  const stop = () => {
    client.recording = {
      outputActive: false,
      outputPaused: false,
      outputDuration: 0,
    };
    client.emit("RecordStateChanged", {
      outputActive: false,
      outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
    });
  };
  return { client, observer, setNow, duration, stop };
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

describe("OBS chapter export timeline", () => {
  it("uses a fresh OBS report while the matching recording is active", async () => {
    const f = fixture();
    expect(await f.observer.durationMs([])).toEqual({ ok: true });
    expect(f.client.getStatus).not.toHaveBeenCalled();
    f.observer.marked(135000);
    f.client.recording.outputDuration = 140000;
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
    expect(f.client.requests).toEqual(["GetRecordStatus"]);
    f.observer.startRun();
    expect(await f.observer.durationMs([])).toEqual({ ok: true });
    f.observer.dispose();
    expect(f.client.listenerCount("RecordStateChanged")).toBe(0);
    expect(f.client.listenerCount("ConnectionClosed")).toBe(0);
  });

  it("freezes at OBS stop at 140 s despite the app session ending at 240 s", async () => {
    const f = fixture();
    f.observer.marked(90000);
    await f.observer.client.call("GetRecordStatus");
    f.observer.marked(135000);
    f.setNow(140000);
    f.stop();
    f.setNow(240000);
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
    f.stop();
    await f.observer.client.call("GetRecordStatus");
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
  });

  it("keeps the observed video duration if pending chapters time out without offsets", async () => {
    const f = fixture();
    f.setNow(60_000);
    f.client.recording.outputDuration = 60_000;
    await f.observer.client.call("GetRecordStatus");
    f.observer.startRun();
    f.setNow(65_000);
    f.stop();
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: true,
      durationMs: 65_000,
    });
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: true,
      durationMs: 65_000,
    });
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
  });

  it("associates a paused recording first discovered by a status read during the run", async () => {
    const f = fixture({ observedStart: false });
    f.observer.startRun();
    await f.observer.client.connect("ws://127.0.0.1:4455", undefined, {
      eventSubscriptions: 0,
    });
    f.client.recording = {
      outputActive: false,
      outputPaused: true,
      outputDuration: 58_000,
    };
    await f.observer.client.call("GetRecordStatus");
    f.observer.endRun();
    f.client.recording = {
      outputActive: true,
      outputPaused: false,
      outputDuration: 63_000,
    };
    f.setNow(206_000);
    await f.observer.client.call("GetRecordStatus");
    f.setNow(208_000);
    f.stop();
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: true,
      durationMs: 65_000,
    });
    f.observer.startRun();
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: true,
    });
  });

  it("leaves session-time export available for a recording that starts after the run", async () => {
    const f = fixture({ observedStart: false });
    f.observer.startRun();
    f.observer.endRun();
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    await f.observer.client.call("GetRecordStatus");
    expect(await f.observer.durationMs(sessionOnlyHighlights)).toEqual({
      ok: true,
    });
  });

  it("keeps the finished run's stopped video duration when OBS records again", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.startRun();
    f.observer.marked(90_000);
    f.observer.marked(135_000);
    f.observer.endRun();
    f.setNow(150_000);
    f.stop();
    expect(await f.duration()).toEqual({ ok: true, durationMs: 150_000 });
    f.client.recording = {
      outputActive: true,
      outputPaused: false,
      outputDuration: 20_000,
    };
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    await f.observer.client.call("GetRecordStatus");
    expect(await f.duration()).toEqual({ ok: true, durationMs: 150_000 });
  });

  it("does not attribute a late acknowledgement to the replacement recording", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    const recording = f.observer.recordingGeneration;
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    f.observer.marked(135_000, recording);
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
  });

  it("does not combine increasing offsets from both sides of an OBS file split", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.startRun();
    const firstFile = f.observer.recordingGeneration;
    f.client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
    f.observer.marked(60_000, firstFile); // Acknowledged after the split.
    f.observer.marked(130_000);
    f.observer.marked(200_000);
    f.client.recording.outputDuration = 203_000;
    expect(
      await f.observer.durationMs([
        highlight(60, 60_000),
        highlight(130, 130_000),
        highlight(200, 200_000),
      ]),
    ).toEqual({ ok: false, reason: "mixedRecordings" });
    expect(f.observer.recordingGeneration).not.toBe(firstFile);
  });

  it("requires file-relative offsets when only the new file has chapter acknowledgements", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.startRun();
    f.client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
    f.observer.marked(130_000);
    f.observer.marked(200_000);
    f.client.recording.outputDuration = 203_000;
    const result = await f.observer.durationMs([
      highlight(60),
      highlight(130, 130_000),
      highlight(200, 200_000),
    ]);
    expect(result.ok).toBe(false);
  });

  it("holds the confirmed duration on a pause event and ignores pre-pause responses", async () => {
    const f = fixture();
    f.observer.marked(135000);
    await f.observer.client.call("GetRecordStatus");
    let respond!: (state: typeof f.client.recording) => void;
    f.client.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = f.observer.client.call("GetRecordStatus");
    f.setNow(139000);
    f.client.emit("RecordStateChanged", {
      outputActive: false,
      outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED",
    });
    respond({ ...f.client.recording, outputDuration: 138000 });
    await pending;
    f.setNow(141000);
    f.stop();
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
  });

  it.each([false, true])(
    "uses a fresh recording anchor after resume when available (%s)",
    async (refreshAfterResume) => {
      const f = fixture();
      f.observer.marked(135000);
      await f.observer.client.call("GetRecordStatus");
      f.setNow(139000);
      f.client.emit("RecordStateChanged", {
        outputActive: false,
        outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED",
      });
      f.setNow(159000);
      f.client.emit("RecordStateChanged", {
        outputActive: true,
        outputState: "OBS_WEBSOCKET_OUTPUT_RESUMED",
      });
      if (refreshAfterResume) {
        f.setNow(160000);
        f.client.recording.outputDuration = 140000;
        await f.observer.client.call("GetRecordStatus");
      }
      f.setNow(162000);
      f.stop();
      expect(await f.duration()).toEqual({
        ok: true,
        durationMs: refreshAfterResume ? 142000 : 135000,
      });
    },
  );

  it("keeps the last confirmed duration when a status refresh fails before stop", async () => {
    const f = fixture();
    f.observer.marked(135000);
    await f.observer.client.call("GetRecordStatus");
    f.setNow(140000);
    f.client.getStatus.mockRejectedValueOnce(new Error("unavailable"));
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
    f.setNow(142000);
    f.stop();
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
  });

  it("refreshes every 5 s while active, then cancels polling on stop and dispose", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.client.getStatus).toHaveBeenCalledTimes(1);
    f.setNow(140000);
    f.client.recording.outputDuration = 140000;
    await vi.advanceTimersByTimeAsync(1);
    expect(f.client.getStatus).toHaveBeenCalledTimes(2);
    f.setNow(145000);
    f.client.recording.outputDuration = 145000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.client.getStatus).toHaveBeenCalledTimes(3);
    f.observer.marked(135000);
    f.setNow(147000);
    f.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.client.getStatus).toHaveBeenCalledTimes(3);
    expect(await f.duration()).toEqual({ ok: true, durationMs: 147000 });
    expect(vi.getTimerCount()).toBe(0);
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    expect(vi.getTimerCount()).toBe(1);
    f.observer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes the marker's refresh at every chapter, preserving the report's timestamp", async () => {
    const f = fixture({ observedStart: false });
    f.setNow(0);
    f.client.recording.outputDuration = 0;
    const marker = new ObsWebsocketMarker({ client: f.observer.client });
    await marker.start();
    for (const offset of [90000, 135000]) {
      f.setNow(offset);
      f.client.recording.outputDuration = offset;
      const result = await marker.createChapter("Example");
      expect(result).toEqual({ status: "created", recordingOffsetMs: offset });
      if (result.status === "created")
        f.observer.marked(result.recordingOffsetMs);
    }
    expect(f.client.requests).toEqual([
      "GetProfileParameter",
      "GetProfileParameter",
      "GetRecordStatus",
      "GetRecordStatus",
      "CreateRecordChapter",
      "GetRecordStatus",
      "CreateRecordChapter",
    ]);
    f.setNow(140000);
    f.stop();
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
    await marker.stop();
  });

  it("backs off after connected profile request errors and verifies the same recording", async () => {
    vi.useFakeTimers();
    const f = fixture({ observedStart: false });
    f.client.getProfileParameter
      .mockResolvedValueOnce({ parameterValue: "Advanced" })
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ parameterValue: "false" });
    await f.observer.client.connect("ws://127.0.0.1:4455", undefined, {
      eventSubscriptions: 0,
    });
    const reading = await f.observer.client.call("GetRecordStatus");
    expect(reading.fileOffsetMs).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.client.getProfileParameter).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.client.getProfileParameter).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.client.getProfileParameter).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.client.getProfileParameter).toHaveBeenCalledTimes(4);
    expect(await reading.pendingUnsplitOrigin).toBe(true);
    expect(await f.observer.client.call("GetRecordStatus")).toMatchObject({
      fileOffsetMs: 135_000,
    });
  });

  it("cancels a pending profile retry when the recording file changes", async () => {
    vi.useFakeTimers();
    const f = fixture({ observedStart: false });
    f.client.getProfileParameter
      .mockResolvedValueOnce({ parameterValue: "Advanced" })
      .mockRejectedValueOnce(new Error("unavailable"));
    await f.observer.client.connect("ws://127.0.0.1:4455", undefined, {
      eventSubscriptions: 0,
    });
    const reading = await f.observer.client.call("GetRecordStatus");
    expect(reading.fileOffsetMs).toBeNull();
    f.client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.client.getProfileParameter).toHaveBeenCalledTimes(2);
    expect(await reading.pendingUnsplitOrigin).toBe(false);
    f.client.recording.outputDuration = 140_000;
    expect(await f.observer.client.call("GetRecordStatus")).toMatchObject({
      fileOffsetMs: 5_000,
    });
  });

  it.each([
    { delayMs: 999, fileOffsetMs: 60_000 },
    { delayMs: 1_000, fileOffsetMs: null },
  ])(
    "checks boundary precision on a $delayMs ms split reply",
    async ({ delayMs, fileOffsetMs }) => {
      vi.useFakeTimers();
      const f = fixture();
      f.setNow(600_000);
      f.client.recording.outputDuration = 600_000;
      f.client.getStatus.mockImplementationOnce(async () => {
        const sample = { ...f.client.recording };
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return sample;
      });
      f.client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
      f.setNow(600_000 + delayMs);
      await vi.advanceTimersByTimeAsync(delayMs);
      f.client.recording.outputDuration = 660_000;
      expect(await f.observer.client.call("GetRecordStatus")).toMatchObject({
        fileOffsetMs,
      });
    },
  );

  it("uses only the last reported bound if disconnected before stopping, and cancels polling", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.marked(135000);
    f.setNow(138000);
    f.client.emit("ConnectionClosed");
    f.setNow(140000);
    f.stop();
    f.setNow(240000);
    await vi.advanceTimersByTimeAsync(100000);
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
    expect(f.client.getStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await f.observer.client.connect("ws://127.0.0.1:4455", undefined, {
      eventSubscriptions: 0,
    });
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
  });

  it("keeps a known final duration when disconnected after the stop", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.marked(135000);
    f.setNow(140000);
    f.stop();
    f.client.emit("ConnectionClosed");
    f.setNow(240000);
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
  });

  it("stays conservative if an inactive status arrives without a stop event", async () => {
    const f = fixture();
    f.observer.marked(135000);
    f.setNow(240000);
    f.client.recording = {
      outputActive: false,
      outputPaused: false,
      outputDuration: 0,
    };
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
  });

  it("honors a stop event even when an inactive status arrived just before it", async () => {
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.marked(135000);
    f.client.recording = {
      outputActive: false,
      outputPaused: false,
      outputDuration: 0,
    };
    f.setNow(140000);
    await f.observer.client.call("GetRecordStatus");
    f.stop();
    f.setNow(240000);
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
  });

  it("refuses an active recording shorter than a selected highlight's recording offset", async () => {
    const f = fixture();
    f.observer.marked(90000);
    f.client.recording.outputDuration = 100000;
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
  });

  it("refuses new recordings, regressive offsets and mixed recordings with a reason", async () => {
    const f = fixture();
    f.observer.marked(135000);
    f.stop();
    f.client.recording = {
      outputActive: true,
      outputPaused: false,
      outputDuration: 20000,
    };
    f.client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
    f.observer.marked(1000);
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "mixedRecordings",
    });
    f.observer.startRun();
    f.observer.marked(1000);
    expect(await f.observer.durationMs([highlight(1, 1000)])).toEqual({
      ok: true,
      durationMs: 20000,
    });
    f.observer.marked(500);
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "mixedRecordings",
    });
    f.observer.startRun();
    f.observer.marked(200000);
    expect(await f.duration()).toEqual({
      ok: false,
      reason: "timelineReplaced",
    });
  });

  it("uses the last report on request failure or timeout and ignores a late timed-out response", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.observer.marked(135000);
    f.client.getStatus.mockRejectedValueOnce(new Error("unavailable"));
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
    let respond!: (state: typeof f.client.recording) => void;
    f.client.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const duration = f.duration();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await duration).toEqual({ ok: true, durationMs: 135000 });
    respond({ ...f.client.recording, outputDuration: 180000 });
    await Promise.resolve();
    f.client.emit("ConnectionClosed");
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a timed-out status from the shared chapter client before stop", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.observer.client.call("GetRecordStatus");
    f.observer.marked(135000);
    let respond!: (state: typeof f.client.recording) => void;
    f.client.getStatus
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const timedOut = expect(
      f.observer.client.call("GetRecordStatus"),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await timedOut;
    respond({ ...f.client.recording, outputDuration: 140000 });
    await vi.advanceTimersByTimeAsync(0);
    f.setNow(142000);
    f.stop();
    expect(await f.duration()).toEqual({ ok: true, durationMs: 135000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an active status response arriving after a stop or disconnect", async () => {
    for (const event of ["stop", "disconnect"]) {
      const f = fixture();
      await f.observer.client.call("GetRecordStatus");
      f.observer.marked(135000);
      let respond!: (state: typeof f.client.recording) => void;
      f.client.getStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const pending = f.observer.client.call("GetRecordStatus");
      f.setNow(140000);
      if (event === "stop") f.stop();
      else f.client.emit("ConnectionClosed");
      respond({
        outputActive: true,
        outputPaused: false,
        outputDuration: 180000,
      });
      await pending;
      f.setNow(240000);
      expect(await f.duration()).toEqual({
        ok: true,
        durationMs: event === "stop" ? 140000 : 135000,
      });
    }
  });

  it("does not let an older concurrent status response replace the newest report", async () => {
    const f = fixture();
    f.observer.marked(135000);
    let respond!: (state: typeof f.client.recording) => void;
    f.client.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const pending = f.observer.client.call("GetRecordStatus");
    f.client.recording.outputDuration = 140000;
    await f.observer.client.call("GetRecordStatus");
    respond({ ...f.client.recording, outputDuration: 136000 });
    await pending;
    f.client.emit("ConnectionClosed");
    expect(await f.duration()).toEqual({ ok: true, durationMs: 140000 });
  });
});
