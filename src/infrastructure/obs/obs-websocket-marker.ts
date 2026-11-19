import OBSWebSocket, { EventSubscription } from "obs-websocket-js";
import type {
  RecordingMarker,
  RecordingMarkerResult,
  RecordingToken,
} from "../../application/ports/recording-marker";

export interface ObsRecordingStatus {
  outputActive: boolean;
  outputPaused: boolean;
  outputDuration: number;
  /** Supplied by the export observer. Null means the file start is unknown. */
  fileOffsetMs?: number | null;
  /** Proof that this sample's cumulative duration is also its file offset. */
  pendingUnsplitOrigin?: Promise<boolean>;
}

export interface ObsRecordingState {
  outputActive: boolean;
  outputState: string;
}

export interface ObsProfileParameter {
  parameterCategory: "Output" | "AdvOut";
  parameterName: "Mode" | "RecSplitFile";
}

/** Only the read and chapter requests used by the OBS adapters are exposed. */
export interface ObsClient {
  connect(
    url: string,
    password: string | undefined,
    options: { eventSubscriptions: number },
  ): Promise<unknown>;
  disconnect(): Promise<void>;
  call(request: "GetRecordStatus"): Promise<ObsRecordingStatus>;
  call(
    request: "GetProfileParameter",
    data: ObsProfileParameter,
  ): Promise<{ parameterValue?: string | null }>;
  call(
    request: "CreateRecordChapter",
    data: { chapterName: string },
  ): Promise<unknown>;
  on(
    event: "ConnectionClosed" | "ConnectionError",
    listener: (error: unknown) => void,
  ): unknown;
  on(
    event: "RecordStateChanged",
    listener: (state: ObsRecordingState) => void,
  ): unknown;
  on(event: "RecordFileChanged", listener: () => void): unknown;
  off(
    event: "ConnectionClosed" | "ConnectionError",
    listener: (error: unknown) => void,
  ): unknown;
  off(
    event: "RecordStateChanged",
    listener: (state: ObsRecordingState) => void,
  ): unknown;
  off(event: "RecordFileChanged", listener: () => void): unknown;
}

/** Safe for forwarding to a panel: messages contain no credentials or OBS payloads. */
export interface ObsConnectionStatus {
  readonly status: "connected" | "disconnected" | "notRecording" | "error";
  readonly message: string;
}

export interface ObsWebsocketMarkerOptions {
  /** Composition supplies OBS_WS_URL; no environment access occurs here. */
  readonly url?: string;
  /** Composition supplies OBS_WS_PASSWORD when configured. */
  readonly password?: string;
  readonly client?: ObsClient;
}

type StatusListener = (status: ObsConnectionStatus) => void;
type RecordingState = "unknown" | "idle" | "paused" | "recording";
const requestTimeoutMs = 5_000;
const statusRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

function isLoopbackObsUrl(url: string): boolean {
  // Match the literal authority before URL parsing can normalize other hosts.
  return (
    /^ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?]|$)/u.test(
      url,
    ) &&
    URL.canParse(url) &&
    !url.includes("#")
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function unsupportedChapter(error: unknown): boolean {
  // UnknownRequestType (older OBS); RequestProcessingFailed plus OBS's
  // specific chapter-support message (other failures must still reject).
  return (
    errorCode(error) === 204 ||
    (errorCode(error) === 702 &&
      error instanceof Error &&
      /output being used supports chapter markers/iu.test(error.message))
  );
}

/**
 * Opt-in connection lifecycle with capped 1/2/4/.../30 second reconnects.
 * Construction performs no network I/O. Await start/stop in composition; start
 * contains connection failures, while unexpected chapter failures reject to the
 * application's existing local-highlight fallback. One instance owns one client.
 */
export class ObsWebsocketMarker implements RecordingMarker {
  private readonly client: ObsClient;
  private readonly url: string;
  private readonly listeners = new Set<StatusListener>();
  private readonly pendingRequests = new Set<(error: Error) => void>();
  private active = false;
  private connected = false;
  private generation = 0;
  private recordingToken = Symbol();
  private recordingState: RecordingState = "unknown";
  private recordingEvent: ObsRecordingState | undefined;
  private statusRetry: ReturnType<typeof setTimeout> | undefined;
  private statusRetryAttempt = 0;
  private retryDelayMs = 1_000;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private currentStatus: ObsConnectionStatus = {
    status: "disconnected",
    message: "OBS is disconnected.",
  };

  constructor(private readonly options: ObsWebsocketMarkerOptions = {}) {
    this.client = options.client ?? new OBSWebSocket();
    this.url = options.url ?? "ws://127.0.0.1:4455";
  }

  get connectionStatus(): ObsConnectionStatus {
    return { ...this.currentStatus };
  }

