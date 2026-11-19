import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  powerSaveBlocker,
  systemPreferences,
} from "electron";
import type { PrivacyMode } from "../../domain/privacy/index";
import type {
  CameraAccessStatus,
  LiveMeasurement,
  MeasurementOptions,
  PanelCommandResult,
} from "../../shared/ipc-contract";
import type { MainConfiguration } from "./configuration";
import { measurementPower } from "./measurement-power";
import { allowsVideo, isAppPage } from "./permission-policy";

/** Lifecycle seam keeps adapter composition in main/composition-root.ts. */
export interface MeasurementSession {
  readonly captureGeneration?: number;
  start(options: MeasurementOptions): Promise<void>;
  stop(): Promise<void>;
  setPrivacyMode?(mode: PrivacyMode, shutdown?: "drain"): Promise<void>;
  setPaused?(paused: boolean): Promise<void>;
  copyOverlayUrl?(): Promise<PanelCommandResult>;
  exportChapters?(): Promise<PanelCommandResult>;
  saveHighlightList?(): Promise<PanelCommandResult>;
  deleteAllData?(): Promise<PanelCommandResult>;
  dispose?(): Promise<void>;
}

function measurementOptions(value: unknown): MeasurementOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    !("metricConfig" in value) ||
    (value.metricConfig !== "a" && value.metricConfig !== "b") ||
    !("recordSession" in value) ||
    typeof value.recordSession !== "boolean" ||
    ("privacyMode" in value && !isPrivacyMode(value.privacyMode))
  )
    throw new Error("Invalid measurement options.");
  return {
    metricConfig: value.metricConfig,
    recordSession: value.recordSession,
    privacyMode:
      "privacyMode" in value ? (value.privacyMode as PrivacyMode) : "vibe",
  };
}

function isPrivacyMode(value: unknown): value is PrivacyMode {
  return (
    value === "off" ||
    value === "vibe" ||
    value === "numbers" ||
    value === "highlightsOnly"
  );
}

