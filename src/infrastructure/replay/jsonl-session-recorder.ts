import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRecorder } from "../../application/ports/index";
import type { SessionRecord } from "../../domain/session/index";
import {
  encodeSessionHeader,
  encodeSignalFrame,
  type SessionMetadata,
  validateDrainPlacement,
} from "./jsonl-session";

/**
 * Opt-in local recorder. Construction performs no I/O; only start creates output.
 * Operations serialize in call order, including concurrent append/stop/delete.
 * Ownership is per instance, never inferred from a directory or filename glob.
 */
export class JsonlSessionRecorder implements SessionRecorder {
  private readonly headerLine: string;
  private readonly filenameTime: string;
  private path: string | null = null;
  private readonly ownedFiles = new Set<string>();
  private operations: Promise<void> = Promise.resolve();
  private file: FileHandle | undefined;
  private writeFailed = false;
  private endWritten = false;
  private drainWritten = false;
  private nextLine = 2;

  constructor(
    private readonly outputDirectory: string,
    metadata: SessionMetadata,
  ) {
    this.headerLine = encodeSessionHeader(metadata);
    this.filenameTime = new Date(metadata.startTimeUs / 1000)
      .toISOString()
      .replaceAll(":", "-");
  }

  /** Retains the last file path after Stop so the panel can locate the completed file. */
  get filePath(): string | null {
    return this.path;
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.file) throw new Error("Session recording is already started");
      await mkdir(this.outputDirectory, { recursive: true });
      const path = join(
        this.outputDirectory,
        `session-${this.filenameTime}-${randomUUID()}.jsonl`,
      );
      const file = await open(path, "wx", 0o600);
      this.ownedFiles.add(path);
      try {
        await file.writeFile(this.headerLine, "utf8");
      } catch (error) {
        await file.close();
        throw error;
      }
      this.file = file;
      this.path = path;
      this.writeFailed = false;
      this.endWritten = false;
      this.drainWritten = false;
      this.nextLine = 2;
    });
  }

  async append(frame: SessionRecord): Promise<void> {
    // Snapshot and validate before queueing so later caller mutations cannot leak.
    const line = encodeSignalFrame(frame);
    const kind = frame.kind;
    return this.enqueue(async () => {
      if (!this.file) throw new Error("Session recording has not been started");
      if (this.writeFailed)
        throw new Error("Session recording failed; stop before restarting");
      if (this.endWritten)
        throw new Error("The end record has already been written");
      validateDrainPlacement(kind, this.drainWritten);
      try {
        await this.file.writeFile(line, "utf8");
        this.endWritten = kind === "end";
        this.drainWritten ||= kind === "drain";
        this.nextLine += 1;
      } catch (error) {
        this.writeFailed = true;
        throw new Error(`JSONL line ${this.nextLine}: recording write failed`, {
          cause: error,
        });
      }
    });
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.close());
  }

  deleteAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.close();
      for (const path of this.ownedFiles) {
        await rm(path, { force: true });
        this.ownedFiles.delete(path);
      }
    });
  }

  private async close(): Promise<void> {
    const file = this.file;
    this.file = undefined;
    if (!file) return;
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    // Keep cleanup available after a failed call; its caller still gets rejection.
    this.operations = result.catch(() => {});
    return result;
  }
}
