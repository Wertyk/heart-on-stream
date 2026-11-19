import { decodeMetrics, Metrics } from "@smartspectra/node-sdk/messages";
import type {
  RendererSmartSpectraOptions,
  SmartSpectraSDK,
} from "@smartspectra/node-sdk/renderer";
import { describe, expect, it, vi } from "vitest";
import type { SdkMetrics } from "../../src/infrastructure/smartspectra/metrics-mapper";
import {
  countFrame,
  sampleFps,
} from "../../src/infrastructure/smartspectra/sdk-host/fps-counter";
import { requestedMetrics } from "../../src/infrastructure/smartspectra/sdk-host/metric-config";
import {
  type SdkDebugState,
  SdkHost,
} from "../../src/infrastructure/smartspectra/sdk-host/sdk-host";
import type { HeartBridge } from "../../src/shared/ipc-contract";

describe("minimal metric configurations", () => {
  it("requests only pulse rate, waveform, and talking in config (a)", () => {
    expect(requestedMetrics("a")).toEqual([15, 16, 13]);
  });
  it("adds only chest breathing and breathing rate in config (b)", () => {
    expect(requestedMetrics("b")).toEqual([15, 16, 13, 0, 2]);
  });
  it("returns independent lists for every SDK instance", () => {
    requestedMetrics("a").push(17);
    expect(requestedMetrics("a")).toEqual([15, 16, 13]);
  });
});

