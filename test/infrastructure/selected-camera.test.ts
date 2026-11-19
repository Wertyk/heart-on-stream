import { describe, expect, it, vi } from "vitest";
import { SelectedCamera } from "../../src/infrastructure/camera/selected-camera";

type Dependencies = ConstructorParameters<typeof SelectedCamera>[0];

const obs = { deviceId: "obs", label: "OBS Virtual Camera" };
const physical = { deviceId: "usb", label: "USB Camera" };
const inputs = [obs, physical];
const constraints = {
  audio: false,
  video: { width: { ideal: 1280 }, frameRate: { ideal: 30 } },
};

function fakeStream(deviceId?: string) {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId }) };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function fixture() {
  const dependencies = {
    getUserMedia: vi.fn<Dependencies["getUserMedia"]>(),
    enumerateVideoInputs: vi.fn<Dependencies["enumerateVideoInputs"]>(
      async () => inputs,
    ),
    resolveSelection: vi.fn<Dependencies["resolveSelection"]>(() => physical),
    reportEnumerationError: vi.fn<Dependencies["reportEnumerationError"]>(),
  };
  return { camera: new SelectedCamera(dependencies), ...dependencies };
}

describe("SelectedCamera", () => {
  it("keeps the stream that already matches the resolved preference", async () => {
    const f = fixture();
    const opened = fakeStream(physical.deviceId);
    f.getUserMedia.mockResolvedValueOnce(opened.stream);

    await expect(
      f.camera.open(constraints, { requestedDeviceId: "" }),
    ).resolves.toBe(opened.stream);
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith(constraints);
    expect(f.resolveSelection).toHaveBeenCalledExactlyOnceWith(inputs);
    f.camera.abort();
    expect(opened.track.stop).not.toHaveBeenCalled();
  });

  it("uses the SDK host's exact constraint when the track does not expose an ID", async () => {
    const f = fixture();
    const opened = fakeStream();
    f.getUserMedia.mockResolvedValueOnce(opened.stream);
    const requested = { video: { deviceId: { exact: physical.deviceId } } };

    await expect(f.camera.open(requested)).resolves.toBe(opened.stream);
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith(requested);
    expect(opened.track.stop).not.toHaveBeenCalled();
  });

  it("releases the provisional stream and reopens the preferred camera with the same capture settings", async () => {
    const f = fixture();
    const provisional = fakeStream(obs.deviceId);
    const preferred = fakeStream(physical.deviceId);
    f.getUserMedia
      .mockResolvedValueOnce(provisional.stream)
      .mockImplementationOnce(async () => {
        expect(provisional.track.stop).toHaveBeenCalledOnce();
        return preferred.stream;
      });
    f.enumerateVideoInputs.mockImplementationOnce(async () => {
      expect(provisional.track.stop).not.toHaveBeenCalled();
      return inputs;
    });

    await expect(
      f.camera.open(constraints, { requestedDeviceId: "" }),
    ).resolves.toBe(preferred.stream);
    expect(f.getUserMedia.mock.calls).toEqual([
      [constraints],
      [
        {
          ...constraints,
          video: {
            ...constraints.video,
            deviceId: { exact: physical.deviceId },
          },
        },
      ],
    ]);
    expect(preferred.track.stop).not.toHaveBeenCalled();
  });

  it("reopens a pinned device without resolving a new selection", async () => {
    const f = fixture();
    const reopened = fakeStream(obs.deviceId);
    f.getUserMedia.mockResolvedValueOnce(reopened.stream);
    const requested = { video: { deviceId: { exact: obs.deviceId } } };
    await expect(
      f.camera.open(requested, { resolveAfterPermission: false }),
    ).resolves.toBe(reopened.stream);
    expect(f.getUserMedia).toHaveBeenCalledExactlyOnceWith(requested);
    expect(f.enumerateVideoInputs).not.toHaveBeenCalled();
    expect(f.resolveSelection).not.toHaveBeenCalled();
  });

  it("releases the provisional tracks immediately when aborted during enumeration", async () => {
    const f = fixture();
    const provisional = fakeStream(obs.deviceId);
    f.getUserMedia.mockResolvedValueOnce(provisional.stream);
    let finishEnumeration!: (devices: typeof inputs) => void;
    f.enumerateVideoInputs.mockReturnValueOnce(
      new Promise((resolve) => {
        finishEnumeration = resolve;
      }),
    );

    const opening = f.camera.open(constraints);
    await Promise.resolve();
    expect(f.enumerateVideoInputs).toHaveBeenCalledOnce();
    f.camera.abort();
    expect(provisional.track.stop).toHaveBeenCalledOnce();
    finishEnumeration(inputs);
    await expect(opening).rejects.toHaveProperty("name", "AbortError");
    expect(provisional.track.stop).toHaveBeenCalledOnce();
    expect(f.resolveSelection).not.toHaveBeenCalled();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
  });

  it("releases a replacement stream that arrives after abort", async () => {
    const f = fixture();
    const provisional = fakeStream(obs.deviceId);
    const replacement = fakeStream(physical.deviceId);
    f.getUserMedia
      .mockResolvedValueOnce(provisional.stream)
      .mockImplementationOnce(async () => {
        f.camera.abort();
        return replacement.stream;
      });

    await expect(f.camera.open(constraints)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    expect(provisional.track.stop).toHaveBeenCalledOnce();
    expect(replacement.track.stop).toHaveBeenCalledOnce();
  });

  it("keeps the working stream when enumeration returns no inputs", async () => {
    const f = fixture();
    const opened = fakeStream(obs.deviceId);
    f.getUserMedia.mockResolvedValueOnce(opened.stream);
    f.enumerateVideoInputs.mockResolvedValueOnce([]);

    await expect(f.camera.open(constraints)).resolves.toBe(opened.stream);
    expect(f.resolveSelection).not.toHaveBeenCalled();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(opened.track.stop).not.toHaveBeenCalled();
  });

  it("reports an enumeration failure and keeps the working stream", async () => {
    const f = fixture();
    const opened = fakeStream(obs.deviceId);
    const error = new Error("Enumeration failed");
    f.getUserMedia.mockResolvedValueOnce(opened.stream);
    f.enumerateVideoInputs.mockRejectedValueOnce(error);

    await expect(f.camera.open(constraints)).resolves.toBe(opened.stream);
    expect(f.reportEnumerationError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.resolveSelection).not.toHaveBeenCalled();
    expect(opened.track.stop).not.toHaveBeenCalled();
  });

  it("releases the provisional stream and asks for a Setup choice when the panel selects no input", async () => {
    const f = fixture();
    const provisional = fakeStream(obs.deviceId);
    const onlyVirtual = [obs, { deviceId: "camo", label: "Camo" }];
    f.getUserMedia.mockResolvedValueOnce(provisional.stream);
    f.enumerateVideoInputs.mockResolvedValueOnce(onlyVirtual);
    f.resolveSelection.mockReturnValueOnce(undefined);

    await expect(f.camera.open(constraints)).rejects.toThrow(
      "Choose a camera in Setup before starting.",
    );
    expect(f.resolveSelection).toHaveBeenCalledExactlyOnceWith(onlyVirtual);
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    expect(provisional.track.stop).toHaveBeenCalledOnce();
  });
});
