import type { PrivacyMode } from "../domain/privacy/index";
import { SelectedCamera } from "../infrastructure/camera/selected-camera";
import { SdkHost } from "../infrastructure/smartspectra/sdk-host/sdk-host";
import { createDebugPanel } from "../presentation/panel/debug-panel";
import {
  canUseCamera,
  initialFlow,
  transitionFlow,
} from "../presentation/panel/screen-flow";

const root = document.querySelector("#app");
if (!root) throw new Error("Panel root is missing.");
const replay =
  new URLSearchParams(window.location.search).get("replay") === "1";
document.title = replay ? "Heart on Stream (REPLAY)" : "Heart on Stream";
const bridge = window.heartBridge;
let consentFlow = initialFlow(replay);
let privacyMode: PrivacyMode = "vibe";
let live: SdkHost | undefined;
const report = (error: unknown): void =>
  panel.showError(
    error instanceof Error ? error.message : "The session command failed.",
  );
const panel = createDebugPanel(
  root,
  {
    async acceptConsent() {
      const agreed = transitionFlow(consentFlow, {
        type: "agree",
        onlyPerson: true,
      });
      if (replay) {
        consentFlow = agreed;
        return;
      }
      if (live) return;
      if (!bridge)
        throw new Error("The application preload bridge is unavailable.");
      await bridge.acceptConsent();
      const mediaDevices = navigator.mediaDevices;
      const camera = new SelectedCamera({
        getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
        enumerateVideoInputs,
        resolveSelection: panel.showCameras,
        reportEnumerationError: showCameraListError,
      });
      live = new SdkHost({
        bridge: {
          pushFrame: (frame) => bridge.pushFrame(frame),
          getCameraAccessStatus: () => bridge.getCameraAccessStatus(),
          beginMeasurement: (options) =>
            bridge.beginMeasurement({ ...options, privacyMode }),
          endMeasurement: () => bridge.endMeasurement(),
          noticeEnd: () => bridge.noticeEnd(),
        },
        mediaDevices: {
          getUserMedia: (constraints, reopen) =>
            camera.open(constraints, { resolveAfterPermission: !reopen }),
          abort: () => camera.abort(),
        },
        now: () => performance.now(),
        nowUs: () => Date.now() * 1000,
        schedule(callback) {
          const timer = setInterval(callback, 1000);
          return () => clearInterval(timer);
        },
        onState: (state) => panel.showMeasurement(state),
        onStream: (stream) => panel.showStream(stream),
        onCameraDisconnected: () => {
          void bridge.pause().catch(report);
        },
      });
      mediaDevices?.addEventListener("devicechange", onDeviceChange);
      consentFlow = agreed;
      void refreshCameras();
    },
    async start(deviceId, config, recordSession, mode) {
      if (!consentFlow.consentAccepted)
        throw new Error("Accept the notice before starting a session.");
      privacyMode = mode;
      if (replay)
        await bridge.beginMeasurement({
          metricConfig: config,
          recordSession: false,
          privacyMode: mode,
        });
      else await live?.start(deviceId, config, recordSession);
    },
    async stop() {
      if (replay) await bridge.endMeasurement();
      else {
        // The notice and drained frames use ordered sends to the same main process.
        const noticeSent = sendLiveEndNotice();
        const withdrawal = withdrawLiveSharing();
        await Promise.all([
          withdrawal,
          live?.stop({
            withdrawalFallback: noticeSent ? undefined : withdrawal,
          }),
        ]);
      }
    },
    refreshCameras: () => {
      void refreshCameras();
    },
    async setPrivacyMode(mode) {
      privacyMode = mode;
      const sharing = bridge.setPrivacyMode(mode);
      if (mode === "off") await Promise.all([sharing, stopLiveSession()]);
      else await sharing;
    },
    pause: () => bridge.pause(),
    resume: () => bridge.resume(),
    copyOverlayUrl: () => bridge.copyOverlayUrl(),
    exportChapters: () => bridge.exportChapters(),
    saveHighlightList: () => bridge.saveHighlightList(),
    deleteAllData: () => bridge.deleteAllData(),
  },
  replay,
);

async function enumerateVideoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}
function showCameraListError(): void {
  panel.showCameraError(
    "Unable to list cameras. Check system camera permissions and refresh.",
  );
}
async function refreshCameras(): Promise<void> {
  if (!canUseCamera(consentFlow)) return;
  try {
    panel.showCameras(await enumerateVideoInputs());
  } catch {
    showCameraListError();
  }
}

function stopLiveSession(): Promise<void> | undefined {
  return live?.stop();
}
function sendLiveEndNotice(): boolean {
  try {
    bridge.noticeEnd();
    return true;
  } catch {
    return false;
  }
}
function withdrawLiveSharing(): Promise<void> {
  try {
    return bridge.setPrivacyMode("off", "drain");
  } catch (error) {
    return Promise.reject(error);
  }
}
function onDeviceChange(): void {
  void refreshCameras();
}

if (bridge) {
  let sessionWasActive = false;
  const unsubscribePanel = bridge.onPanelState((state) => {
    panel.showSession(state);
    const ended = !state.active && sessionWasActive;
    sessionWasActive = state.active;
    const generation = state.runtime?.captureGeneration;
    if (ended) void stopLiveSession()?.catch(report);
    else if (state.active && generation !== undefined)
      void live
        ?.setPaused(state.pauseReason !== null, generation)
        .catch(report);
  });
  const unsubscribeRecording = bridge.onRecordingState((state) =>
    panel.showRecording(state),
  );
  const dispose = (): Promise<void> =>
    live ? live.dispose() : bridge.endMeasurement();
  const unsubscribeClose = bridge.onBeforeClose(() => {
    void dispose().finally(() => bridge.confirmClose());
  });
  window.addEventListener("beforeunload", () => {
    unsubscribeClose();
    unsubscribeRecording();
    unsubscribePanel();
    if (canUseCamera(consentFlow))
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        onDeviceChange,
      );
    void dispose().catch(() => {});
  });
  void bridge.getConfiguration().then(
    (configuration) => panel.showConfiguration(configuration),
    () =>
      panel.showConfiguration({
        canStart: false,
        recordByDefault: false,
        message: "Unable to read main-process configuration. Restart the app.",
      }),
  );
} else {
  panel.showConfiguration({
    canStart: false,
    recordByDefault: false,
    message: "The application preload bridge is unavailable. Restart the app.",
  });
}
