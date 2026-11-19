import { EventSubscription, OBSWebSocketError } from "obs-websocket-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoopMarker } from "../../src/infrastructure/obs/noop-marker";
import {
  type ObsConnectionStatus,
  ObsWebsocketMarker,
} from "../../src/infrastructure/obs/obs-websocket-marker";
import {
  deferred,
  pulses,
  quickPolicy,
  fixture as sessionFixture,
} from "../application/fakes";
import { FakeObsClient } from "./obs-client-fake";

describe("ObsWebsocketMarker", () => {
  let client: FakeObsClient;
  let marker: ObsWebsocketMarker;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FakeObsClient();
    marker = new ObsWebsocketMarker({ client });
  });

  afterEach(async () => {
    await marker.stop();
    vi.useRealTimers();
  });

  it("does no I/O before start and returns disconnected, including when disabled", async () => {
    expect(client.connect).not.toHaveBeenCalled();
    expect(marker.connectionStatus.status).toBe("disconnected");
    for (const adapter of [marker, new NoopMarker()]) {
      expect(await adapter.createChapter("spike +10 vs baseline")).toEqual({
        status: "unavailable",
        reason: "disconnected",
      });
    }
    expect(client.requests).toEqual([]);
    // Construct the actual installed v5 client without opening a connection.
    expect(new ObsWebsocketMarker().connectionStatus.status).toBe(
      "disconnected",
    );
  });

  it.each([0, 12_345])(
    "creates an unchanged relative-change chapter with recording offset %i ms",
    async (offset) => {
      client.recording.outputDuration = offset;
      await marker.start();
      await marker.start();
      expect(client.connect).toHaveBeenCalledExactlyOnceWith(
        "ws://127.0.0.1:4455",
        undefined,
        { eventSubscriptions: EventSubscription.Outputs },
      );
      const label = "spike +15 vs baseline";
      expect(await marker.createChapter(label)).toEqual({
        status: "created",
        recordingOffsetMs: offset,
      });
      expect(client.chapter).toHaveBeenCalledExactlyOnceWith({
        chapterName: label,
      });
      expect(client.requests).toEqual([
        "GetRecordStatus", // Initial panel status.
        "GetRecordStatus",
        "CreateRecordChapter",
      ]);
      expect(marker.connectionStatus.status).toBe("connected");
    },
  );

  it.each(["ws://127.0.0.1:4456", "ws://localhost:4455", "ws://[::1]:4455"])(
    "supports local OBS authentication at %s",
    async (url) => {
      marker = new ObsWebsocketMarker({
        client,
        url,
        password: "test-password",
      });
      await marker.start();
      expect(client.connect).toHaveBeenCalledExactlyOnceWith(
        url,
        "test-password",
        {
          eventSubscriptions: EventSubscription.Outputs,
        },
      );
    },
  );

  it.each([
    "wss://example.com:4455",
    "wss://localhost:4455",
    "ws://example.com:4455",
    "ws://192.168.1.10:4455",
    "ws://localhost.example.com:4455",
    "ws://localhost:4455@example.com",
    "ws://127.1:4455",
    "ws://[0:0:0:0:0:0:0:1]:4455",
    "ws://localhost:65536",
    "ws://demo:secret@localhost:4455",
    "http://localhost:4455",
    "",
  ])("refuses %j without connecting or retrying", async (url) => {
    marker = new ObsWebsocketMarker({ client, url, password: "test-password" });
    await marker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.connect).not.toHaveBeenCalled();
    expect(await marker.createChapter("spike +15 vs baseline")).toEqual({
      status: "unavailable",
      reason: "disconnected",
    });
    expect(client.requests).toEqual([]);
    expect(marker.connectionStatus).toEqual({
      status: "error",
      message:
        "OBS connection disabled. Set OBS_WS_URL to a ws:// URL on 127.0.0.1, localhost, or [::1].",
    });
  });

  it("reports notRecording immediately and rechecks recording on each chapter", async () => {
    client.recording.outputActive = false;
    await marker.start();
    expect(marker.connectionStatus.status).toBe("notRecording");
    expect(await marker.createChapter("spike +10 vs baseline")).toEqual({
      status: "unavailable",
      reason: "notRecording",
    });
    expect(client.chapter).not.toHaveBeenCalled();
    client.recording.outputActive = true;
    expect(await marker.createChapter("spike +10 vs baseline")).toMatchObject({
      status: "created",
    });
  });

  it.each(["GetRecordStatus", "CreateRecordChapter"])(
    "rejects unexpected %s failures for the application's local-highlight fallback",
    async (request) => {
      await marker.start();
      const error = new OBSWebSocketError(702, "Unexpected output failure");
      if (request === "GetRecordStatus")
        client.getStatus.mockRejectedValueOnce(error);
      else client.chapter.mockRejectedValueOnce(error);
      await expect(marker.createChapter("spike +10 vs baseline")).rejects.toBe(
        error,
      );
      expect(marker.connectionStatus.status).toBe("error");
      expect(marker.connectionStatus.message).not.toContain(error.message);
      // Request errors do not poison subsequent chapter attempts.
      expect(await marker.createChapter("spike +10 vs baseline")).toMatchObject(
        {
          status: "created",
        },
      );
    },
  );

  it("shares one timeout budget between the status query and chapter acknowledgement", async () => {
    await marker.start();
    const status = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(status.promise);
    client.chapter.mockReturnValueOnce(new Promise(() => {}));
    const chapter = marker.createChapter("spike +10 vs baseline");
    const rejected = expect(chapter).rejects.toThrow("OBS request timed out");
    await vi.advanceTimersByTimeAsync(4_000);
    status.resolve(client.recording);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.chapter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new OBSWebSocketError(204, "Unknown request"),
    new OBSWebSocketError(
      702,
      "Verify that the output being used supports chapter markers.",
    ),
  ])(
    "returns unsupported for an older OBS or unsupported recording format: %s",
    async (error) => {
      await marker.start();
      client.chapter.mockRejectedValueOnce(error);
      expect(await marker.createChapter("spike +10 vs baseline")).toEqual({
        status: "unavailable",
        reason: "unsupported",
      });
      expect(marker.connectionStatus).toEqual({
        status: "error",
        message: "OBS recording chapters are unsupported.",
      });
    },
  );

  it("handles recording stopping between the status query and chapter request", async () => {
    await marker.start();
    client.chapter.mockRejectedValueOnce(
      new OBSWebSocketError(501, "Output stopped"),
    );
    expect(await marker.createChapter("spike +10 vs baseline")).toEqual({
      status: "unavailable",
      reason: "notRecording",
    });
    expect(marker.connectionStatus.status).toBe("notRecording");
  });

  it("notifies status subscribers, isolates their errors, and supports unsubscribe", async () => {
    const states: ObsConnectionStatus[] = [];
    marker.subscribeStatus(() => {
      throw new Error("Panel failed");
    });
    const unsubscribe = marker.subscribeStatus((state) => {
      states.push(state);
      Object.assign(state, { status: "error" });
    });
    expect(states).toHaveLength(1);
    expect(marker.connectionStatus.status).toBe("disconnected");
    await marker.start();
    expect(marker.connectionStatus.status).toBe("connected");
    client.emit("RecordStateChanged", { outputActive: false });
    expect(marker.connectionStatus.status).toBe("notRecording");
    client.emit("RecordStateChanged", { outputActive: true });
    expect(marker.connectionStatus.status).toBe("connected");
    const count = states.length;
    unsubscribe();
    await marker.stop();
    expect(states).toHaveLength(count);
  });

  it("returns disconnected without requesting and reconnects after connection loss", async () => {
    await marker.start();
    client.requests.length = 0;
    client.emit("ConnectionClosed", new Error("Connection lost"));
    expect(marker.connectionStatus.status).toBe("disconnected");
    expect(await marker.createChapter("spike +10 vs baseline")).toEqual({
      status: "unavailable",
      reason: "disconnected",
    });
    expect(client.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(marker.connectionStatus.status).toBe("connected");
    expect(client.listenerCount("ConnectionClosed")).toBe(1);
    expect(await marker.createChapter("spike +10 vs baseline")).toMatchObject({
      status: "created",
    });
  });

  it("contains initial connection failures, caps backoff, and resets it on recovery", async () => {
    client.connect.mockRejectedValue(new Error("Connection refused"));
    await expect(marker.start()).resolves.toBeUndefined();
    expect(marker.connectionStatus.status).toBe("error");
    for (const [index, delay] of [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.connect).toHaveBeenCalledTimes(index + 2);
    }
    client.connect.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(marker.connectionStatus.status).toBe("connected");
    client.emit("ConnectionError", new Error("Connection failed"));
    client.emit("ConnectionClosed", new Error("Connection lost"));
    const attempts = client.connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(client.connect).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connect).toHaveBeenCalledTimes(attempts + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains initial status failures and reports subsequent request errors", async () => {
    client.getStatus.mockRejectedValueOnce(new Error("Status unavailable"));
    await expect(marker.start()).resolves.toBeUndefined();
    expect(marker.connectionStatus.status).toBe("error");
    expect(await marker.createChapter("spike +10 vs baseline")).toMatchObject({
      status: "created",
    });
    client.getStatus.mockResolvedValueOnce({
      outputActive: true,
      outputPaused: false,
      outputDuration: Number.NaN,
    });
    await expect(marker.createChapter("spike +10 vs baseline")).rejects.toThrow(
      "Invalid OBS recording status",
    );
  });

  it("rediscovers a running recording after the first status times out and marks both later spikes", async () => {
    const lateStatus = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(lateStatus.promise);
    const starting = marker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(marker.captureRecording()).toBeNull();
    expect(client.getStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(client.getStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    const ports = sessionFixture({ policy: quickPolicy });
    ports.marker.captureRecording = marker.captureRecording.bind(marker);
    ports.marker.createChapter = marker.createChapter.bind(marker);
    await ports.session.startSession({
      consentRecorded: true,
      privacyMode: "highlightsOnly",
    });
    await pulses(ports.session, 0, 3);
    for (const [seconds, offset] of [
      [5, 20_000],
      [15, 40_000],
    ] as const) {
      client.recording.outputDuration = offset;
      await pulses(ports.session, seconds - 1, seconds, 88);
      await ports.session.settleChapters();
      await pulses(ports.session, seconds + 1, seconds + 3);
    }
    expect(client.chapter).toHaveBeenCalledTimes(2);
    expect(
      ports.session.currentHighlights.map((item) => item.recordingOffsetMs),
    ).toEqual([20_000, 40_000]);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.getStatus).toHaveBeenCalledTimes(4);
    lateStatus.resolve({
      outputActive: false,
      outputPaused: false,
      outputDuration: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(marker.captureRecording()).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off across a bounded number of status retries while the socket stays connected", async () => {
    client.getStatus.mockRejectedValue(new Error("Status unavailable"));
    await marker.start();
    for (const [index, delay] of [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.getStatus).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getStatus).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getStatus).toHaveBeenCalledTimes(7);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(marker.captureRecording()).toBeNull();
    client.emit("RecordStateChanged", {
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
    });
    expect(marker.captureRecording()).not.toBeNull();
  });

  it.each(["a recording event", "stop"])(
    "cancels pending status rediscovery on %s",
    async (action) => {
      client.getStatus.mockRejectedValueOnce(new Error("Status unavailable"));
      await marker.start();
      expect(vi.getTimerCount()).toBe(1);
      if (action === "stop") await marker.stop();
      else {
        client.emit("RecordStateChanged", {
          outputActive: true,
          outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        });
        expect(marker.captureRecording()).not.toBeNull();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.getStatus).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels retries and removes listeners on stop, and can restart", async () => {
    await marker.start();
    client.emit("ConnectionError", new Error("Connection failed"));
    expect(vi.getTimerCount()).toBe(1);
    await marker.stop();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.eventNames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await marker.start();
    expect(client.connect).toHaveBeenCalledTimes(2);
    client.disconnect.mockRejectedValueOnce(new Error("Disconnect failed"));
    await expect(marker.stop()).resolves.toBeUndefined();
  });

  it("does not revive a stopped in-flight connection or retry it", async () => {
    let finishConnect = () => {};
    client.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = resolve;
        }),
    );
    const start = marker.start();
    expect(marker.start()).toBe(start);
    await marker.stop();
    finishConnect();
    await start;
    expect(marker.connectionStatus.status).toBe("disconnected");
    expect(client.requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending query on disconnect without sending into a reconnected recording", async () => {
    await marker.start();
    let finishStatus = (_status: typeof client.recording) => {};
    client.getStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    );
    const chapter = marker.createChapter("spike +10 vs baseline");
    const rejected = expect(chapter).rejects.toThrow(
      "disconnected during request",
    );
    client.emit("ConnectionClosed", new Error("Connection lost"));
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    finishStatus({
      outputActive: true,
      outputPaused: false,
      outputDuration: 1,
    });
    expect(client.chapter).not.toHaveBeenCalled();
    expect(marker.connectionStatus.status).toBe("connected");
  });

  it.each([
    { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" },
    { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" },
  ])("discards a recording status reply after $outputState", async (event) => {
    await marker.start();
    const status = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(status.promise);
    const chapter = marker.createChapter("spike +10 vs baseline");
    client.emit("RecordStateChanged", event);
    status.resolve({ ...client.recording, outputDuration: 40_000 });
    expect(await chapter).toEqual({
      status: "unavailable",
      reason: "notRecording",
    });
    expect(client.chapter).not.toHaveBeenCalled();
  });

  it("keeps a chapter confirmed before a file split out of the new file", async () => {
    await marker.start();
    const token = marker.captureRecording();
    const status = deferred<typeof client.recording>();
    client.getStatus.mockReturnValueOnce(status.promise);
    const chapter = marker.createChapter("Before split", undefined, token);
    client.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
    status.resolve({ ...client.recording, outputDuration: 60_000 });

    expect(await chapter).toEqual({
      status: "unavailable",
      reason: "notRecording",
    });
    expect(client.chapter).not.toHaveBeenCalled();
    const nextToken = marker.captureRecording();
    expect(nextToken).not.toBeNull();
    expect(nextToken).not.toBe(token);
    expect(
      await marker.createChapter("After split", undefined, nextToken),
    ).toMatchObject({ status: "created" });
    expect(client.chapter).toHaveBeenCalledExactlyOnceWith({
      chapterName: "After split",
    });
  });

  it.each(["GetRecordStatus", "CreateRecordChapter"])(
    "bounds a stalled %s request so session ingestion can continue",
    async (request) => {
      await marker.start();
      if (request === "GetRecordStatus") {
        client.getStatus.mockImplementationOnce(() => new Promise(() => {}));
      } else {
        client.chapter.mockImplementationOnce(() => new Promise(() => {}));
      }
      const chapter = marker.createChapter("spike +10 vs baseline");
      const rejected = expect(chapter).rejects.toThrow("OBS request timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(marker.connectionStatus.status).toBe("error");
      expect(vi.getTimerCount()).toBe(0);
      expect(await marker.createChapter("spike +10 vs baseline")).toMatchObject(
        {
          status: "created",
        },
      );
    },
  );

  it("cancels in-flight chapters on stop without reviving status on a late response", async () => {
    await marker.start();
    let finishChapter = () => {};
    client.chapter.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishChapter = resolve;
        }),
    );
    const chapter = marker.createChapter("spike +10 vs baseline");
    const rejected = expect(chapter).rejects.toThrow(
      "disconnected during request",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.chapter).toHaveBeenCalledTimes(1);
    await marker.stop();
    await rejected;
    finishChapter();
    await vi.advanceTimersByTimeAsync(0);
    expect(marker.connectionStatus.status).toBe("disconnected");
    expect(vi.getTimerCount()).toBe(0);
  });
});
