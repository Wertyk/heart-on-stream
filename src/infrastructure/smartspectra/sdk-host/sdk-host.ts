import { decodeMetrics } from "@smartspectra/node-sdk/messages";
import {
  ProcessingStatus,
  type RendererSmartSpectraOptions,
  SmartSpectraSDK,
} from "@smartspectra/node-sdk/renderer";
import type { SignalFrame } from "../../../domain/signal/index";
import type {
  HeartBridge,
  MetricConfiguration,
} from "../../../shared/ipc-contract";
import {
  mapMetrics,
  mapProcessingEvent,
  mapValidationEvent,
  type SdkMetrics,
} from "../metrics-mapper";
import { countFrame, type FpsWindow, sampleFps } from "./fps-counter";
import { requestedMetrics } from "./metric-config";
import { timestampedMetrics } from "./timestamped-metrics";

/** Streamer-local status details, kept separate from normalized application frames. */
export interface SdkDebugState {
  readonly active: boolean;
  readonly busy: boolean;
  readonly cameraDisconnected: boolean;
  readonly processingStatus: string;
  readonly pulse: {
    readonly value: number;
    readonly confidence: number;
    readonly stable: boolean;
  } | null;
  readonly validation: { readonly code: number; readonly hint: string } | null;
  readonly fps: number;
  readonly error: string;
}

type SdkClient = Pick<
  SmartSpectraSDK,
  "on" | "useMediaStream" | "start" | "stop" | "destroy"
>;

interface HostDependencies {
  bridge: Pick<
    HeartBridge,
    | "getCameraAccessStatus"
    | "beginMeasurement"
    | "endMeasurement"
    | "noticeEnd"
    | "pushFrame"
  >;
  mediaDevices: {
    getUserMedia(
      constraints: MediaStreamConstraints,
      reopen: boolean,
    ): Promise<MediaStream>;
    abort(): void;
  };
  createSdk?(options: RendererSmartSpectraOptions): SdkClient;
  decodeMetrics?(buffer: Uint8Array): SdkMetrics;
  /** Epoch microseconds, matching SDK measurement timestamps. */
  nowUs(): number;
  /** Monotonic milliseconds, used only for the FPS readout. */
  now(): number;
  schedule(callback: () => void): () => void;
  onState(state: SdkDebugState): void;
  onStream(stream: MediaStream | null): void;
  onCameraDisconnected(): void;
}

interface Capture {
  readonly generation: number;
  cancelled: boolean;
  drainFrames: boolean;
  started: boolean;
  sdk: SdkClient | null;
  stream: MediaStream | null;
  cancelTimer: (() => void) | null;
  cancelOpening: (() => void) | null;
  unwatchTracks: (() => void) | null;
}

interface Measurement {
  readonly config: MetricConfiguration;
  deviceId: string;
  reopen: boolean;
  apiKey: string | null;
  captureGeneration: number | null;
  paused: boolean;
  ending: boolean;
  capture: Capture | null;
}

const initialState = (): SdkDebugState => ({
  active: false,
  busy: false,
  cameraDisconnected: false,
  processingStatus: "Idle",
  pulse: null,
  validation: null,
  fps: 0,
  error: "",
});

const statusNames: Readonly<Record<number, string>> = {
  [ProcessingStatus.kUninitialized]: "Uninitialized",
  [ProcessingStatus.kIdle]: "Idle",
  [ProcessingStatus.kStarting]: "Starting",
  [ProcessingStatus.kRunning]: "Running",
  [ProcessingStatus.kStopping]: "Stopping",
  [ProcessingStatus.kError]: "Error",
};

const macCameraBlocked =
  "macOS is blocking camera access for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Enable it in System Settings > Privacy & Security > Camera, then quit and reopen that app and start Heart on Stream again.";

const mainEndError = "Unable to notify main that measurement stopped.";

function cameraErrorMessage(error: DOMException): string {
  if (error.name === "NotAllowedError")
    return "Camera: NotAllowedError. On macOS, check System Settings > Privacy & Security > Camera for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Check that the selected device is available and that access is allowed.";
  return `Camera: ${error.name}. Check camera access and the selected device.`;
}

