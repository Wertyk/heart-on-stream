export interface CameraDevice {
  readonly deviceId: string;
  readonly label: string;
}

/** The picker can only identify a virtual camera once the browser exposes its label. */
export function isVirtualCamera(label: string): boolean {
  return /\b(?:virtual|vcam|manycam|mmhmm|snap camera|camo|ndi)\b/i.test(label);
}

/** An empty ID can represent the browser's anonymous default input before permission. */
export function selectCamera(
  devices: readonly CameraDevice[],
  remembered?: CameraDevice,
): CameraDevice | undefined {
  return (
    devices.find(
      (device) =>
        remembered?.deviceId && device.deviceId === remembered.deviceId,
    ) ??
    devices.find(
      (device) => remembered?.label && device.label === remembered.label,
    ) ??
    devices.find((device) => device.label && !isVirtualCamera(device.label)) ??
    devices.find((device) => !device.label) ??
    (devices.length === 1 ? devices[0] : undefined)
  );
}
