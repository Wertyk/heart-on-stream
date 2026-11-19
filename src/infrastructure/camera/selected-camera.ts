type VideoInput = Pick<MediaDeviceInfo, "deviceId" | "label">;

interface SelectedCameraDependencies {
  getUserMedia: MediaDevices["getUserMedia"];
  enumerateVideoInputs(): Promise<readonly VideoInput[]>;
  resolveSelection(
    devices: readonly VideoInput[],
  ): Pick<VideoInput, "deviceId"> | undefined;
  reportEnumerationError(error: unknown): void;
}

interface OpenCameraOptions {
  readonly requestedDeviceId?: string;
  readonly resolveAfterPermission?: boolean;
}

function exactDeviceId(
  constraints: MediaStreamConstraints | undefined,
): string | undefined {
  const video = constraints?.video;
  const device = typeof video === "object" ? video.deviceId : undefined;
  if (
    typeof device === "object" &&
    "exact" in device &&
    typeof device.exact === "string"
  ) {
    return device.exact;
  }
}

/** Resolves camera labels after permission, before handing capture to the SDK host. */
export class SelectedCamera {
  private opening: AbortController | undefined;

  constructor(private readonly dependencies: SelectedCameraDependencies) {}

  async open(
    constraints: MediaStreamConstraints | undefined,
    {
      requestedDeviceId = exactDeviceId(constraints),
      resolveAfterPermission = true,
    }: OpenCameraOptions = {},
  ): Promise<MediaStream> {
    this.abort();
    const opening = new AbortController();
    this.opening = opening;
    const { signal } = opening;
    let pendingStream: MediaStream | undefined;
    const release = () => {
      const stream = pendingStream;
      pendingStream = undefined;
      for (const track of stream?.getTracks() ?? []) {
        if (track.readyState !== "ended") track.stop();
      }
    };
    signal.addEventListener("abort", release, { once: true });

    try {
      let stream = await this.dependencies.getUserMedia(constraints);
      pendingStream = stream;
      signal.throwIfAborted();

      const devices = resolveAfterPermission
        ? await this.listInputs()
        : undefined;
      signal.throwIfAborted();
      if (devices?.length) {
        const selected = this.dependencies.resolveSelection(devices);
        if (!selected)
          throw new Error("Choose a camera in Setup before starting.");
        const { deviceId } = selected;
        const openedId = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (
          deviceId &&
          deviceId !== openedId &&
          deviceId !== requestedDeviceId
        ) {
          release();
          const video =
            typeof constraints?.video === "object" ? constraints.video : {};
          stream = await this.dependencies.getUserMedia({
            ...constraints,
            video: { ...video, deviceId: { exact: deviceId } },
          });
          pendingStream = stream;
        }
      }
      signal.throwIfAborted();
      pendingStream = undefined;
      return stream;
    } finally {
      signal.removeEventListener("abort", release);
      release();
      if (this.opening === opening) this.opening = undefined;
    }
  }

  /** Release capture still owned by an in-flight open. The caller owns returned streams. */
  abort(): void {
    this.opening?.abort();
  }

  private async listInputs(): Promise<readonly VideoInput[] | undefined> {
    try {
      return await this.dependencies.enumerateVideoInputs();
    } catch (error) {
      this.dependencies.reportEnumerationError(error);
    }
  }
}
