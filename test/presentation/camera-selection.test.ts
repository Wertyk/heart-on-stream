import { describe, expect, it } from "vitest";
import { isVirtualCamera } from "../../src/presentation/panel/camera-selection";

describe("isVirtualCamera", () => {
  it.each([
    "OBS Virtual Camera",
    "Virtual",
    "NVIDIA Broadcast VCam",
    "ManyCam Video Source",
    "mmhmm Camera",
    "Snap Camera",
    "CAMO",
    "NDI Video",
  ])("recognizes %s as virtual", (label) => {
    expect(isVirtualCamera(label)).toBe(true);
  });

  it.each(["", "MacBook Pro Camera", "Logitech BRIO", "Cameleon USB Webcam"])(
    "does not classify %j as virtual",
    (label) => {
      expect(isVirtualCamera(label)).toBe(false);
    },
  );
});
