import "@smartspectra/node-sdk/preload";
import { contextBridge, ipcRenderer } from "electron";
import type {
  HeartBridge,
  PanelStatePayload,
  RecordingState,
} from "../shared/ipc-contract";

const bridge: HeartBridge = {
  pushFrame: (frame) => ipcRenderer.send("frame:push", frame),
  onPanelState(listener) {
    const receive = (
      _event: Electron.IpcRendererEvent,
      state: PanelStatePayload,
    ) => listener(state);
    ipcRenderer.on("panel:state", receive);
    return () => ipcRenderer.removeListener("panel:state", receive);
  },
  getConfiguration: () => ipcRenderer.invoke("app:configuration"),
  acceptConsent: () => ipcRenderer.invoke("panel:accept-consent"),
  getCameraAccessStatus: () => ipcRenderer.invoke("camera:access-status"),
  beginMeasurement: (options) =>
    ipcRenderer.invoke("measurement:begin", options),
  noticeEnd: () => ipcRenderer.send("measurement:end-notice"),
  endMeasurement: () => ipcRenderer.invoke("measurement:end"),
  setPrivacyMode: (mode, shutdown) =>
    shutdown === undefined
      ? ipcRenderer.invoke("session:privacy", mode)
      : ipcRenderer.invoke("session:privacy", mode, shutdown),
  pause: () => ipcRenderer.invoke("session:pause"),
  resume: () => ipcRenderer.invoke("session:resume"),
  copyOverlayUrl: () => ipcRenderer.invoke("panel:copy-overlay"),
  exportChapters: () => ipcRenderer.invoke("session:export"),
  saveHighlightList: () => ipcRenderer.invoke("session:save-highlights"),
  deleteAllData: () => ipcRenderer.invoke("session:delete"),
  onRecordingState(listener) {
    const receive = (
      _event: Electron.IpcRendererEvent,
      state: RecordingState,
    ) => listener(state);
    ipcRenderer.on("recording:state", receive);
    return () => ipcRenderer.removeListener("recording:state", receive);
  },
  onBeforeClose(listener) {
    const receive = () => listener();
    ipcRenderer.on("app:before-close", receive);
    return () => ipcRenderer.removeListener("app:before-close", receive);
  },
  confirmClose: () => ipcRenderer.send("app:close-ready"),
};

contextBridge.exposeInMainWorld("heartBridge", bridge);
