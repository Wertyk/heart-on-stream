import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type {
  ObsClient,
  ObsProfileParameter,
  ObsRecordingStatus,
} from "../../src/infrastructure/obs/obs-websocket-marker";

export class FakeObsClient extends EventEmitter implements ObsClient {
  readonly connect = vi.fn(async () => {});
  readonly disconnect = vi.fn(async () => {});
  recording: ObsRecordingStatus = {
    outputActive: true,
    outputPaused: false,
    outputDuration: 12_345,
  };
  readonly getStatus = vi.fn(async () => ({ ...this.recording }));
  readonly getProfileParameter = vi.fn(
    async ({ parameterName }: ObsProfileParameter) => ({
      parameterValue: parameterName === "Mode" ? "Simple" : null,
    }),
  );
  readonly chapter = vi.fn(async (_data: { chapterName: string }) => {});
  readonly requests: string[] = [];

  call(request: "GetRecordStatus"): Promise<typeof this.recording>;
  call(
    request: "GetProfileParameter",
    data: ObsProfileParameter,
  ): Promise<{ parameterValue: string | null }>;
  call(
    request: "CreateRecordChapter",
    data: { chapterName: string },
  ): Promise<unknown>;
  async call(
    request: "GetRecordStatus" | "GetProfileParameter" | "CreateRecordChapter",
    data?: ObsProfileParameter | { chapterName: string },
  ): Promise<unknown> {
    this.requests.push(request);
    if (request === "GetRecordStatus") return this.getStatus();
    if (request === "GetProfileParameter") {
      if (!data || !("parameterName" in data))
        throw new Error("Profile parameter data is required");
      return this.getProfileParameter(data);
    }
    if (!data || !("chapterName" in data))
      throw new Error("Chapter data is required");
    return this.chapter(data);
  }
}