  /** Immediately supplies a detached snapshot; subscriber failures are isolated. */
  subscribeStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.active) return this.connecting ?? Promise.resolve();
    if (!isLoopbackObsUrl(this.url)) {
      this.setStatus(
        "error",
        "OBS connection disabled. Set OBS_WS_URL to a ws:// URL on 127.0.0.1, localhost, or [::1].",
      );
      return Promise.resolve();
    }
    // Let an earlier stopped attempt release its socket before reusing a client.
    if (this.connecting) return this.connecting.then(() => this.start());
    this.active = true;
    this.generation += 1;
    this.client.on("ConnectionClosed", this.onClosed);
    this.client.on("ConnectionError", this.onError);
    this.client.on("RecordStateChanged", this.onRecording);
    this.client.on("RecordFileChanged", this.onFileChanged);
    return this.connect();
  }

  /** Cancels retries and releases listeners/socket; await before restarting. */
  async stop(): Promise<void> {
    this.active = false;
    this.connected = false;
    this.resetRecording();
    this.generation += 1;
    this.cancelRequests();
    this.retryDelayMs = 1_000;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.client.off("ConnectionClosed", this.onClosed);
    this.client.off("ConnectionError", this.onError);
    this.client.off("RecordStateChanged", this.onRecording);
    this.client.off("RecordFileChanged", this.onFileChanged);
    this.setStatus("disconnected", "OBS is disconnected.");
    await this.disconnect();
  }

  captureRecording(): RecordingToken {
    return this.connected && this.recordingState === "recording"
      ? this.recordingToken
      : null;
  }

  async createChapter(
    label: string,
    signal?: AbortSignal,
    recordingToken: RecordingToken = this.recordingToken,
  ): Promise<RecordingMarkerResult> {
    if (signal?.aborted) return { status: "unavailable", reason: "cancelled" };
    if (!this.connected) {
      return { status: "unavailable", reason: "disconnected" };
    }
    const generation = this.generation;
    if (recordingToken !== this.recordingToken) {
      return { status: "unavailable", reason: "notRecording" };
    }
    const deadline = performance.now() + requestTimeoutMs;
    const recording = await this.readRecordingStatus();
    if (signal?.aborted) return { status: "unavailable", reason: "cancelled" };
    if (!this.connected || generation !== this.generation) {
      return { status: "unavailable", reason: "disconnected" };
    }
    if (
      recordingToken !== this.recordingToken ||
      this.recordingEvent?.outputActive === false ||
      this.recordingState === "paused" ||
      !recording.outputActive ||
      recording.outputPaused
    ) {
      return { status: "unavailable", reason: "notRecording" };
    }
    try {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw new Error("OBS request timed out");
      await this.request(
        () => this.client.call("CreateRecordChapter", { chapterName: label }),
        remainingMs,
      );
      // OBS has already acknowledged the chapter. Reuse the sampled time if
      // the ongoing profile check verifies that this recording is unsplit.
      if (
        recording.fileOffsetMs === null &&
        !(
          recording.pendingUnsplitOrigin &&
          (await recording.pendingUnsplitOrigin)
        )
      )
        return { status: "unavailable", reason: "unsupported" };
      return {
        status: "created",
        recordingOffsetMs: recording.fileOffsetMs ?? recording.outputDuration,
      };
    } catch (error) {
      const sameRecording =
        this.connected &&
        generation === this.generation &&
        recordingToken === this.recordingToken;
      if (unsupportedChapter(error)) {
        if (sameRecording) {
          this.setStatus("error", "OBS recording chapters are unsupported.");
        }
        return { status: "unavailable", reason: "unsupported" };
      }
      // Recording can stop between GetRecordStatus and CreateRecordChapter.
      if (errorCode(error) === 501) {
        if (sameRecording) {
          this.setStatus("notRecording", "OBS is not recording.");
        }
        return { status: "unavailable", reason: "notRecording" };
      }
      if (sameRecording) {
        this.setStatus("error", "OBS recording chapter request failed.");
      }
      throw error;
    }
  }

  private async readRecordingStatus() {
    const generation = this.generation;
    const recordingEvent = this.recordingEvent;
    const recordingToken = this.recordingToken;
    const isCurrent = () =>
      this.connected &&
      generation === this.generation &&
      recordingEvent === this.recordingEvent &&
      recordingToken === this.recordingToken;
    try {
      const recording = await this.request(() =>
        this.client.call("GetRecordStatus"),
      );
      if (
        typeof recording.outputActive !== "boolean" ||
        typeof recording.outputPaused !== "boolean" ||
        !Number.isFinite(recording.outputDuration) ||
        recording.outputDuration < 0
      ) {
        throw new Error("Invalid OBS recording status");
      }
      if (isCurrent()) {
        const state = recording.outputPaused
          ? "paused"
          : recording.outputActive
            ? "recording"
            : "idle";
        if (
          state === "idle" &&
          (this.recordingState === "recording" ||
            this.recordingState === "paused")
        )
          this.recordingToken = Symbol();
        this.reportRecording(state);
      }
      return recording;
    } catch (error) {
      if (isCurrent()) {
        this.setStatus("error", "OBS recording status request failed.");
        this.scheduleStatusRetry();
      }
      throw error;
    }
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    const task = this.attemptConnection(generation).finally(() => {
      this.connecting = undefined;
      if (this.active && !this.connected) this.scheduleRetry();
    });
    this.connecting = task;
    return task;
  }

  private async attemptConnection(generation: number): Promise<void> {
    try {
      await this.client.connect(this.url, this.options.password, {
        eventSubscriptions: EventSubscription.Outputs,
      });
      if (!this.active || this.generation !== generation) {
        await this.disconnect();
        return;
      }
      this.connected = true;
      this.retryDelayMs = 1_000;
      this.setStatus("connected", "OBS is connected.");
      // Establish useful panel status even before the first highlight.
      await this.readRecordingStatus().catch(() => {});
    } catch {
      if (this.active && this.generation === generation) {
        this.setStatus("error", "OBS connection or status request failed.");
      }
    }
  }

  private readonly onClosed = (): void => {
    if (!this.active) return;
    this.connected = false;
    this.resetRecording();
    this.generation += 1;
    this.cancelRequests();
    this.setStatus("disconnected", "OBS is disconnected; reconnecting.");
    if (!this.connecting) this.scheduleRetry();
  };

  private readonly onError = (): void => {
    if (!this.active) return;
    this.connected = false;
    this.resetRecording();
    this.generation += 1;
    this.cancelRequests();
    this.setStatus("error", "OBS connection failed.");
    if (!this.connecting) this.scheduleRetry();
  };

  private readonly onRecording = (state: ObsRecordingState): void => {
    this.recordingEvent = state;
    const paused = state.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED";
    if (
      state.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED" ||
      (!state.outputActive && !paused)
    )
      this.recordingToken = Symbol();
    if (this.connected)
      this.reportRecording(
        paused ? "paused" : state.outputActive ? "recording" : "idle",
      );
  };

  private readonly onFileChanged = (): void => {
    this.recordingToken = Symbol();
    this.scheduleStatusRetry();
  };

  private resetRecording(): void {
    this.recordingEvent = undefined;
    this.recordingState = "unknown";
    this.recordingToken = Symbol();
    this.clearStatusRetry();
  }

  private reportRecording(state: Exclude<RecordingState, "unknown">): void {
    this.recordingState = state;
    this.clearStatusRetry();
    const outputActive = state === "recording";
    this.setStatus(
      outputActive ? "connected" : "notRecording",
      outputActive
        ? "OBS is connected and recording."
        : "OBS is not recording.",
    );
  }

  private scheduleStatusRetry(): void {
    if (
      !this.connected ||
      this.recordingState !== "unknown" ||
      this.statusRetry
    )
      return;
    const delayMs = statusRetryDelaysMs[this.statusRetryAttempt];
    if (delayMs === undefined) return;
    this.statusRetryAttempt++;
    this.statusRetry = setTimeout(() => {
      this.statusRetry = undefined;
      void this.readRecordingStatus().catch(() => {});
    }, delayMs);
    this.statusRetry.unref();
  }

  private clearStatusRetry(): void {
    clearTimeout(this.statusRetry);
    this.statusRetry = undefined;
    this.statusRetryAttempt = 0;
  }

  private scheduleRetry(): void {
    if (!this.active || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.active) void this.connect();
    }, this.retryDelayMs);
    this.retry.unref();
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  private async request<T>(
    operation: () => Promise<T>,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> {
    let cancel: (error: Error) => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = reject;
    });
    this.pendingRequests.add(cancel);
    const timeout = setTimeout(() => {
      cancel(new Error("OBS request timed out"));
    }, timeoutMs);
    timeout.unref();
    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      clearTimeout(timeout);
      this.pendingRequests.delete(cancel);
    }
  }

  private cancelRequests(): void {
    for (const cancel of this.pendingRequests) {
      cancel(new Error("OBS disconnected during request"));
    }
  }

  private async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch {
      this.setStatus("error", "OBS disconnection failed.");
    }
  }

  private setStatus(
    status: ObsConnectionStatus["status"],
    message: string,
  ): void {
    if (
      status === this.currentStatus.status &&
      message === this.currentStatus.message
    )
      return;
    this.currentStatus = { status, message };
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: StatusListener): void {
    try {
      listener(this.connectionStatus);
    } catch {
      // A panel observer must never interrupt connection or session operations.
    }
  }
}
