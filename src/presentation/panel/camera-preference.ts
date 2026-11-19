import type { CameraDevice } from "./camera-selection";

const key = "heart-on-stream.camera";

/** The panel's persistent browser storage keeps the preference on this machine. */
export function readCameraPreference(): CameraDevice | undefined {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return;
    const camera: unknown = JSON.parse(stored);
    if (
      camera &&
      typeof camera === "object" &&
      "deviceId" in camera &&
      typeof camera.deviceId === "string" &&
      "label" in camera &&
      typeof camera.label === "string"
    ) {
      return { deviceId: camera.deviceId, label: camera.label };
    }
  } catch {
    // A missing, invalid, or unavailable preference falls back to the camera list.
  }
}

export function saveCameraPreference(camera: CameraDevice): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(camera));
  } catch {
    // The panel still keeps the choice for this run if storage is unavailable.
  }
}

export function forgetCameraPreference(): void {
  window.localStorage.removeItem(key);
}