describe("frame rate counter", () => {
  it("counts only frames sent through and leaves the previous state unchanged", () => {
    const initial = Object.freeze({ startedAtMs: 1000, frames: 0 });
    const counted = countFrame(countFrame(initial, true), false);
    expect(sampleFps(counted, 2000).fps).toBe(1);
    expect(initial.frames).toBe(0);
  });
  it("accounts for timer delays, resets the window, and reports zero when stalled", () => {
    const sample = sampleFps({ startedAtMs: 500, frames: 60 }, 2500);
    expect(sample.fps).toBe(30);
    expect(sampleFps(sample.next, 3500).fps).toBe(0);
  });
  it.each([500, 499])(
    "returns zero for nonpositive elapsed time at %d",
    (now) => {
      expect(sampleFps({ startedAtMs: 500, frames: 3 }, now).fps).toBe(0);
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeStream(deviceId: string) {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  });
  const other = { stop: vi.fn() };
  const stream = {
    getTracks: () => [track, other],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track, other };
}

function fakeSdk() {
  return {
    on: vi.fn().mockReturnThis(),
    requestInsight: vi.fn<SmartSpectraSDK["requestInsight"]>(),
    useMediaStream: vi.fn<SmartSpectraSDK["useMediaStream"]>().mockReturnThis(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
}

function fixture() {
  const { stream, track, other } = fakeStream("selected-camera");
  const sdk = fakeSdk();
  const bridge = {
    getCameraAccessStatus: vi.fn<HeartBridge["getCameraAccessStatus"]>(
      async () => "unknown",
    ),
    beginMeasurement: vi.fn<HeartBridge["beginMeasurement"]>(async () => ({
      apiKey: "test-credential",
      captureGeneration: 1,
    })),
    endMeasurement: vi.fn(async () => {}),
    noticeEnd: vi.fn<HeartBridge["noticeEnd"]>(),
    pushFrame: vi.fn<HeartBridge["pushFrame"]>(),
  };
  const mediaDevices = {
    getUserMedia: vi.fn(async () => stream),
    abort: vi.fn(),
  };
  const onState = vi.fn<(state: SdkDebugState) => void>();
  const cancelTimer = vi.fn();
  let tick = () => {};
  let now = 0;
  const dependencies = {
    bridge,
    mediaDevices,
    createSdk: vi.fn((_options: RendererSmartSpectraOptions) => sdk),
    decodeMetrics: vi.fn<(buffer: Uint8Array) => SdkMetrics>(decodeMetrics),
    nowUs: vi.fn(() => 1_800_000_000_000_000),
    now: () => now,
    schedule: (callback: () => void) => {
      tick = callback;
      return cancelTimer;
    },
    onState,
    onStream: vi.fn(),
    onCameraDisconnected: vi.fn(),
  };
  const host = new SdkHost(dependencies);
  function listener<T>(event: string, instance = sdk): T {
    const call = instance.on.mock.calls.find(([name]) => name === event);
    if (!call) throw new Error(`Missing listener for ${event}`);
    return call[1] as T;
  }
  return {
    host,
    sdk,
    bridge,
    mediaDevices,
    stream,
    track,
    other,
    dependencies,
    cancelTimer,
    listener,
    state: () => onState.mock.lastCall?.[0],
    tick: (time: number) => {
      now = time;
      tick();
    },
  };
}

describe("SDK capture host with fake media and SDK", () => {
  it("starts measurement without requesting insights or registering an insight listener", async () => {
    const f = fixture();
    await f.host.start("camera", "b");
    await f.host.stop();
    expect(f.sdk.start).toHaveBeenCalledOnce();
    expect(f.sdk.requestInsight).not.toHaveBeenCalled();
    expect(f.sdk.on.mock.calls.map(([event]) => event)).not.toContain(
      "insight",
    );
  });

  it("forwards final destroy status on close without reentering SDK destruction", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    f.sdk.destroy.mockImplementation(() =>
      f.listener<(status: number) => void>("processingStatus")(1),
    );
    await f.host.dispose();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.bridge.pushFrame).toHaveBeenCalledWith({
      captureGeneration: 1,
      frame: { kind: "processing", status: "idle", t: f.dependencies.nowUs() },
    });
    expect(f.bridge.noticeEnd).toHaveBeenCalledBefore(f.bridge.pushFrame);
    expect(f.bridge.pushFrame.mock.invocationCallOrder[0]).toBeLessThan(
      f.bridge.endMeasurement.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("forwards final SDK shutdown events before asking main to finish the recording", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    const processing = f.listener<(status: number) => void>("processingStatus");
    f.sdk.stop.mockImplementation(async () => {
      processing(4);
      f.listener<(buffer: Uint8Array) => void>("metrics")(
        Metrics.encode({
          cardio: { pulseRate: [{ value: 72, timestamp: 100 }] },
        }).finish(),
      );
      processing(1);
    });
    await f.host.stop();
    expect(
      f.bridge.pushFrame.mock.calls.map(([{ frame }]) => frame.kind),
    ).toEqual(["processing", "pulseRate", "processing"]);
    expect(f.bridge.pushFrame.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.bridge.endMeasurement.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.state()?.processingStatus).toBe("Idle");
    expect(f.state()?.pulse).toBeNull();
    processing(3);
    expect(f.bridge.pushFrame).toHaveBeenCalledTimes(3);
  });

  it("maps all metric channels and status events through the typed frame bridge in delivery order", async () => {
    const f = fixture();
    await f.host.start("camera", "b", true);
    expect(f.bridge.beginMeasurement).toHaveBeenCalledWith({
      metricConfig: "b",
      recordSession: true,
    });
    f.listener<(status: number) => void>("processingStatus")(3);
    f.listener<(code: number, timestamp: number, hint: string) => void>(
      "validationStatus",
    )(5, 100, "More light.");
    const buffer = Metrics.encode({
      cardio: {
        pulseRate: [
          { value: 72, confidence: 90, stable: true, timestamp: 300 },
        ],
        arterialPressureTrace: [{ value: 0.2, stable: true, timestamp: 200 }],
      },
      breathing: {
        rate: [{ value: 15, confidence: 80, stable: true, timestamp: 400 }],
        upperTrace: [{ value: 0.4, stable: true, timestamp: 500 }],
      },
      face: { talking: [{ detected: true, stable: true, timestamp: 600 }] },
    }).finish();
    f.listener<(buffer: Uint8Array) => void>("metrics")(buffer);
    expect(f.dependencies.decodeMetrics).toHaveBeenCalledWith(buffer);
    expect(
      f.bridge.pushFrame.mock.calls.map(
        ([payload]) => payload.captureGeneration,
      ),
    ).toEqual(Array(7).fill(1));
    expect(f.bridge.pushFrame.mock.calls.map(([{ frame }]) => frame)).toEqual([
      { kind: "processing", status: "running", t: f.dependencies.nowUs() },
      { kind: "validation", code: "tooDark", t: 100, hint: "More light." },
      {
        kind: "pulseWave",
        samples: [{ value: expect.closeTo(0.2), stable: true, t: 200 }],
      },
      {
        kind: "pulseRate",
        reading: { value: 72, confidence: 90, stable: true, t: 300 },
      },
      {
        kind: "breathingRate",
        reading: { value: 15, confidence: 80, stable: true, t: 400 },
      },
      {
        kind: "breathingWave",
        samples: [{ value: expect.closeTo(0.4), stable: true, t: 500 }],
      },
      { kind: "talking", detected: true, stable: true, t: 600 },
    ]);
    await f.host.stop();
  });

  it("drops absent, null, and zero timestamps from every metric channel before mapping", async () => {
    const f = fixture();
    await f.host.start("camera", "b");
    const samples = [
      { value: Number.NaN },
      { value: Number.NaN, timestamp: null },
      { value: Number.NaN, timestamp: 0 },
      { value: Number.NaN, timestamp: 0n },
      { value: Number.NaN, timestamp: { toNumber: () => 0 } },
      { value: 72, timestamp: 100n },
    ];
    f.dependencies.decodeMetrics.mockReturnValue({
      cardio: { pulseRate: samples, arterialPressureTrace: samples },
      breathing: { rate: samples, upperTrace: samples },
      face: { talking: samples },
    });
    const metrics = f.listener<(buffer: Uint8Array) => void>("metrics");
    metrics(new Uint8Array());
    expect(f.bridge.pushFrame.mock.calls.map(([{ frame }]) => frame)).toEqual([
      { kind: "talking", t: 100, detected: false, stable: false },
      {
        kind: "pulseRate",
        reading: { value: 72, t: 100, confidence: 0, stable: false },
      },
      { kind: "pulseWave", samples: [{ value: 72, t: 100, stable: false }] },
      {
        kind: "breathingRate",
        reading: { value: 72, t: 100, confidence: 0, stable: false },
      },
      {
        kind: "breathingWave",
        samples: [{ value: 72, t: 100, stable: false }],
      },
    ]);
    expect(f.state()?.error).toBe("");
    f.bridge.pushFrame.mockClear();
    // Exercise the real decoder's default zero-valued protobuf timestamps too.
    f.dependencies.decodeMetrics.mockImplementation(decodeMetrics);
    metrics(
      Metrics.encode({
        cardio: { pulseRate: [{ value: 70 }, { value: 80, timestamp: 0 }] },
      }).finish(),
    );
    expect(f.bridge.pushFrame).not.toHaveBeenCalled();
    await f.host.stop();
  });

  it("catches decoding and mapping failures per event and accepts later frames without stopping", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    const metrics = f.listener<(buffer: Uint8Array) => void>("metrics");
    const validation =
      f.listener<(code: number, timestamp: number, hint: string) => void>(
        "validationStatus",
      );
    const processing = f.listener<(status: number) => void>("processingStatus");
    f.dependencies.decodeMetrics.mockImplementationOnce(() => {
      throw new Error("test-credential private payload");
    });
    expect(() => metrics(new Uint8Array())).not.toThrow();
    expect(f.state()?.error).toBe("Unable to map the SDK metrics event.");
    f.dependencies.decodeMetrics.mockReturnValueOnce({
      cardio: { pulseRate: [{ value: Number.NaN, timestamp: 10 }] },
    });
    metrics(new Uint8Array());
    expect(f.state()?.error).toContain("metrics");
    validation(0, Number.NaN, "Ready");
    expect(f.state()?.error).toContain("validationStatus");
    f.dependencies.nowUs.mockReturnValueOnce(Number.NaN);
    processing(3);
    expect(f.state()?.error).toContain("processingStatus");
    expect(f.bridge.pushFrame).not.toHaveBeenCalled();
    validation(0, 100, "Ready");
    processing(3);
    metrics(
      Metrics.encode({
        cardio: { pulseRate: [{ value: 72, timestamp: 200 }] },
      }).finish(),
    );
    expect(f.bridge.pushFrame).toHaveBeenCalledTimes(3);
    expect(f.sdk.stop).not.toHaveBeenCalled();
    expect(f.state()?.active).toBe(true);
    expect(f.state()?.pulse?.value).toBe(72);
    await f.host.stop();
    metrics(new Uint8Array());
    validation(0, 300, "Late");
    processing(3);
    expect(f.bridge.pushFrame).toHaveBeenCalledTimes(3);
  });

  it("selects a video-only device, supplies the stream before Start, and disables telemetry", async () => {
    const f = fixture();
    expect(f.bridge.beginMeasurement).not.toHaveBeenCalled();
    await f.host.start("obs-virtual-camera", "a");
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      {
        audio: false,
        video: {
          deviceId: { exact: "obs-virtual-camera" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      },
      false,
    );
    expect(f.dependencies.createSdk).toHaveBeenCalledWith({
      apiKey: "test-credential",
      requestedMetrics: [15, 16, 13],
      enableTelemetry: false,
      enableAccumulatedOutput: false,
    });
    expect(f.sdk.useMediaStream).toHaveBeenCalledWith(f.stream);
    expect(f.sdk.useMediaStream.mock.invocationCallOrder[0]).toBeLessThan(
      f.sdk.start.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.dependencies.onStream).toHaveBeenCalledWith(f.stream);
    expect(f.state()?.active).toBe(true);
    await f.host.stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.cancelTimer).toHaveBeenCalledOnce();
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it("releases all tracks and the SDK on pause, then resumes frames on the actual selected camera", async () => {
    const f = fixture();
    const replacement = fakeSdk();
    const next = fakeStream("selected-camera");
    f.dependencies.createSdk
      .mockReturnValueOnce(f.sdk)
      .mockReturnValueOnce(replacement);
    f.mediaDevices.getUserMedia
      .mockResolvedValueOnce(f.stream)
      .mockResolvedValueOnce(next.stream);
    const stop = deferred<void>();
    f.sdk.stop.mockReturnValue(stop.promise);
    await f.host.start("provisional-camera", "b", true);
    const lateMetrics = f.listener<(buffer: Uint8Array) => void>("metrics");
    const data = Metrics.encode({
      cardio: { pulseRate: [{ value: 72, timestamp: 100 }] },
    }).finish();

    const pausing = f.host.setPaused(true, 1);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.other.stop).toHaveBeenCalledOnce();
    expect(f.dependencies.onStream).toHaveBeenLastCalledWith(null);
    expect(f.cancelTimer).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({ active: false, fps: 0 });
    await Promise.resolve();
    expect(f.sdk.stop).toHaveBeenCalledOnce();
    lateMetrics(data);
    expect(f.bridge.pushFrame).not.toHaveBeenCalled();
    const resuming = f.host.setPaused(false, 2);
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    stop.resolve();
    await Promise.all([pausing, resuming]);

    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.sdk.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      f.dependencies.createSdk.mock.invocationCallOrder[1] ?? 0,
    );
    expect(f.dependencies.createSdk.mock.calls[1]).toEqual(
      f.dependencies.createSdk.mock.calls[0],
    );
    expect(f.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          deviceId: { exact: "selected-camera" },
        }),
      }),
      true,
    );
    expect(replacement.useMediaStream).toHaveBeenCalledWith(next.stream);
    expect(f.bridge.beginMeasurement).toHaveBeenCalledOnce();
    expect(f.bridge.endMeasurement).not.toHaveBeenCalled();
    lateMetrics(data);
    f.listener<(buffer: Uint8Array) => void>("metrics", replacement)(data);
    expect(f.bridge.pushFrame).toHaveBeenCalledExactlyOnceWith({
      captureGeneration: 2,
      frame: expect.objectContaining({ kind: "pulseRate" }),
    });
    await f.host.stop();
    expect(replacement.destroy).toHaveBeenCalledOnce();
    expect(next.track.stop).toHaveBeenCalledOnce();
  });

  it("serializes rapid toggles and drops a stream that resolves after a second Pause", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    await f.host.setPaused(true, 1);
    const pending = deferred<MediaStream>();
    const stale = fakeStream("selected-camera");
    f.mediaDevices.getUserMedia.mockReturnValueOnce(pending.promise);
    const resuming = f.host.setPaused(false, 2);
    await Promise.resolve();
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    const pausing = f.host.setPaused(true, 2);
    const resumingAgain = f.host.setPaused(false, 3);
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    pending.resolve(stale.stream);
    await Promise.all([resuming, pausing, resumingAgain]);
    expect(stale.track.stop).toHaveBeenCalledOnce();
    expect(f.dependencies.onStream).not.toHaveBeenCalledWith(stale.stream);
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(f.dependencies.createSdk).toHaveBeenCalledTimes(2);
    expect(f.state()?.active).toBe(true);
    await f.host.stop();
  });

  it("does not restart after End while a Resume is queued behind SDK stop", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    const stop = deferred<void>();
    f.sdk.stop.mockReturnValue(stop.promise);
    const pausing = f.host.setPaused(true, 1);
    await Promise.resolve();
    const resuming = f.host.setPaused(false, 2);
    const ending = f.host.stop();
    stop.resolve();
    await Promise.all([pausing, resuming, ending]);
    await f.host.setPaused(false, 2);
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
    expect(f.state()?.active).toBe(false);
  });

  it("cancels a pending SDK start on Pause without ending the main session", async () => {
    const f = fixture();
    const firstStart = deferred<void>();
    f.sdk.start.mockReturnValueOnce(firstStart.promise);
    const starting = f.host.start("camera", "a");
    await vi.waitFor(() => expect(f.sdk.start).toHaveBeenCalledOnce());
    const pausing = f.host.setPaused(true, 1);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    firstStart.resolve();
    await Promise.all([starting, pausing]);
    expect(f.dependencies.onStream).toHaveBeenLastCalledWith(null);
    expect(f.state()?.active).toBe(false);
    expect(f.bridge.endMeasurement).not.toHaveBeenCalled();
    await f.host.setPaused(false, 2);
    expect(f.sdk.start).toHaveBeenCalledTimes(2);
    expect(f.bridge.beginMeasurement).toHaveBeenCalledOnce();
    expect(f.state()?.active).toBe(true);
    await f.host.stop();
  });

  it("does not access a camera or construct an SDK when main has no key", async () => {
    const f = fixture();
    f.bridge.beginMeasurement.mockResolvedValue(null);
    await f.host.start("camera", "a");
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(f.sdk.start).not.toHaveBeenCalled();
    expect(f.state()?.error).toContain("Unable to start");
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it.each(["denied", "restricted"] as const)(
    "skips the credential, camera and SDK when macOS camera access is %s",
    async (status) => {
      const f = fixture();
      f.bridge.getCameraAccessStatus.mockResolvedValueOnce(status);
      await f.host.start("camera", "b", true);
      expect(f.bridge.getCameraAccessStatus).toHaveBeenCalledOnce();
      expect(f.bridge.beginMeasurement).not.toHaveBeenCalled();
      expect(f.bridge.endMeasurement).not.toHaveBeenCalled();
      expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(f.dependencies.createSdk).not.toHaveBeenCalled();
      expect(f.state()).toMatchObject({
        active: false,
        busy: false,
        error:
          "macOS is blocking camera access for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Enable it in System Settings > Privacy & Security > Camera, then quit and reopen that app and start Heart on Stream again.",
      });

      await f.host.start("camera", "b", true);
      expect(f.bridge.getCameraAccessStatus).toHaveBeenCalledTimes(2);
      expect(f.state()).toMatchObject({ active: true, error: "" });
      await f.host.stop();
    },
  );

  it("does not begin measurement after Stop during the camera status check", async () => {
    const f = fixture();
    const status = deferred<"granted">();
    f.bridge.getCameraAccessStatus.mockReturnValue(status.promise);
    const starting = f.host.start("camera", "a");
    await Promise.resolve();
    expect(f.bridge.getCameraAccessStatus).toHaveBeenCalledOnce();
    const stopping = f.host.stop();
    status.resolve("granted");
    await Promise.all([starting, stopping]);
    expect(f.bridge.beginMeasurement).not.toHaveBeenCalled();
    expect(f.bridge.endMeasurement).not.toHaveBeenCalled();
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(f.state()).toMatchObject({ busy: false, active: false });
  });

  it("settles End and clears the credential without a camera permission response", async () => {
    const f = fixture();
    f.mediaDevices.getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>(() => {}),
    );
    const starting = f.host.start("camera", "b", true);
    await vi.waitFor(() =>
      expect(f.mediaDevices.getUserMedia).toHaveBeenCalledOnce(),
    );
    const stopped = vi.fn();
    const stopping = f.host.stop().then(stopped);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    await Promise.all([starting, stopping]);
    expect(f.state()).toMatchObject({ active: false, busy: false });
    f.bridge.beginMeasurement.mockResolvedValueOnce(null);
    await f.host.start("camera", "b");
    expect(f.bridge.beginMeasurement).toHaveBeenCalledTimes(2);
    expect(f.dependencies.createSdk).not.toHaveBeenCalled();
  });

  it("releases a stream that arrives after Stop during a camera prompt", async () => {
    const f = fixture();
    const capture = deferred<MediaStream>();
    f.mediaDevices.getUserMedia.mockReturnValue(capture.promise);
    const starting = f.host.start("camera", "b");
    await vi.waitFor(() =>
      expect(f.mediaDevices.getUserMedia).toHaveBeenCalledOnce(),
    );
    const stopping = f.host.stop();
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    void stopping.then(stopped);
    try {
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    } finally {
      capture.resolve(f.stream);
      await Promise.all([starting, stopping]);
    }
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.dependencies.createSdk).not.toHaveBeenCalled();
    expect(f.state()?.busy).toBe(false);
  });

  it("does not acquire a camera after Stop during the credential roundtrip", async () => {
    const f = fixture();
    const key =
      deferred<Awaited<ReturnType<HeartBridge["beginMeasurement"]>>>();
    f.bridge.beginMeasurement.mockReturnValue(key.promise);
    const starting = f.host.start("camera", "a");
    await vi.waitFor(() =>
      expect(f.bridge.beginMeasurement).toHaveBeenCalledOnce(),
    );
    const stopping = f.host.stop();
    key.resolve({ apiKey: "test-credential", captureGeneration: 1 });
    await Promise.all([starting, stopping]);
    expect(f.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(f.bridge.endMeasurement).toHaveBeenCalled();
  });

  it("destroys and reconstructs the SDK to switch configs between sessions", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    await f.host.start("camera", "b");
    expect(f.dependencies.createSdk).toHaveBeenCalledOnce();
    await f.host.stop();
    await f.host.start("camera", "b");
    expect(f.dependencies.createSdk).toHaveBeenCalledTimes(2);
    expect(f.dependencies.createSdk.mock.lastCall?.[0]).toMatchObject({
      requestedMetrics: [15, 16, 13, 0, 2],
    });
    await f.host.stop();
  });

  it("shows decoded pulse details, the exact SDK hint, processing status, and accepted FPS", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    f.listener<(code: number, timestamp: number, hint: string) => void>(
      "validationStatus",
    )(5, 100, "More light, please.");
    f.listener<(status: number) => void>("processingStatus")(3);
    f.listener<(buffer: Uint8Array) => void>("metrics")(
      Metrics.encode({
        cardio: {
          pulseRate: [
            { value: 72, confidence: 85, stable: true, timestamp: 100 },
          ],
        },
      }).finish(),
    );
    const frame = f.listener<(sent: boolean) => void>("frameSentThrough");
    frame(true);
    frame(false);
    frame(true);
    f.tick(1000);
    expect(f.state()).toMatchObject({
      pulse: { value: 72, confidence: 85, stable: true },
      validation: { code: 5, hint: "More light, please." },
      processingStatus: "Running",
      fps: 2,
    });
    f.tick(2000);
    expect(f.state()?.fps).toBe(0);
    await f.host.stop();
  });

  it("shows SDK errors with credentials redacted and releases a fatal session", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    f.listener<(code: number, message: string, retryable: boolean) => void>(
      "error",
    )(2, "Failed test-credential", false);
    await f.host.stop();
    expect(f.state()?.error).toBe("2: Failed [redacted]");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it("releases capture and power even when SDK Stop fails", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    f.sdk.stop.mockRejectedValue(new Error("stop failed"));
    await f.host.stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it("reports a camera refusal without constructing the SDK or retaining power", async () => {
    const f = fixture();
    f.mediaDevices.getUserMedia.mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    );
    await f.host.start("camera", "a");
    expect(f.dependencies.createSdk).not.toHaveBeenCalled();
    expect(f.state()?.error).toBe(
      "Camera: NotAllowedError. On macOS, check System Settings > Privacy & Security > Camera for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Check that the selected device is available and that access is allowed.",
    );
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it("keeps the original error message for other camera DOMException names", async () => {
    const f = fixture();
    f.mediaDevices.getUserMedia.mockRejectedValue(
      new DOMException("Missing", "NotFoundError"),
    );
    await f.host.start("camera", "a");
    expect(f.state()?.error).toBe(
      "Camera: NotFoundError. Check camera access and the selected device.",
    );
  });

  it("shows a rejected SDK Start error with credentials redacted", async () => {
    const f = fixture();
    f.sdk.start.mockRejectedValue(
      new Error("Failed to load device keys for test-credential"),
    );
    await f.host.start("camera", "a");
    expect(f.state()?.error).toBe(
      "Unable to start measurement: Failed to load device keys for [redacted]",
    );
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    expect(f.bridge.noticeEnd).toHaveBeenCalledBefore(f.sdk.destroy);
    expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 1, name: "Idle" },
    { status: 5, name: "Error" },
  ])(
    "withdraws before shutdown if a running SDK unexpectedly reports $name",
    async ({ status }) => {
      const f = fixture();
      await f.host.start("camera", "a");
      f.listener<(status: number) => void>("processingStatus")(status);
      expect(f.bridge.noticeEnd).toHaveBeenCalledOnce();
      await f.host.stop();
      expect(f.bridge.noticeEnd).toHaveBeenCalledBefore(f.sdk.stop);
      expect(f.track.stop).toHaveBeenCalledOnce();
      expect(f.bridge.endMeasurement).toHaveBeenCalledOnce();
    },
  );

  it("falls back to main End before draining when sending the stop notice throws", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    f.bridge.noticeEnd.mockImplementationOnce(() => {
      throw new Error("Unable to send End notice");
    });
    await f.host.stop();
    expect(f.bridge.endMeasurement).toHaveBeenCalledExactlyOnceWith();
    expect(f.bridge.endMeasurement).toHaveBeenCalledBefore(f.sdk.stop);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("destroys an SDK with Start pending and ignores late startup completion", async () => {
    const f = fixture();
    const sdkStart = deferred<void>();
    f.sdk.start.mockReturnValue(sdkStart.promise);
    const starting = f.host.start("camera", "a");
    await vi.waitFor(() => expect(f.sdk.start).toHaveBeenCalledOnce());
    const stopping = f.host.stop();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    sdkStart.resolve();
    await Promise.all([starting, stopping]);
    expect(f.state()?.active).toBe(false);
    expect(f.state()?.busy).toBe(false);
  });

  it("close disposal destroys SDK resources synchronously and prevents restarting", async () => {
    const f = fixture();
    await f.host.start("camera", "a");
    const closing = f.host.dispose();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.sdk.destroy).toHaveBeenCalledOnce();
    await closing;
    await f.host.start("camera", "a");
    expect(f.dependencies.createSdk).toHaveBeenCalledOnce();
  });
});
