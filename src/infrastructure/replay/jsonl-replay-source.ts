import { readFileSync } from "node:fs";
import type { SignalSource } from "../../application/ports/signal-source";
import { SessionMachine, type SessionRecord } from "../../domain/session/index";
import { decodeJsonlSession } from "./jsonl-session";
import { playbackTimeline } from "./playback-timeline";

/** Cancellation is explicit so replay needs no real clock in tests. */
export interface ReplayScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ReplayOptions {
  readonly speed?: number;
  readonly scheduler?: ReplayScheduler;
  readonly onEnd?: () => void;
}

const maxTimeoutMs = 2 ** 31 - 1;

const timeoutScheduler: ReplayScheduler = {
  schedule(callback, delayMs) {
    let remainingMs = delayMs;
    let timer: ReturnType<typeof setTimeout>;
    function scheduleChunk(): void {
      const chunkMs = Math.min(remainingMs, maxTimeoutMs);
      remainingMs -= chunkMs;
      timer = setTimeout(remainingMs > 0 ? scheduleChunk : callback, chunkMs);
    }
    scheduleChunk();
    return () => clearTimeout(timer);
  },
};

function timestamp(frame: SessionRecord): number | null {
  switch (frame.kind) {
    case "pulseRate":
    case "breathingRate":
      return frame.reading.t;
    case "pulseWave":
    case "breathingWave":
      return frame.samples.at(-1)?.t ?? null;
    case "drain":
    case "end":
      return null;
    default:
      return frame.t;
  }
}

function measurementOrigin(frames: readonly SessionRecord[]): number | null {
  // A leading capture pause can make the machine skip SDK frames before Resume.
  const machine = new SessionMachine();
  for (const frame of frames) {
    if (frame.kind === "drain" || frame.kind === "end") break;
    const { startedAt } = machine.step(frame).snapshot;
    if (startedAt !== null) return startedAt;
  }
  return null;
}

/** File order and original timestamps survive replay, including late wave batches. */
export class JsonlReplaySource implements SignalSource {
  private readonly timeline: ReturnType<typeof playbackTimeline>;
  private readonly speed: number;
  private readonly scheduler: ReplayScheduler;
  private readonly listeners = new Set<(frame: SessionRecord) => void>();
  private cancellations: (() => void)[] = [];
  private generation = 0;
  private running = false;

  constructor(
    filePath: string,
    private readonly options: ReplayOptions = {},
  ) {
    this.speed = options.speed ?? 1;
    if (!Number.isFinite(this.speed) || this.speed < 0.25 || this.speed > 20)
      throw new Error("Replay speed must be between 0.25 and 20.");
    let input: string;
    try {
      input = readFileSync(filePath, "utf8");
    } catch {
      throw new Error(
        "Unable to read replay file. Check the path and file permissions.",
      );
    }
    this.timeline = playbackTimeline(decodeJsonlSession(input).frames);
    this.scheduler = options.scheduler ?? timeoutScheduler;
  }

  subscribe(listener: (frame: SessionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const { frames, drainOrigin } = this.timeline;
    const origin =
      frames.map(timestamp).find((t) => t !== null) ?? drainOrigin ?? 0;
    const footer = frames.at(-1);
    const measurementOffsetUs =
      footer?.kind === "end"
        ? (measurementOrigin(frames) ?? drainOrigin ?? origin) - origin
        : 0;
    let delayMs = 0;
    for (const frame of frames) {
      // An untimed drain boundary follows the preceding record without advancing playback.
      // Late or empty batches also stay in file order without moving playback backwards.
      const offsetUs =
        frame.kind === "end"
          ? measurementOffsetUs + frame.durationUs
          : (timestamp(frame) ?? origin) - origin;
      delayMs = Math.max(delayMs, offsetUs / 1000 / this.speed);
      this.cancellations.push(
        this.scheduler.schedule(() => {
          if (!this.running || generation !== this.generation) return;
          for (const listener of this.listeners) {
            if (!this.running || generation !== this.generation) break;
            try {
              listener(frame);
            } catch {
              /* Isolate consumers of the source. */
            }
          }
        }, delayMs),
      );
    }
    this.cancellations.push(
      this.scheduler.schedule(() => {
        if (!this.running || generation !== this.generation) return;
        this.running = false;
        this.cancellations = [];
        this.options.onEnd?.();
      }, delayMs),
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    for (const cancel of this.cancellations) cancel();
    this.cancellations = [];
  }
}
