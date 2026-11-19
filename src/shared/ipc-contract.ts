import type { PanelState } from "../application/dto/panel-state";
import type { PrivacyMode } from "../domain/privacy/index";
import type { SignalFrame } from "../domain/signal/index";

/** The generation identifies the SDK capture that produced a normalized frame. */
export interface FramePushPayload {
  readonly captureGeneration: number;
  readonly frame: SignalFrame;
}

/** Credentials and capture identity returned only at a trusted live Start. */
export interface LiveMeasurement {
  readonly apiKey: string;
  readonly captureGeneration: number;
}

/** Streamer-only snapshot sent from main to the panel. */
export type PanelStatePayload = PanelState & {
  readonly runtime?: PanelRuntimeState;
};

/** Adapter status belongs only to the streamer, outside the overlay projection. */
export interface PanelRuntimeState {
  readonly overlayUrl: string;
  readonly overlayError: string;
  readonly obsMessage: string;
  readonly replayFile: string;
  readonly replayMessage: string;
  readonly shortcutMessage?: string;
  /** SDK timeline identity, shared with persisted highlights; absent before the first frame. */
  readonly sessionStartedAt?: number | null;
  /** Main advances this when a live capture resumes. */
  readonly captureGeneration?: number;
}

/** Channel names and payloads are one contract; runtime IPC wiring lives outside it. */
export interface IpcPayloads {
  readonly "frame:push": FramePushPayload;
  readonly "panel:state": PanelStatePayload;
  readonly "recording:state": RecordingState;
}

/** Normalized signal transport channels; shell lifecycle calls use HeartBridge. */
export type IpcChannel = keyof IpcPayloads;

/** Narrow contextBridge surface; subscriptions return an explicit unsubscribe. */
export interface HeartBridge {
  pushFrame(frame: FramePushPayload): void;
  onPanelState(listener: (state: PanelStatePayload) => void): () => void;
  getConfiguration(): Promise<PublicConfiguration>;
  /** Records live camera agreement for this window before accessing media devices. */
  acceptConsent(): Promise<void>;
  getCameraAccessStatus(): Promise<CameraAccessStatus>;
  /** Retrieves the credential only at Start and blocks suspension until Stop. */
  beginMeasurement(
    options: MeasurementOptions,
  ): Promise<LiveMeasurement | null>;
  /** Withdraws live sharing before the SDK sends its shutdown frames. */
  noticeEnd(): void;
  endMeasurement(): Promise<void>;
  /** Live End withdraws sharing while the SDK drains its last frames. */
  setPrivacyMode(mode: PrivacyMode, shutdown?: "drain"): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  copyOverlayUrl(): Promise<PanelCommandResult>;
  exportChapters(): Promise<PanelCommandResult>;
  saveHighlightList(): Promise<PanelCommandResult>;
  deleteAllData(): Promise<PanelCommandResult>;
  onRecordingState(listener: (state: RecordingState) => void): () => void;
  onBeforeClose(listener: () => void): () => void;
  confirmClose(): void;
}

/** OS camera authorization before capture. Other platforms return "unknown". */
export type CameraAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

/** Main returns safe, actionable results without exposing Electron to the panel. */
export type PanelCommandResult =
  | { readonly ok: true; readonly message: string; readonly path?: string }
  | { readonly ok: false; readonly message: string };

/** Metric selection is fixed for a single SDK instance. */
export type MetricConfiguration = "a" | "b";

/** Recording consent and metric selection are fixed before Start. */
export interface MeasurementOptions {
  readonly metricConfig: MetricConfiguration;
  readonly recordSession: boolean;
  /** Older SDK-host calls default to Vibe; renderer composition supplies the selection. */
  readonly privacyMode?: PrivacyMode;
}

/** Local recording status is for the streamer panel only. */
export interface RecordingState {
  readonly active: boolean;
  readonly filePath: string | null;
  readonly error: string;
}

/** Startup information contains no credential. */
export interface PublicConfiguration {
  readonly canStart: boolean;
  readonly message: string;
  readonly recordByDefault: boolean;
}

declare global {
  interface Window {
    readonly heartBridge: HeartBridge;
  }
}
