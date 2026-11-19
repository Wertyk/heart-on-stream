import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecorder } from "../../application/ports/session-recorder";
import type { SessionRecord } from "../../domain/session/index";
import type { SessionMetadata } from "./jsonl-session";
import { JsonlSessionRecorder } from "./jsonl-session-recorder";

// Both generations of the recorder use randomUUID; newer files prefix the UTC start time.
const recordingName =
  /^session-(?:(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/u;

function isRecordingName(name: string): boolean {
  const match = recordingName.exec(name);
  if (!match) return false;
  const timestamp = match[1];
  if (timestamp === undefined) return true;
  const isoTime = timestamp.replace(/T(\d{2})-(\d{2})-/u, "T$1:$2:");
  const date = new Date(isoTime);
  return Number.isFinite(date.getTime()) && date.toISOString() === isoTime;
}

/** StreamSession owns opt-in; each start snapshots fresh metadata and owns a new file. */
export class PerSessionRecorder implements SessionRecorder {
  private current: JsonlSessionRecorder | null = null;
  private path: string | null = null;
  private operations: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly metadata: () => SessionMetadata,
  ) {}

  get filePath(): string | null {
    return this.path;
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.current)
        throw new Error("Session recording is already started.");
      const recorder = new JsonlSessionRecorder(
        this.directory,
        this.metadata(),
      );
      this.current = recorder;
      this.path = null;
      await recorder.start();
      this.path = recorder.filePath;
    });
  }

  append(frame: SessionRecord): Promise<void> {
    return this.enqueue(async () => {
      if (!this.current) throw new Error("Session recording is not started.");
      await this.current.append(frame);
    });
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.close());
  }

  deleteAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.close();
      let entries: Dirent<string>[];
      try {
        entries = await readdir(this.directory, { withFileTypes: true });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isFile() && isRecordingName(entry.name))
          await unlink(join(this.directory, entry.name));
      }
      this.path = null;
    });
  }

  private async close(): Promise<void> {
    await this.current?.stop();
    this.current = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }
}
