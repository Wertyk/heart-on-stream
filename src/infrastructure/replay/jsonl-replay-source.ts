import { readFileSync } from "node:fs";
import type { SignalSource } from "../../application/ports/signal-source";
import { SessionMachine, type SessionRecord } from "../../domain/session/index";
import { decodeJsonlSession } from "./jsonl-session";
import { playbackTimeline } from "./playback-timeline";

/** Supplies monotonic time and deferred, cancellable callbacks on the same clock. */
export interface ReplayScheduler {
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface ReplayOptions {
  readonly speed?: number;
  readonly scheduler?: ReplayScheduler;
  readonly onEnd?: () => void;
}

const maxTimeoutMs = 2 ** 31 - 1;

const timeoutScheduler: ReplayScheduler = {
  nowMs: () => performance.now(),
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

function timedRecords(records: readonly SessionRecord[], speed: number) {
  const { frames, drainOrigin } = playbackTimeline(records);
  const origin =
    frames.map(timestamp).find((t) => t !== null) ?? drainOrigin ?? 0;
  const measurementOffsetUs =
    frames.at(-1)?.kind === "end"
      ? (measurementOrigin(frames) ?? drainOrigin ?? origin) - origin
      : 0;
  let delayMs = 0;
  return frames.map((frame) => {
    // An untimed drain boundary follows the preceding record without advancing playback.
    // Late or empty batches also stay in file order without moving playback backwards.
    const offsetUs =
      frame.kind === "end"
        ? measurementOffsetUs + frame.durationUs
        : (timestamp(frame) ?? origin) - origin;
    delayMs = Math.max(delayMs, offsetUs / 1_000 / speed);
    return { frame, delayMs };
  });
}

interface Playback {
  nextIndex: number;
  elapsedMs: number;
}

interface PlaybackTimers {
  readonly startedAtMs: number;
  readonly cancellations: Map<number, () => void>;
}

/** File order and original timestamps survive replay, including late wave batches. */
export class JsonlReplaySource implements SignalSource {
  private readonly timeline: ReturnType<typeof timedRecords>;
  private readonly scheduler: ReplayScheduler;
  private readonly listeners = new Set<(frame: SessionRecord) => void>();
  private playback: Playback | null = null;
  private timers: PlaybackTimers | null = null;

  constructor(
    filePath: string,
    private readonly options: ReplayOptions = {},
  ) {
    const speed = options.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 20)
      throw new Error("Replay speed must be between 0.25 and 20.");
    let input: string;
    try {
      input = readFileSync(filePath, "utf8");
    } catch {
      throw new Error(
        "Unable to read replay file. Check the path and file permissions.",
      );
    }
    this.timeline = timedRecords(decodeJsonlSession(input).frames, speed);
    this.scheduler = options.scheduler ?? timeoutScheduler;
  }

  subscribe(listener: (frame: SessionRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.playback !== null) return;
    this.playback = { nextIndex: 0, elapsedMs: 0 };
    this.resume();
  }

  pause(): void {
    if (this.playback === null || this.timers === null) return;
    this.playback.elapsedMs += this.scheduler.nowMs() - this.timers.startedAtMs;
    this.cancelTimers();
  }

  resume(): void {
    const playback = this.playback;
    if (playback === null || this.timers !== null) return;
    const timers: PlaybackTimers = {
      startedAtMs: this.scheduler.nowMs(),
      cancellations: new Map(),
    };
    this.timers = timers;
    const endDelayMs = this.timeline.at(-1)?.delayMs ?? 0;
    const originMs = timers.startedAtMs - playback.elapsedMs;
    // Completion has its own timer at the last record's deadline.
    for (
      let index = playback.nextIndex;
      index <= this.timeline.length;
      index++
    ) {
      const delayMs = this.timeline[index]?.delayMs ?? endDelayMs;
      const remainingMs = Math.max(
        0,
        originMs + delayMs - this.scheduler.nowMs(),
      );
      const cancel = this.scheduler.schedule(() => {
        timers.cancellations.delete(index);
        this.deliverThrough(playback, timers, index);
      }, remainingMs);
      timers.cancellations.set(index, cancel);
    }
  }

  private deliverThrough(
    playback: Playback,
    timers: PlaybackTimers,
    index: number,
  ): void {
    // Timers that become due together can fire in either order.
    while (this.timers === timers && playback.nextIndex <= index) {
      const record = this.timeline[playback.nextIndex++];
      if (record === undefined) {
        this.playback = null;
        this.cancelTimers();
        this.options.onEnd?.();
        return;
      }
      for (const listener of this.listeners) {
        // Pause finishes delivering the current record. Stop abandons the run.
        if (this.playback !== playback) break;
        try {
          listener(record.frame);
        } catch {
          /* Isolate consumers of the source. */
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.playback = null;
    this.cancelTimers();
  }

  private cancelTimers(): void {
    const timers = this.timers;
    this.timers = null;
    if (timers === null) return;
    for (const cancel of timers.cancellations.values()) cancel();
    timers.cancellations.clear();
  }
}
