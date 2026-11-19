import { Metrics } from "@smartspectra/node-sdk/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalFrame } from "../../src/domain/signal/index";
import type { SelectedCamera } from "../../src/infrastructure/camera/selected-camera";
import type {
  SdkDebugState,
  SdkHost,
} from "../../src/infrastructure/smartspectra/sdk-host/sdk-host";
import type { createDebugPanel } from "../../src/presentation/panel/debug-panel";
import {
  initialFlow,
  transitionFlow,
} from "../../src/presentation/panel/screen-flow";
import type {
  HeartBridge,
  PanelStatePayload,
} from "../../src/shared/ipc-contract";
import {
  at,
  deferred,
  pulse,
  fixture as sessionFixture,
} from "../application/fakes";

const view = vi.hoisted(() => ({
  createDebugPanel: vi.fn<typeof createDebugPanel>(),
  SelectedCamera: vi.fn(),
  SdkHost: vi.fn(),
  panel: {
    showConfiguration: vi.fn(),
    showSession: vi.fn(),
    showRecording: vi.fn(),
    showError: vi.fn(),
    showMeasurement: vi.fn(),
    showStream: vi.fn(),
    showCameras: vi.fn(),
    showCameraError: vi.fn(),
  },
}));
vi.mock("../../src/presentation/panel/debug-panel", () => view);
vi.mock("../../src/infrastructure/camera/selected-camera", () => view);
vi.mock("../../src/infrastructure/smartspectra/sdk-host/sdk-host", () => view);
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  view.panel.showMeasurement.mockReset();
  view.createDebugPanel.mockReturnValue(view.panel);
});
afterEach(() => vi.unstubAllGlobals());

async function fixture(replay = false) {
  const stream = {} as MediaStream;
  const bridge = {
    acceptConsent: vi.fn(async () => {}),
    getCameraAccessStatus: vi.fn<HeartBridge["getCameraAccessStatus"]>(
      async () => "unknown",
    ),
    beginMeasurement: vi.fn<HeartBridge["beginMeasurement"]>(async () =>
      replay ? null : { apiKey: "test-credential", captureGeneration: 1 },
    ),
    endMeasurement: vi.fn(async () => {}),
    noticeEnd: vi.fn(),
    setPrivacyMode: vi.fn<HeartBridge["setPrivacyMode"]>(async () => {}),
    getConfiguration: vi.fn(async () => ({
      canStart: true,
      recordByDefault: false,
      message: replay ? "REPLAY" : "Ready",
    })),
    onPanelState: vi.fn<HeartBridge["onPanelState"]>(() => () => {}),
    onRecordingState: vi.fn(() => () => {}),
    onBeforeClose: vi.fn<HeartBridge["onBeforeClose"]>(() => () => {}),
    confirmClose: vi.fn(),
    pushFrame: vi.fn<HeartBridge["pushFrame"]>(),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    copyOverlayUrl: vi.fn(async () => ({
      ok: true as const,
      message: "Copied",
    })),
    exportChapters: vi.fn(async () => ({
      ok: true as const,
      message: "Exported",
    })),
    saveHighlightList: vi.fn(async () => ({
      ok: true as const,
      message: "Saved",
    })),
    deleteAllData: vi.fn(async () => ({
      ok: true as const,
      message: "Deleted",
    })),
  } satisfies HeartBridge;
  const video = { deviceId: "camera", label: "USB Camera", kind: "videoinput" };
  const mediaDevices = {
    enumerateDevices: vi.fn(async () => [video, { kind: "audioinput" }]),
    getUserMedia: vi.fn(async () => stream),
    addEventListener: vi.fn(),
  };
  const cameraAccess = vi.fn(() => {
    if (replay) throw new Error("Replay must never access media devices");
    return mediaDevices;
  });
  vi.stubGlobal("navigator", {
    get mediaDevices() {
      return cameraAccess();
    },
  });
  vi.stubGlobal("document", { querySelector: () => ({}), title: "" });
  vi.stubGlobal("window", {
    location: { search: replay ? "?replay=1" : "?replay=0" },
    heartBridge: bridge,
    addEventListener: vi.fn(),
  });
  await import("../../src/renderer/composition");
  const actions = view.createDebugPanel.mock.lastCall?.[1];
  const receivePanel = bridge.onPanelState.mock.lastCall?.[0];
  if (!actions || !receivePanel)
    throw new Error("Missing renderer composition");
  return { actions, bridge, cameraAccess, mediaDevices, receivePanel, video };
}

