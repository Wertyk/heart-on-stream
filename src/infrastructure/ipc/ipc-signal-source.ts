import type { SignalSource } from "../../application/ports/signal-source";
import type { SignalFrame } from "../../domain/signal/index";
import { parseSignalFrame } from "../replay/jsonl-session";

interface SourceWarnings {
  nowMs(): number;
  warn(message: string): void;
}

/** Structural IPC surface lets the source run against Electron or a test fake. */
export interface FrameIpc<Event> {
  on(
    channel: "frame:push",
    listener: (event: Event, frame: unknown) => void,
  ): unknown;
  removeListener(
    channel: "frame:push",
    listener: (event: Event, frame: unknown) => void,
  ): unknown;
}

/** Main-side live source; trust is checked on every delivery, including navigation. */
export class IpcSignalSource<Event> implements SignalSource {
  private readonly subscribers = new Set<
    (frame: SignalFrame, captureGeneration: number) => void
  >();
  private started = false;
  private dropped = 0;
  private lastWarning = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly ipc: FrameIpc<Event>,
    private readonly isTrusted: (event: Event) => boolean,
    private readonly warnings: SourceWarnings = {
      nowMs: () => Date.now(),
      warn: (message) => console.warn(message),
    },
  ) {}

  subscribe(
    onFrame: (frame: SignalFrame, captureGeneration: number) => void,
  ): () => void {
    this.subscribers.add(onFrame);
    return () => this.subscribers.delete(onFrame);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.ipc.on("frame:push", this.receive);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.ipc.removeListener("frame:push", this.receive);
  }

  private readonly receive = (event: Event, value: unknown): void => {
    if (!this.started || !this.isTrusted(event)) return;
    let frame: SignalFrame;
    let captureGeneration: number;
    try {
      if (
        typeof value !== "object" ||
        value === null ||
        Object.keys(value).length !== 2 ||
        !("captureGeneration" in value) ||
        typeof value.captureGeneration !== "number" ||
        !Number.isSafeInteger(value.captureGeneration) ||
        value.captureGeneration < 1 ||
        !("frame" in value)
      )
        throw new Error("Invalid signal transport.");
      captureGeneration = value.captureGeneration;
      frame = parseSignalFrame(value.frame);
    } catch {
      this.dropped++;
      this.warn(
        `Dropped invalid signal frames over IPC (total: ${this.dropped}).`,
      );
      return;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(frame, captureGeneration);
      } catch {
        this.warn("A signal subscriber failed; continuing IPC delivery.");
      }
    }
  };

  private warn(message: string): void {
    try {
      const now = this.warnings.nowMs();
      if (now - this.lastWarning < 5000) return;
      this.lastWarning = now;
      this.warnings.warn(message);
    } catch {
      /* No warning destination may throw into ipcMain. */
    }
  }
}