/** Owns one measurement and any camera captures that run within it. */
export class SdkHost {
  private state = initialState();
  private session: Measurement | null = null;
  private pending = Promise.resolve();
  // Main can still need End after the local session has released its capture.
  private mainMeasurement: Measurement | null = null;
  private mainEndRequest: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly dependencies: HostDependencies) {}

  start(
    deviceId: string,
    config: MetricConfiguration,
    recordSession = false,
  ): Promise<void> {
    if (this.disposed || this.session) return Promise.resolve();
    const session: Measurement = {
      config,
      deviceId,
      reopen: false,
      apiKey: null,
      captureGeneration: null,
      paused: false,
      ending: false,
      capture: null,
    };
    this.session = session;
    this.state = initialState();
    return this.enqueue(async () => {
      try {
        if (this.mainMeasurement) {
          await this.endMeasurement();
          if (session.ending) return;
          if (this.mainMeasurement) {
            this.session = null;
            return;
          }
        }
        const status = await this.dependencies.bridge.getCameraAccessStatus();
        if (session.ending) return;
        if (status === "denied" || status === "restricted") {
          this.session = null;
          this.update({ error: macCameraBlocked });
          return;
        }
        this.update({ busy: true, processingStatus: "Starting" });
        this.mainMeasurement = session;
        const measurement = await this.dependencies.bridge.beginMeasurement({
          metricConfig: config,
          recordSession,
        });
        if (session.ending) return;
        if (!measurement)
          throw new Error("API key is unavailable. Check .env and restart.");
        session.apiKey = measurement.apiKey;
        if (
          session.captureGeneration === null ||
          session.captureGeneration < measurement.captureGeneration
        ) {
          session.captureGeneration = measurement.captureGeneration;
          session.paused = false;
        }
      } catch (error) {
        if (!session.ending) await this.failStart(session, error);
        return;
      }
      await this.reconcileCapture(session);
    });
  }

  /** Main's panel snapshots request capture changes within the same measurement. */
  setPaused(paused: boolean, captureGeneration: number): Promise<void> {
    const session = this.session;
    if (
      !session ||
      session.ending ||
      (session.captureGeneration !== null &&
        captureGeneration < session.captureGeneration)
    )
      return this.pending;
    const captureChanged = session.captureGeneration !== captureGeneration;
    // Resume always advances the generation. Ignore unpaused snapshots that
    // were already in flight when a disconnected capture paused locally.
    if (!captureChanged && (!paused || session.paused)) return this.pending;
    session.captureGeneration = captureGeneration;
    session.paused = paused;
    if (paused || captureChanged) this.cancelCapture(session, false);
    if (paused) {
      this.update({
        active: false,
        busy: false,
        processingStatus: "Paused",
        pulse: null,
        validation: null,
        fps: 0,
      });
    }
    return this.enqueue(() => this.reconcileCapture(session));
  }

  /** Panel End sends its own notice and supplies a fallback if that send fails. */
  stop(panelEnd?: {
    withdrawalFallback: Promise<void> | undefined;
  }): Promise<void> {
    const session = this.session;
    if (panelEnd?.withdrawalFallback) {
      const measurement = session ?? this.mainMeasurement;
      void panelEnd.withdrawalFallback.catch(() => {
        // A late failure belongs to the session that sent the withdrawal.
        if (this.mainMeasurement === measurement) return this.endMeasurement();
      });
    }
    if (!session)
      return this.mainMeasurement ? this.endMeasurement() : this.pending;
    if (session.ending) return this.pending;
    session.ending = true;
    session.apiKey = null;
    const fallbackEnd = panelEnd ? undefined : this.noticeTerminalStop(session);
    this.update({ active: false, busy: true, processingStatus: "Stopping" });
    this.cancelCapture(session, true);
    // A pending camera prompt must not keep the main session or recording open.
    const endingMain =
      fallbackEnd ??
      (!session.capture?.started ? this.endMeasurement() : undefined);
    return this.enqueue(() => this.finishSession(session, endingMain));
  }

  /** Destroy SDK resources synchronously before acknowledging the window close. */
  dispose(): Promise<void> {
    this.disposed = true;
    const result = this.stop();
    if (this.session) this.destroySdk(this.session.capture);
    return result;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private async reconcileCapture(session: Measurement): Promise<void> {
    if (session.capture?.cancelled) await this.closeCapture(session);
    if (
      session.ending ||
      session.paused ||
      session.capture ||
      !session.apiKey ||
      session.captureGeneration === null
    )
      return;

    const capture: Capture = {
      generation: session.captureGeneration,
      cancelled: false,
      drainFrames: false,
      started: false,
      stream: null,
      sdk: null,
      cancelTimer: null,
      cancelOpening: null,
      unwatchTracks: null,
    };
    session.capture = capture;
    this.update({
      busy: true,
      processingStatus: "Starting",
      cameraDisconnected: false,
    });
    try {
      await this.startCapture(session, capture);
    } catch (error) {
      if (!capture.cancelled) await this.failStart(session, error);
    } finally {
      if (capture.cancelled) this.releaseTracks(capture);
    }
  }

  private async openCamera(
    capture: Capture,
    deviceId: string,
    reopen: boolean,
  ): Promise<MediaStream | undefined> {
    const cancelled = new Promise<undefined>((resolve) => {
      capture.cancelOpening = () => resolve(undefined);
    });
    try {
      const opening = this.dependencies.mediaDevices
        .getUserMedia(
          {
            audio: false,
            video: {
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
          },
          reopen,
        )
        .then((stream) => {
          if (!capture.cancelled) {
            capture.stream = stream;
            return stream;
          }
          // getUserMedia may still grant a stream after cancellation.
          for (const track of stream.getTracks()) track.stop();
          return undefined;
        });
      return await Promise.race([opening, cancelled]);
    } finally {
      capture.cancelOpening = null;
    }
  }

  private async startCapture(
    session: Measurement,
    capture: Capture,
  ): Promise<void> {
    const deviceId = session.deviceId;
    const stream = await this.openCamera(capture, deviceId, session.reopen);
    if (!stream) return;
    const apiKey = session.apiKey;
    if (capture.cancelled || !apiKey) return;
    const tracks = stream.getVideoTracks();
    // The initially selected camera can differ after permission reveals labels.
    session.deviceId = tracks[0]?.getSettings().deviceId || deviceId;
    session.reopen = true;
    const onEnded = () => {
      if (capture.cancelled) return;
      void this.setPaused(true, capture.generation);
      this.update({ cameraDisconnected: true });
      this.dependencies.onCameraDisconnected();
    };
    for (const track of tracks) track.addEventListener("ended", onEnded);
    capture.unwatchTracks = () => {
      for (const track of tracks) track.removeEventListener("ended", onEnded);
    };
    // A device can disappear while permissions or camera selection are pending.
    if (tracks.some((track) => track.readyState === "ended")) {
      onEnded();
      return;
    }
    this.dependencies.onStream(stream);

    const sdk = (
      this.dependencies.createSdk ?? ((options) => new SmartSpectraSDK(options))
    )({
      apiKey,
      requestedMetrics: requestedMetrics(session.config),
      enableTelemetry: false,
      enableAccumulatedOutput: false,
    });
    capture.sdk = sdk;
    this.listenToSdk(capture, sdk, apiKey);
    sdk.useMediaStream(stream);
    await sdk.start();
    if (capture.cancelled) return;
    capture.started = true;
    this.update({ active: true, busy: false });
  }

  private listenToSdk(capture: Capture, sdk: SdkClient, apiKey: string): void {
    const current = (): boolean => capture.sdk === sdk && !capture.cancelled;
    const push = (frame: SignalFrame): void =>
      this.dependencies.bridge.pushFrame({
        captureGeneration: capture.generation,
        frame,
      });
    const forward = (event: string, map: () => void): void => {
      // Only a terminal stop drains final SDK emissions into the recording.
      if (capture.sdk !== sdk || (capture.cancelled && !capture.drainFrames))
        return;
      try {
        map();
      } catch {
        this.update({ error: `Unable to map the SDK ${event} event.` });
      }
    };
    sdk.on("streamAvailable", (available) => {
      if (current()) this.dependencies.onStream(available);
    });
    sdk.on("processingStatus", (status) => {
      forward("processingStatus", () => {
        push(mapProcessingEvent(status, this.dependencies.nowUs()));
      });
      if (!current()) return;
      this.update({
        processingStatus: statusNames[status] ?? String(status),
      });
      if (
        status === ProcessingStatus.kError ||
        (status === ProcessingStatus.kIdle && this.state.active)
      )
        void this.stop();
    });
    sdk.on("validationStatus", (code, timestampUs, hint) => {
      forward("validationStatus", () => {
        push(mapValidationEvent(code, timestampUs, hint));
      });
      if (current()) this.update({ validation: { code, hint } });
    });
    sdk.on("metrics", (buffer) => {
      forward("metrics", () => {
        const metrics = timestampedMetrics(
          (this.dependencies.decodeMetrics ?? decodeMetrics)(buffer),
        );
        const frames = mapMetrics(metrics);
        for (const frame of frames) {
          push(frame);
        }
        const pulse = frames
          .filter((frame) => frame.kind === "pulseRate")
          .at(-1);
        if (current() && pulse?.kind === "pulseRate") {
          this.update({
            pulse: {
              value: pulse.reading.value,
              confidence: pulse.reading.confidence,
              stable: pulse.reading.stable,
            },
          });
        }
      });
    });
    let window: FpsWindow = {
      startedAtMs: this.dependencies.now(),
      frames: 0,
    };
    sdk.on("frameSentThrough", (sent) => {
      if (current()) window = countFrame(window, sent);
    });
    sdk.on("error", (code, message, retryable) => {
      if (!current()) return;
      // Never include the credential in an SDK-supplied error message.
      this.update({
        error: `${code}: ${message.split(apiKey).join("[redacted]")}`,
      });
      if (!retryable) void this.stop();
    });
    capture.cancelTimer = this.dependencies.schedule(() => {
      if (!current()) return;
      const sample = sampleFps(window, this.dependencies.now());
      window = sample.next;
      this.update({ fps: sample.fps });
    });
  }

  private cancelCapture(session: Measurement, drainFrames: boolean): void {
    const capture = session.capture;
    if (!capture || capture.cancelled) return;
    capture.cancelled = true;
    capture.drainFrames = drainFrames;
    capture.cancelOpening?.();
    capture.cancelTimer?.();
    capture.cancelTimer = null;
    this.dependencies.mediaDevices.abort();
    this.releaseTracks(capture);
    // SDK start and stop both manipulate its frame loop. Destroy rejects a
    // pending start and releases its clone without racing a concurrent stop.
    if (!capture.started || this.disposed) this.destroySdk(capture);
  }

  private async closeCapture(session: Measurement): Promise<void> {
    const capture = session.capture;
    if (!capture) return;
    try {
      await capture.sdk?.stop();
    } catch {
      if (!this.disposed)
        this.update({
          error: "SDK stop failed; capture was released and the SDK destroyed.",
        });
    } finally {
      this.destroySdk(capture);
      session.capture = null;
    }
  }

  private releaseTracks(capture: Capture): void {
    if (!capture.stream) return;
    capture.unwatchTracks?.();
    capture.unwatchTracks = null;
    for (const track of capture.stream.getTracks()) track.stop();
    capture.stream = null;
    this.dependencies.onStream(null);
  }

  private destroySdk(capture: Capture | null): void {
    capture?.sdk?.destroy();
    if (capture) capture.sdk = null;
  }

  private async failStart(session: Measurement, error: unknown): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Unknown SDK error.";
    const safeMessage = session.apiKey
      ? message.split(session.apiKey).join("[redacted]")
      : message;
    this.update({
      error:
        error instanceof DOMException
          ? cameraErrorMessage(error)
          : `Unable to start measurement: ${safeMessage}`,
    });
    session.ending = true;
    session.apiKey = null;
    const endingMain = this.noticeTerminalStop(session);
    this.cancelCapture(session, false);
    await this.finishSession(session, endingMain);
  }

  private noticeTerminalStop(session: Measurement): Promise<void> | undefined {
    if (this.mainMeasurement !== session) return;
    try {
      // The notice and drain frames use ordered sends to the same main process.
      this.dependencies.bridge.noticeEnd();
    } catch {
      return this.endMeasurement();
    }
  }

  private async finishSession(
    session: Measurement,
    endingMain?: Promise<void>,
  ): Promise<void> {
    await this.closeCapture(session);
    await (endingMain ?? this.endMeasurement());
    this.session = null;
    this.update({ ...initialState(), error: this.state.error });
  }

  private endMeasurement(): Promise<void> {
    if (this.mainEndRequest) return this.mainEndRequest;
    if (!this.mainMeasurement) return Promise.resolve();
    this.mainEndRequest = this.requestMainEnd().finally(() => {
      this.mainEndRequest = null;
    });
    return this.mainEndRequest;
  }

  private async requestMainEnd(): Promise<void> {
    try {
      await this.dependencies.bridge.endMeasurement();
      this.mainMeasurement = null;
      if (this.state.error === mainEndError) this.update({ error: "" });
    } catch {
      this.update({ error: mainEndError });
    }
  }

  private update(patch: Partial<SdkDebugState>): void {
    this.state = { ...this.state, ...patch };
    this.dependencies.onState(this.state);
  }
}