/** Creates the restricted shell; SDK binding is supplied by the composition root. */
export function createWindowHost(options: {
  distRoot: string;
  replay: boolean;
  configuration: MainConfiguration;
  bindSdk(window: BrowserWindow): void;
  createMeasurementSession(
    window: BrowserWindow,
    isTrusted: (event: Pick<IpcMainEvent, "sender" | "senderFrame">) => boolean,
    onActivityChanged: (active: boolean) => void,
    hasRecordedConsent: () => boolean,
  ): MeasurementSession;
}): BrowserWindow {
  const panelPath = join(options.distRoot, "presentation/panel/index.html");
  const appPages = [pathToFileURL(panelPath).href];
  const window = new BrowserWindow({
    width: 960,
    height: 840,
    acceptFirstMouse: true,
    title: options.replay ? "Heart on Stream (REPLAY)" : "Heart on Stream",
    webPreferences: {
      preload: join(options.distRoot, "preload/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  const power = measurementPower(powerSaveBlocker);
  const session = contents.session;
  let consentRecorded = false;

  session.setPermissionRequestHandler(
    (sender, permission, callback, details) => {
      callback(
        consentRecorded &&
          sender === contents &&
          details.isMainFrame &&
          allowsVideo(
            permission,
            details.requestingUrl,
            "mediaTypes" in details ? details.mediaTypes : undefined,
            appPages,
          ),
      );
    },
  );
  session.setPermissionCheckHandler((sender, permission, _origin, details) => {
    return (
      consentRecorded &&
      sender === contents &&
      details.isMainFrame &&
      allowsVideo(
        permission,
        details.requestingUrl,
        details.mediaType ? [details.mediaType] : undefined,
        appPages,
      )
    );
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());

  const trustedSender = (
    event: Pick<IpcMainEvent, "sender" | "senderFrame">,
  ): boolean =>
    event.sender === contents &&
    event.senderFrame === contents.mainFrame &&
    isAppPage(event.senderFrame.url, appPages);
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (!trustedSender(event))
      throw new Error("Untrusted application request.");
  };
  let closing = false;
  let closeReady = false;
  let measurementRequested = false;
  let sdkBound = false;
  let finishing: Promise<void> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const measurement = options.createMeasurementSession(
    window,
    trustedSender,
    (active) => {
      if (active) {
        // Loops start a fresh replay session without another renderer Start.
        if (!closing && (measurementRequested || options.replay)) power.start();
      } else {
        measurementRequested = false;
        power.stop();
      }
    },
    () => consentRecorded,
  );
  const stopMeasurement = (): Promise<void> => {
    measurementRequested = false;
    power.stop();
    return measurement.stop();
  };
  const withdrawForClose = (): Promise<void> =>
    !options.replay && measurement.setPrivacyMode
      ? measurement.setPrivacyMode("off", "drain")
      : stopMeasurement();
  const finishClose = (force = false): void => {
    if (finishing) return;
    if (closeTimer !== null) clearTimeout(closeTimer);
    // The renderer deadline does not truncate pending recorder writes.
    finishing = stopMeasurement()
      .catch(() => {
        console.error("Unable to finish the measurement before closing.");
      })
      .then(() => {
        closeReady = true;
        if (!window.isDestroyed()) {
          if (force) window.destroy();
          else window.close();
        }
      });
  };

  ipcMain.handle("app:configuration", (event) => {
    assertSender(event);
    return options.configuration.public;
  });
  ipcMain.handle("panel:accept-consent", (event) => {
    assertSender(event);
    if (options.replay)
      throw new Error("Camera agreement is only available in live mode.");
    if (closing) throw new Error("The application is closing.");
    consentRecorded = true;
  });
  ipcMain.handle("camera:access-status", (event): CameraAccessStatus => {
    assertSender(event);
    return process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("camera")
      : "unknown";
  });
  ipcMain.handle("measurement:begin", (event, request: unknown) => {
    assertSender(event);
    if (
      closing ||
      !options.configuration.public.canStart ||
      (!options.replay && !consentRecorded)
    )
      return null;
    const selection = measurementOptions(request);
    if (!options.replay && !sdkBound) {
      options.bindSdk(window);
      sdkBound = true;
    }
    measurementRequested = true;
    return measurement.start(selection).then((): LiveMeasurement | null => {
      if (closing || !measurementRequested) return null;
      power.start();
      const { captureGeneration } = measurement;
      const { apiKey } = options.configuration;
      return !options.replay && apiKey && captureGeneration !== undefined
        ? { apiKey, captureGeneration }
        : null;
    });
  });
  const onEndNotice = (event: IpcMainEvent): void => {
    if (options.replay || !measurementRequested || !trustedSender(event))
      return;
    void measurement.setPrivacyMode?.("off", "drain").catch(() => {
      console.error("Unable to withdraw live sharing before shutdown.");
    });
  };
  ipcMain.on("measurement:end-notice", onEndNotice);
  ipcMain.handle("measurement:end", (event) => {
    assertSender(event);
    return stopMeasurement();
  });
  ipcMain.handle(
    "session:privacy",
    (event, mode: unknown, shutdown: unknown) => {
      assertSender(event);
      if (!isPrivacyMode(mode)) throw new Error("Invalid privacy mode.");
      if (
        shutdown !== undefined &&
        (shutdown !== "drain" || mode !== "off" || options.replay)
      )
        throw new Error("Invalid privacy shutdown request.");
      if (closing) return withdrawForClose();
      return shutdown === "drain"
        ? measurement.setPrivacyMode?.(mode, shutdown)
        : measurement.setPrivacyMode?.(mode);
    },
  );
  for (const [channel, command] of [
    ["session:pause", () => measurement.setPaused?.(true)],
    ["session:resume", () => measurement.setPaused?.(false)],
    ["panel:copy-overlay", () => measurement.copyOverlayUrl?.()],
    ["session:export", () => measurement.exportChapters?.()],
    ["session:save-highlights", () => measurement.saveHighlightList?.()],
    ["session:delete", () => measurement.deleteAllData?.()],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      assertSender(event);
      if (closing) throw new Error("The application is closing.");
      return command();
    });
  }
  const onCloseReady = (event: IpcMainEvent): void => {
    if (closing && trustedSender(event)) finishClose();
  };
  ipcMain.on("app:close-ready", onCloseReady);

  window.on("close", (event) => {
    if (closeReady) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    // Latch Off now, while the renderer can still send frames to main.
    void withdrawForClose().catch(() => {
      console.error("Unable to withdraw sharing before window close.");
    });
    // Destruction also releases capture and the SDK port if the renderer hangs.
    closeTimer = setTimeout(() => finishClose(true), 3000);
    contents.send("app:before-close");
  });
  contents.on("render-process-gone", () => {
    if (closing) finishClose(true);
    else
      void stopMeasurement().catch(() => {
        console.error("Unable to finish measurement after renderer exit.");
      });
  });
  window.once("closed", () => {
    void stopMeasurement()
      .then(() => measurement.dispose?.())
      .catch(() => {
        console.error("Unable to finish measurement after window close.");
      });
    if (closeTimer !== null) clearTimeout(closeTimer);
    for (const channel of [
      "app:configuration",
      "panel:accept-consent",
      "camera:access-status",
      "measurement:begin",
      "measurement:end",
      "session:privacy",
      "session:pause",
      "session:resume",
      "panel:copy-overlay",
      "session:export",
      "session:save-highlights",
      "session:delete",
    ]) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeListener("app:close-ready", onCloseReady);
    ipcMain.removeListener("measurement:end-notice", onEndNotice);
  });

  void window
    .loadFile(panelPath, { query: { replay: options.replay ? "1" : "0" } })
    .catch(() => {
      console.error("Unable to load the Heart on Stream panel.");
      window.destroy();
    });
  return window;
}