function pushFrame(bridge: HeartBridge, frame: SignalFrame): void {
  bridge.pushFrame({ frame, captureGeneration: 1 });
}

async function liveFixture() {
  const main = sessionFixture();
  const f = await fixture();
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "camera" }),
  });
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  const openCamera = vi.fn(async () => stream);
  const sdk = {
    on: vi.fn().mockReturnThis(),
    useMediaStream: vi.fn().mockReturnThis(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  const { SdkHost: RealHost } = await vi.importActual<
    typeof import("../../src/infrastructure/smartspectra/sdk-host/sdk-host")
  >("../../src/infrastructure/smartspectra/sdk-host/sdk-host");
  view.SdkHost.mockImplementation(function Host(
    options: ConstructorParameters<typeof SdkHost>[0],
  ) {
    return new RealHost({ ...options, createSdk: () => sdk });
  });
  view.SelectedCamera.mockImplementation(function FakeCamera() {
    return { open: openCamera, abort: () => {} };
  });
  f.bridge.beginMeasurement.mockImplementation(async (options) => {
    await main.session.startSession({
      consentRecorded: true,
      privacyMode: options.privacyMode ?? "vibe",
      recordingEnabled: options.recordSession,
    });
    return {
      apiKey: "test-credential",
      captureGeneration: main.session.captureGeneration,
    };
  });
  f.bridge.pushFrame.mockImplementation(({ frame }) => main.source.emit(frame));
  f.bridge.noticeEnd.mockImplementation(() => {
    void main.session.withdrawSharing("drain");
  });
  f.bridge.setPrivacyMode.mockImplementation((mode, shutdown) =>
    mode === "off"
      ? main.session.withdrawSharing(shutdown)
      : main.session.setPrivacyMode(mode),
  );
  f.bridge.endMeasurement.mockImplementation(() => main.session.stopSession());
  return { ...f, main, sdk, track, openCamera };
}

describe("renderer composition", () => {
  it("pauses immediately on camera loss, then acquires a fresh track on Resume", async () => {
    const { actions, bridge, main, receivePanel, sdk, track, openCamera } =
      await liveFixture();
    const panelSnapshot = () => ({
      ...main.session.panelState,
      runtime: {
        captureGeneration: main.session.captureGeneration,
        obsMessage: "",
        overlayUrl: "",
        overlayError: "",
        replayFile: "",
        replayMessage: "",
      },
    });
    const unsubscribe = main.session.subscribePanel(() =>
      receivePanel(panelSnapshot()),
    );
    bridge.pause.mockImplementation(() => main.session.setPaused(true));
    bridge.resume.mockImplementation(() => main.session.setPaused(false));
    const resumedTrack = Object.assign(new EventTarget(), {
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "camera" }),
    });
    const resumedStream = {
      getTracks: () => [resumedTrack],
      getVideoTracks: () => [resumedTrack],
    } as unknown as MediaStream;
    try {
      await actions.acceptConsent();
      await actions.start("camera", "b", false, "numbers");
      pushFrame(bridge, pulse(0, 82));
      await main.session.whenIdle();
      expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

      const previousSnapshot = panelSnapshot();
      track.dispatchEvent(new Event("ended"));
      expect(bridge.pause).toHaveBeenCalledOnce();
      expect(main.publisher.states.at(-1)).toMatchObject({
        status: "paused",
        pulseBpm: null,
      });
      expect(view.panel.showStream).toHaveBeenLastCalledWith(null);
      expect(view.panel.showMeasurement).toHaveBeenLastCalledWith(
        expect.objectContaining({
          active: false,
          cameraDisconnected: true,
          pulse: null,
        }),
      );
      receivePanel(previousSnapshot);
      await main.session.whenIdle();
      expect(main.session.panelState).toMatchObject({
        active: true,
        pauseReason: "manual",
      });
      await vi.waitFor(() => expect(sdk.destroy).toHaveBeenCalledOnce());
      expect(openCamera).toHaveBeenCalledOnce();

      openCamera.mockResolvedValueOnce(resumedStream);
      await actions.resume();
      await vi.waitFor(() =>
        expect(view.panel.showMeasurement).toHaveBeenLastCalledWith(
          expect.objectContaining({ active: true, cameraDisconnected: false }),
        ),
      );
      expect(bridge.beginMeasurement).toHaveBeenCalledOnce();
      expect(openCamera).toHaveBeenCalledTimes(2);
      expect(view.panel.showStream).toHaveBeenLastCalledWith(resumedStream);
      track.dispatchEvent(new Event("ended"));
      expect(bridge.pause).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      await actions.stop();
    }
  });

  it("follows main's pause and resume snapshots, and stops capture on Off and End", async () => {
    const stream = {} as MediaStream;
    const camera = { open: vi.fn(async () => stream), abort: vi.fn() };
    view.SelectedCamera.mockImplementation(function FakeCamera() {
      return camera;
    });
    const host = {
      start: vi.fn(async () => {}),
      setPaused: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    view.SdkHost.mockImplementation(function FakeHost() {
      return host;
    });
    const { actions, bridge, cameraAccess, mediaDevices, receivePanel, video } =
      await fixture();
    expect(view.SelectedCamera).not.toHaveBeenCalled();
    expect(view.SdkHost).not.toHaveBeenCalled();
    await expect(
      actions.start("camera", "b", false, "numbers"),
    ).rejects.toThrow("Accept");
    expect(view.SdkHost).not.toHaveBeenCalled();
    actions.refreshCameras();
    expect(cameraAccess).not.toHaveBeenCalled();
    expect(bridge.beginMeasurement).not.toHaveBeenCalled();
    await actions.acceptConsent();
    expect(host.start).not.toHaveBeenCalled();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(camera.open).not.toHaveBeenCalled();
    const cameraOptions = view.SelectedCamera.mock.lastCall?.[0] as
      | ConstructorParameters<typeof SelectedCamera>[0]
      | undefined;
    const hostOptions = view.SdkHost.mock.lastCall?.[0] as
      | ConstructorParameters<typeof SdkHost>[0]
      | undefined;
    if (!cameraOptions || !hostOptions)
      throw new Error("Missing live camera wiring");
    expect(cameraOptions.resolveSelection).toBe(view.panel.showCameras);
    await expect(cameraOptions.enumerateVideoInputs()).resolves.toEqual([
      video,
    ]);
    const constraints = { video: { deviceId: { exact: "camera" } } };
    await expect(
      hostOptions.mediaDevices.getUserMedia(constraints, false),
    ).resolves.toBe(stream);
    expect(camera.open).toHaveBeenCalledExactlyOnceWith(constraints, {
      resolveAfterPermission: true,
    });
    await expect(
      hostOptions.mediaDevices.getUserMedia(constraints, true),
    ).resolves.toBe(stream);
    expect(camera.open).toHaveBeenLastCalledWith(constraints, {
      resolveAfterPermission: false,
    });
    hostOptions.mediaDevices.abort();
    expect(camera.abort).toHaveBeenCalledOnce();
    await actions.start("camera", "b", false, "numbers");
    receivePanel({ active: false } as PanelStatePayload);
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.start).toHaveBeenCalledWith("camera", "b", false);
    await actions.pause();
    expect(bridge.pause).toHaveBeenCalledOnce();
    expect(host.setPaused).not.toHaveBeenCalled();
    for (const [pauseReason, captureGeneration] of [
      ["manual", 1],
      [null, 2],
      ["unusableInput", 2],
    ] as const)
      receivePanel({
        active: true,
        pauseReason,
        runtime: { captureGeneration },
      } as PanelStatePayload);
    expect(host.setPaused.mock.calls).toEqual([
      [true, 1],
      [false, 2],
      [true, 2],
    ]);
    await actions.setPrivacyMode("off");
    expect(host.stop).toHaveBeenCalledOnce();
    expect(bridge.setPrivacyMode).toHaveBeenCalledWith("off");
    receivePanel({ active: false } as PanelStatePayload);
    expect(host.stop).toHaveBeenCalledTimes(2);
    await actions.resume();
    expect(bridge.resume).toHaveBeenCalledOnce();
    receivePanel({ active: false, pauseReason: null } as PanelStatePayload);
    expect(host.setPaused).toHaveBeenCalledTimes(3);
    expect(host.start).toHaveBeenCalledOnce();
  });

  it("replaces cached Numbers and ends recording while SDK shutdown is pending", async () => {
    const main = sessionFixture();
    const { actions, bridge, receivePanel } = await fixture();
    let finishShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    const host = {
      start: vi.fn(async () => {
        await main.session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
          recordingEnabled: true,
        });
      }),
      setPaused: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        await shutdown;
        await bridge.endMeasurement();
      }),
    };
    view.SdkHost.mockImplementation(function FakeHost() {
      return host;
    });
    view.SelectedCamera.mockImplementation(function FakeCamera() {
      return {};
    });
    bridge.pushFrame.mockImplementation(({ frame }) => main.source.emit(frame));
    bridge.setPrivacyMode.mockImplementation((mode) =>
      mode === "off"
        ? main.session.withdrawSharing()
        : main.session.setPrivacyMode(mode),
    );
    bridge.endMeasurement.mockImplementation(() => main.session.stopSession());
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    receivePanel(main.session.panelState);
    pushFrame(bridge, pulse(0, 78));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 78 });

    let finishAppend!: () => void;
    const pendingAppend = new Promise<void>((resolve) => {
      finishAppend = resolve;
    });
    const append = main.recorder.append.bind(main.recorder);
    main.recorder.append = vi.fn(async (frame) => {
      await pendingAppend;
      await append(frame);
    });
    pushFrame(bridge, pulse(1, 79));
    await Promise.resolve();
    expect(main.recorder.append).toHaveBeenCalledOnce();

    const off = actions.setPrivacyMode("off");
    try {
      expect(host.stop).toHaveBeenCalledOnce();
      const viewer = vi.fn();
      main.publisher.connect(viewer);
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
      const late = pulse(2, 96);
      pushFrame(bridge, late);
      finishAppend();
      await main.session.whenIdle();
      expect(main.recorder.files[0]).toEqual([
        pulse(0, 78),
        pulse(1, 79),
        { kind: "end", durationUs: 1_000_000 },
      ]);
      expect(viewer.mock.calls.every(([state]) => state.mode === "off")).toBe(
        true,
      );
      expect(main.recorder.stops).toBe(1);
    } finally {
      finishAppend();
      finishShutdown();
      await off;
    }
    expect(main.recorder.stops).toBe(1);
  });

  it("still stops the SDK on live End when main rejects the withdrawal", async () => {
    const main = sessionFixture();
    const { actions, bridge } = await fixture();
    const host = {
      start: () =>
        main.session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
        }),
      stop: vi.fn(async () => {
        await bridge.endMeasurement();
      }),
    };
    view.SdkHost.mockImplementation(function FakeHost() {
      return host;
    });
    view.SelectedCamera.mockImplementation(function FakeCamera() {
      return {};
    });
    bridge.setPrivacyMode.mockRejectedValue(new Error("closing"));
    bridge.endMeasurement.mockImplementation(() => main.session.stopSession());
    await actions.acceptConsent();
    await actions.start("camera", "b", false, "numbers");
    await expect(actions.stop()).rejects.toThrow("closing");
    expect(host.stop).toHaveBeenCalledOnce();
    expect(bridge.endMeasurement).toHaveBeenCalledOnce();
  });

  it("falls back to main End while the SDK drains if both the send and invoke fail", async () => {
    const { actions, bridge, main, sdk } = await liveFixture();
    bridge.noticeEnd.mockImplementationOnce(() => {
      throw new Error("Unable to send End notice");
    });
    const shutdown = deferred<void>();
    const viewer = vi.fn();
    sdk.stop.mockImplementation(async () => {
      main.publisher.connect(viewer);
      await shutdown.promise;
      pushFrame(bridge, pulse(2, 85));
    });
    bridge.setPrivacyMode.mockRejectedValueOnce(new Error("IPC unavailable"));
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    pushFrame(bridge, pulse(0, 82));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    const ending = expect(actions.stop()).rejects.toThrow("IPC unavailable");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sdk.stop).toHaveBeenCalledOnce();
      expect(bridge.endMeasurement).toHaveBeenCalledOnce();
      expect(bridge.endMeasurement).toHaveBeenCalledBefore(sdk.stop);
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
    } finally {
      shutdown.resolve();
      await ending;
      await vi.waitFor(() => expect(sdk.destroy).toHaveBeenCalledOnce());
    }
    await main.session.whenIdle();
    expect(main.session.panelState.active).toBe(false);
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "end", durationUs: 0 },
    ]);
    expect(bridge.endMeasurement).toHaveBeenCalledOnce();
    expect(viewer.mock.calls.every(([state]) => state.mode === "off")).toBe(
      true,
    );
  });

  it("uses the withdrawal invoke if sending the End notice throws", async () => {
    const { actions, bridge, main, sdk, track } = await liveFixture();
    bridge.noticeEnd.mockImplementationOnce(() => {
      throw new Error("Unable to send End notice");
    });
    const viewer = vi.fn();
    sdk.stop.mockImplementation(async () => {
      main.publisher.connect(viewer);
      pushFrame(bridge, pulse(2, 85));
    });
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    pushFrame(bridge, pulse(0, 82));
    await main.session.whenIdle();

    await actions.stop();
    expect(bridge.noticeEnd).toHaveBeenCalledBefore(bridge.setPrivacyMode);
    expect(bridge.setPrivacyMode).toHaveBeenCalledBefore(track.stop);
    expect(viewer).toHaveBeenCalledExactlyOnceWith({
      mode: "off",
      replay: false,
    });
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "drain" },
      pulse(2, 85),
      { kind: "end", durationUs: 2_000_000 },
    ]);
  });

  it("keeps a new viewer Off when the withdrawal rejects after an SDK drain frame", async () => {
    const { actions, bridge, main, sdk } = await liveFixture();
    let rejectWithdrawal!: (error: Error) => void;
    const withdrawal = new Promise<void>((_resolve, reject) => {
      rejectWithdrawal = reject;
    });
    const shutdown = deferred<void>();
    const startedDraining = deferred<void>();
    const viewer = vi.fn();
    bridge.setPrivacyMode.mockReturnValueOnce(withdrawal);
    sdk.stop.mockImplementation(async () => {
      main.publisher.connect(viewer);
      pushFrame(bridge, pulse(2, 85));
      startedDraining.resolve();
      await shutdown.promise;
      pushFrame(bridge, pulse(3, 86));
    });
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    pushFrame(bridge, pulse(0, 82));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    const ending = expect(actions.stop()).rejects.toThrow("Reply lost");
    try {
      await startedDraining.promise;
      await main.session.whenIdle();
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
      expect(main.session.panelState.pulse?.value).toBe(82);
      expect(main.recorder.files[0]).toEqual([
        pulse(0, 82),
        { kind: "drain" },
        pulse(2, 85),
      ]);
      rejectWithdrawal(new Error("Reply lost"));
      await ending;
      expect(bridge.endMeasurement).not.toHaveBeenCalled();
    } finally {
      rejectWithdrawal(new Error("Reply lost"));
      shutdown.resolve();
      await ending;
      await vi.waitFor(() => expect(main.recorder.stops).toBe(1));
    }
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "drain" },
      pulse(2, 85),
      pulse(3, 86),
      { kind: "end", durationUs: 3_000_000 },
    ]);
    expect(viewer.mock.calls.every(([state]) => state.mode === "off")).toBe(
      true,
    );
  });

  it("withdraws before live End releases the track and drains the SDK with a slow reply", async () => {
    const { actions, bridge, main, sdk, track } = await liveFixture();
    const stopping = deferred<void>();
    const shutdown = deferred<void>();
    const withdrawal = deferred<void>();
    sdk.stop.mockImplementation(async () => {
      stopping.resolve();
      await shutdown.promise;
      pushFrame(bridge, pulse(2, 85));
    });
    bridge.setPrivacyMode.mockImplementation(async (mode, boundary) => {
      expect(mode).toBe("off");
      await main.session.withdrawSharing(boundary);
      await withdrawal.promise;
    });
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    pushFrame(bridge, pulse(0, 82));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    const ending = actions.stop();
    const viewer = vi.fn();
    try {
      expect(track.stop).toHaveBeenCalledOnce();
      await stopping.promise;
      expect(bridge.setPrivacyMode).toHaveBeenCalledExactlyOnceWith(
        "off",
        "drain",
      );
      expect(bridge.setPrivacyMode).toHaveBeenCalledBefore(track.stop);
      expect(track.stop).toHaveBeenCalledBefore(sdk.stop);
      main.publisher.connect(viewer);
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
      expect(bridge.endMeasurement).not.toHaveBeenCalled();
      expect(main.recorder.stops).toBe(0);
      shutdown.resolve();
      await vi.waitFor(() => expect(main.recorder.stops).toBe(1));
    } finally {
      withdrawal.resolve();
      shutdown.resolve();
      await ending;
    }
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "drain" },
      pulse(2, 85),
      { kind: "end", durationUs: 2_000_000 },
    ]);
    expect(viewer.mock.calls.every(([state]) => state.mode === "off")).toBe(
      true,
    );
  });

  it("keeps a new viewer Off while the SDK drains after a fatal error", async () => {
    const { actions, bridge, main, sdk } = await liveFixture();
    const stopping = deferred<void>();
    const shutdown = deferred<void>();
    const viewer = vi.fn();
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    const onMetrics = sdk.on.mock.calls.find(
      ([name]) => name === "metrics",
    )?.[1] as (buffer: Uint8Array) => void;
    const onError = sdk.on.mock.calls.find(
      ([name]) => name === "error",
    )?.[1] as (code: number, message: string, retryable: boolean) => void;
    const emitPulse = (seconds: number, value: number) => {
      onMetrics(
        Metrics.encode({
          cardio: {
            pulseRate: [
              { value, confidence: 90, stable: true, timestamp: at(seconds) },
            ],
          },
        }).finish(),
      );
    };
    emitPulse(0, 82);
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });
    sdk.stop.mockImplementationOnce(async () => {
      main.publisher.connect(viewer);
      emitPulse(2, 85);
      stopping.resolve();
      await shutdown.promise;
    });

    onError(2, "SDK error", false);
    try {
      await stopping.promise;
      await main.session.whenIdle();
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
      expect(bridge.noticeEnd).toHaveBeenCalledExactlyOnceWith();
      expect(bridge.noticeEnd).toHaveBeenCalledBefore(sdk.stop);
      expect(bridge.pushFrame).toHaveBeenLastCalledWith({
        frame: pulse(2, 85),
        captureGeneration: main.session.captureGeneration,
      });
      expect(main.session.panelState.pulse?.value).toBe(82);
      expect(main.recorder.stops).toBe(0);
      expect(bridge.endMeasurement).not.toHaveBeenCalled();
    } finally {
      shutdown.resolve();
      await vi.waitFor(() => expect(main.recorder.stops).toBe(1));
      await main.session.whenIdle();
    }
    expect(main.recorder.files[0]).toContainEqual(pulse(2, 85));
    expect(main.recorder.files[0]?.at(-1)).toEqual({
      kind: "end",
      durationUs: 2_000_000,
    });
    expect(viewer).toHaveBeenCalledOnce();
  });

  it.each(["End", "close"])(
    "retries a failed measurement:end on %s and finalizes the receipt once",
    async (retry) => {
      const { actions, bridge, main, receivePanel, sdk, track } =
        await liveFixture();
      let flow = transitionFlow(initialFlow(false), {
        type: "agree",
        onlyPerson: true,
      });
      view.panel.showMeasurement.mockImplementation((state: SdkDebugState) => {
        flow = transitionFlow(flow, {
          type: "capture",
          busy: state.active || state.busy,
        });
      });
      main.session.subscribePanel((state) => {
        flow = transitionFlow(flow, { type: "session", active: state.active });
        receivePanel(state);
      });
      bridge.endMeasurement.mockRejectedValueOnce(new Error("IPC unavailable"));
      await actions.acceptConsent();
      await actions.start("camera", "b", true, "numbers");
      pushFrame(bridge, pulse(0, 82));
      pushFrame(bridge, pulse(2, 85));
      await main.session.whenIdle();

      await actions.stop();
      expect(track.stop).toHaveBeenCalledOnce();
      expect(sdk.stop).toHaveBeenCalledOnce();
      expect(bridge.endMeasurement).toHaveBeenCalledOnce();
      expect(main.session.panelState.active).toBe(true);
      expect(main.recorder.stops).toBe(0);
      expect(flow.screen).toBe("live");

      if (retry === "End") await actions.stop();
      else {
        bridge.onBeforeClose.mock.lastCall?.[0]();
        await vi.waitFor(() =>
          expect(bridge.confirmClose).toHaveBeenCalledOnce(),
        );
      }
      expect(bridge.endMeasurement).toHaveBeenCalledTimes(2);
      expect(track.stop).toHaveBeenCalledOnce();
      expect(sdk.stop).toHaveBeenCalledOnce();
      expect(main.session.panelState.active).toBe(false);
      expect(main.recorder.stops).toBe(1);
      expect(main.recorder.files[0]).toEqual([
        pulse(0, 82),
        pulse(2, 85),
        { kind: "drain" },
        { kind: "end", durationUs: 2_000_000 },
      ]);
      expect(flow.screen).toBe("receipt");
    },
  );

  it("reconciles a lost End reply before starting a fresh measurement", async () => {
    const { actions, bridge, main } = await liveFixture();
    bridge.endMeasurement.mockImplementationOnce(async () => {
      await main.session.stopSession();
      throw new Error("Reply lost");
    });
    await actions.acceptConsent();
    await actions.start("camera", "b", true, "numbers");
    pushFrame(bridge, pulse(0, 82));
    await actions.stop();
    expect(main.session.panelState.active).toBe(false);

    await actions.start("camera", "b", true, "numbers");
    try {
      expect(bridge.endMeasurement).toHaveBeenCalledTimes(2);
      expect(main.session.panelState.active).toBe(true);
      expect(main.recorder.files[0]).toEqual([
        pulse(0, 82),
        { kind: "drain" },
        { kind: "end", durationUs: 0 },
      ]);
    } finally {
      await actions.stop();
    }
  });

  it.each([
    ["denied", true],
    ["restricted", true],
    ["not-determined", false],
    ["granted", false],
    ["unknown", false],
  ] as const)(
    "checks %s camera access at live Start and reports a blocked capture",
    async (status, blocked) => {
      const { SdkHost: RealHost } = await vi.importActual<
        typeof import("../../src/infrastructure/smartspectra/sdk-host/sdk-host")
      >("../../src/infrastructure/smartspectra/sdk-host/sdk-host");
      const { SelectedCamera: RealCamera } = await vi.importActual<
        typeof import("../../src/infrastructure/camera/selected-camera")
      >("../../src/infrastructure/camera/selected-camera");
      const createSdk = vi.fn(() => {
        throw new Error("Unexpected SDK construction");
      });
      view.SdkHost.mockImplementation(function Host(
        options: ConstructorParameters<typeof SdkHost>[0],
      ) {
        return new RealHost({ ...options, createSdk });
      });
      view.SelectedCamera.mockImplementation(function Camera(
        options: ConstructorParameters<typeof SelectedCamera>[0],
      ) {
        return new RealCamera(options);
      });
      const { actions, bridge, cameraAccess, mediaDevices } = await fixture();
      bridge.getCameraAccessStatus.mockResolvedValue(status);
      mediaDevices.getUserMedia.mockRejectedValue(
        new DOMException("Denied", "NotAllowedError"),
      );

      await expect(
        actions.start("camera", "a", true, "numbers"),
      ).rejects.toThrow("Accept");
      let acknowledge!: () => void;
      bridge.acceptConsent.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
      );
      const accepting = actions.acceptConsent();
      expect(bridge.acceptConsent).toHaveBeenCalledOnce();
      actions.refreshCameras();
      await expect(
        actions.start("camera", "a", true, "numbers"),
      ).rejects.toThrow("Accept");
      expect(cameraAccess).not.toHaveBeenCalled();
      expect(bridge.getCameraAccessStatus).not.toHaveBeenCalled();
      expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
      acknowledge();
      await accepting;
      await actions.start("camera", "a", true, "numbers");

      expect(bridge.getCameraAccessStatus).toHaveBeenCalledOnce();
      expect(createSdk).not.toHaveBeenCalled();
      if (blocked) {
        expect(bridge.beginMeasurement).not.toHaveBeenCalled();
        expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
        expect(view.panel.showMeasurement).toHaveBeenLastCalledWith(
          expect.objectContaining({
            active: false,
            busy: false,
            error: expect.stringContaining("macOS is blocking camera access"),
          }),
        );
      } else {
        expect(bridge.beginMeasurement).toHaveBeenCalledExactlyOnceWith({
          metricConfig: "a",
          recordSession: true,
          privacyMode: "numbers",
        });
        expect(bridge.getCameraAccessStatus).toHaveBeenCalledBefore(
          bridge.beginMeasurement,
        );
        expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
        expect(bridge.acceptConsent).toHaveBeenCalledBefore(
          mediaDevices.getUserMedia,
        );
        expect(bridge.getCameraAccessStatus).toHaveBeenCalledBefore(
          mediaDevices.getUserMedia,
        );
        expect(view.panel.showMeasurement).toHaveBeenLastCalledWith(
          expect.objectContaining({
            error: expect.stringMatching(
              /NotAllowedError.*System Settings > Privacy & Security > Camera.*app that launched Heart on Stream.*selected device/u,
            ),
          }),
        );
      }
    },
  );

  it("never constructs the SDK or accesses camera APIs, and sends replay/ privacy commands over the bridge", async () => {
    const { actions, bridge, cameraAccess } = await fixture(true);
    expect(view.createDebugPanel.mock.lastCall?.[2]).toBe(true);
    actions.refreshCameras();
    await actions.acceptConsent();
    await actions.start("", "a", true, "numbers");
    expect(bridge.beginMeasurement).toHaveBeenCalledWith({
      metricConfig: "a",
      recordSession: false,
      privacyMode: "numbers",
    });
    await actions.setPrivacyMode("vibe");
    expect(bridge.setPrivacyMode).toHaveBeenCalledWith("vibe");
    await actions.saveHighlightList();
    expect(bridge.saveHighlightList).toHaveBeenCalledOnce();
    await actions.stop();
    expect(bridge.endMeasurement).toHaveBeenCalledOnce();
    expect(bridge.noticeEnd).not.toHaveBeenCalled();
    expect(view.SelectedCamera).not.toHaveBeenCalled();
    expect(view.SdkHost).not.toHaveBeenCalled();
    expect(cameraAccess).not.toHaveBeenCalled();
    expect(bridge.acceptConsent).not.toHaveBeenCalled();
    expect(bridge.getCameraAccessStatus).not.toHaveBeenCalled();
    expect(view.panel.showConfiguration).toHaveBeenCalledWith({
      canStart: true,
      recordByDefault: false,
      message: "REPLAY",
    });
  });
});
