import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBSWebSocketError } from "obs-websocket-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSession } from "../../src/application/use-cases/index";
import { ObsWebsocketMarker } from "../../src/infrastructure/obs/obs-websocket-marker";
import { JsonlSessionRecorder } from "../../src/infrastructure/replay/jsonl-session-recorder";
import { FsHighlightRepository } from "../../src/infrastructure/storage/fs-highlight-repository";
import {
  at,
  deferred,
  fixture,
  pulse,
  pulses,
  quickPolicy,
} from "../application/fakes";
import { FakeObsClient } from "./obs-client-fake";

describe("StreamSession with OBS and file adapters", () => {
  let directory: string;
  let client: FakeObsClient;
  let marker: ObsWebsocketMarker;
  let session: StreamSession;
  let highlights: FsHighlightRepository;
  let recorder: JsonlSessionRecorder;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "heart-on-stream-highlight-session-"),
    );
    client = new FakeObsClient();
    marker = new ObsWebsocketMarker({ client });
    highlights = new FsHighlightRepository(directory);
    const f = fixture();
    recorder = new JsonlSessionRecorder(join(directory, "recordings"), {
      appVersion: "0.1.0",
      metricConfig: "pulse",
      startTimeUs: at(0),
    });
    session = new StreamSession(
      {
        source: f.source,
        publisher: f.publisher,
        marker,
        highlights,
        recorder,
        clock: f.clock,
        logger: f.logger,
      },
      { policy: quickPolicy },
    );
  });

  afterEach(async () => {
    await session.stopSession();
    await marker.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    { command: "End", restart: true },
    { command: "Delete all data", restart: true },
    { command: "Delete all data", restart: false },
  ])(
    "cancels a chapter with status pending after $command (recording replaced: $restart)",
    async ({ command, restart }) => {
      await marker.start();
      client.emit("RecordStateChanged", {
        outputActive: true,
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
      });
      const status = deferred<typeof client.recording>();
      client.getStatus.mockReturnValueOnce(status.promise);
      await session.startSession({
        consentRecorded: true,
        privacyMode: "highlightsOnly",
      });
      await session.ingestFrame(pulse(0));
      await pulses(session, 1, 2, 82);
      expect(client.requests).toEqual(["GetRecordStatus", "GetRecordStatus"]);
      if (command === "End") await session.stopSession();
      else await session.deleteAllData();
      if (restart) {
        client.emit("RecordStateChanged", {
          outputActive: false,
          outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
        });
        client.emit("RecordStateChanged", {
          outputActive: true,
          outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        });
      }
      status.resolve({ ...client.recording, outputDuration: 40_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(client.chapter).not.toHaveBeenCalled();
      expect(await new FsHighlightRepository(directory).list()).toMatchObject(
        command === "End" ? [{ recordingOffsetMs: null }] : [],
      );
    },
  );

  it("still marks a spike confirmed before End when the same OBS recording continues", async () => {
    await marker.start();
    client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    const status = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(status.promise);
    await session.startSession({
      consentRecorded: true,
      privacyMode: "highlightsOnly",
    });
    await session.ingestFrame(pulse(0));
    await pulses(session, 1, 2, 82);
    await session.stopSession();
    status.resolve({ ...client.recording, outputDuration: 40_000 });
    await session.settleChapters();
    expect(client.chapter).toHaveBeenCalledOnce();
    await highlights.list();
    expect(await new FsHighlightRepository(directory).list()).toMatchObject([
      { t: at(2), recordingOffsetMs: 40_000 },
    ]);
  });

  it.each(["split", "idle at delivery", "same file"] as const)(
    "binds a queued confirming pulse to its delivery recording with OBS %s",
    async (scenario) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const release = deferred<void>();
      try {
        client.recording.outputActive = scenario !== "idle at delivery";
        await marker.start();
        await session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
          recordingEnabled: true,
        });
        await session.ingestFrame(pulse(0));
        const writing = deferred<void>();
        const append = recorder.append.bind(recorder);
        vi.spyOn(recorder, "append").mockImplementationOnce(async (frame) => {
          writing.resolve();
          await release.promise;
          await append(frame);
        });
        const firstRise = session.ingestFrame(pulse(1, 82));
        await writing.promise;
        const confirming = session.ingestFrame(pulse(2, 82));
        const ending = session.stopSession();
        await vi.advanceTimersByTimeAsync(20);
        if (scenario === "split") {
          client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
        } else if (scenario === "idle at delivery") {
          client.recording.outputActive = true;
          client.emit("RecordStateChanged", {
            outputActive: true,
            outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
          });
        }
        await vi.advanceTimersByTimeAsync(20);
        release.resolve();
        await Promise.all([firstRise, confirming, ending]);
        await session.settleChapters();

        const sameFile = scenario === "same file";
        expect.soft(client.chapter).toHaveBeenCalledTimes(sameFile ? 1 : 0);
        expect(await highlights.list()).toMatchObject([
          { t: at(2), recordingOffsetMs: sameFile ? 12_345 : null },
        ]);
      } finally {
        release.resolve();
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "binds a spike to the recording at confirmation while highlight append is held (replaced: %s)",
    async (replaced) => {
      await marker.start();
      client.emit("RecordStateChanged", {
        outputActive: true,
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
      });
      await session.startSession({
        consentRecorded: true,
        privacyMode: "vibe",
      });
      await session.ingestFrame(pulse(0));
      await session.ingestFrame(pulse(1, 82));
      const writing = deferred<void>();
      const release = deferred<void>();
      const append = highlights.append.bind(highlights);
      vi.spyOn(highlights, "append").mockImplementationOnce(async (receipt) => {
        writing.resolve();
        await release.promise;
        await append(receipt);
      });
      const confirming = session.ingestFrame(pulse(2, 82));
      await writing.promise;
      const ending = session.stopSession();
      if (replaced) {
        client.emit("RecordStateChanged", {
          outputActive: false,
          outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
        });
        client.emit("RecordStateChanged", {
          outputActive: true,
          outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        });
      }
      release.resolve();
      await Promise.all([confirming, ending]);
      await session.settleChapters();
      expect(client.chapter).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(await highlights.list()).toMatchObject([
        { recordingOffsetMs: replaced ? null : 12_345 },
      ]);
    },
  );

  it("cancels a pending chapter from run one when deleting after run two", async () => {
    await marker.start();
    const status = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(status.promise);
    const start = { consentRecorded: true, privacyMode: "vibe" } as const;
    await session.startSession(start);
    await session.ingestFrame(pulse(0));
    await pulses(session, 1, 2, 82);
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    await session.stopSession();
    await session.startSession(start);
    await session.ingestFrame(pulse(3));
    await session.stopSession();
    await session.deleteAllData();
    status.resolve(client.recording);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.chapter).not.toHaveBeenCalled();
    expect(await highlights.list()).toEqual([]);

    await session.startSession(start);
    await session.ingestFrame(pulse(4));
    await pulses(session, 5, 6, 82);
    await session.settleChapters();
    expect(client.chapter).toHaveBeenCalledOnce();
    expect(await highlights.list()).toMatchObject([
      { t: at(6), recordingOffsetMs: 12_345 },
    ]);
  });

  it("saves the offset of a chapter sent before End even if OBS starts recording again", async () => {
    await marker.start();
    const acknowledgement = deferred<void>();
    client.chapter.mockReturnValueOnce(acknowledgement.promise);
    await session.startSession({ consentRecorded: true, privacyMode: "vibe" });
    await session.ingestFrame(pulse(0));
    await pulses(session, 1, 2, 82);
    await vi.waitFor(() => expect(client.chapter).toHaveBeenCalledOnce());
    await session.stopSession();
    client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    acknowledgement.resolve();
    await session.settleChapters();
    await highlights.list();
    const persisted = await new FsHighlightRepository(directory).list();
    expect(persisted).toMatchObject([{ t: at(2), recordingOffsetMs: 12_345 }]);
    expect(session.currentHighlights).toEqual(persisted);
  });

  it.each([
    "recording",
    "disconnected",
    "notRecording",
    "unsupported",
    "requestFailure",
  ])(
    "persists a spike receipt and deletes all owned data when OBS is %s",
    async (obsState) => {
      client.recording.outputActive = obsState !== "notRecording";
      client.recording.outputDuration = 40_000;
      if (obsState !== "disconnected") await marker.start();
      if (obsState === "unsupported") {
        client.chapter.mockRejectedValueOnce(
          new OBSWebSocketError(204, "Unknown request"),
        );
      }
      if (obsState === "requestFailure") {
        client.chapter.mockRejectedValueOnce(new Error("Request failed"));
      }
      await session.startSession({
        consentRecorded: true,
        privacyMode: "highlightsOnly",
        recordingEnabled: true,
      });
      await session.ingestFrame(pulse(0));
      await session.ingestFrame({
        kind: "talking",
        t: at(1),
        detected: true,
        stable: true,
      });
      await pulses(session, 1, 2, 90);
      expect(session.panelState.active).toBe(true);
      if (obsState === "recording") {
        await vi.waitFor(() =>
          expect(session.currentHighlights[0]?.recordingOffsetMs).toBe(40_000),
        );
        await highlights.list();
      }
      const persisted = await new FsHighlightRepository(directory).list();
      expect(persisted).toEqual([
        {
          t: at(2),
          sessionStartedAt: at(0),
          sessionOffsetUs: 2_000_000,
          recordingOffsetMs: obsState === "recording" ? 40_000 : null,
          label: "spike +20 vs baseline",
          deltaBpm: 20,
          talkingRecent: true,
        },
      ]);
      if (obsState === "recording") {
        expect(client.chapter).toHaveBeenCalledExactlyOnceWith({
          chapterName: "spike +20 vs baseline",
        });
      }
      expect(marker.connectionStatus.status).toBe(
        obsState === "recording"
          ? "connected"
          : obsState === "unsupported" || obsState === "requestFailure"
            ? "error"
            : obsState,
      );
      expect(await readdir(join(directory, "recordings"))).toHaveLength(1);
      await session.deleteAllData();
      expect(await readdir(directory)).toEqual(["recordings"]);
      expect(await readdir(join(directory, "recordings"))).toEqual([]);
      expect(await new FsHighlightRepository(directory).list()).toEqual([]);
    },
  );
});
