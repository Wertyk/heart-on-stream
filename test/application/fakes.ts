import type { PanelState } from "../../src/application/dto/index";
import type { HighlightIdentity } from "../../src/application/ports/highlight-repository";
import type {
  Clock,
  HighlightRepository,
  Logger,
  OverlayPublisher,
  RecordingMarker,
  RecordingMarkerResult,
  RecordingToken,
  SessionRecorder,
  SignalSource,
} from "../../src/application/ports/index";
import {
  StreamSession,
  type StreamSessionOptions,
} from "../../src/application/use-cases/index";
import type { OverlayState } from "../../src/domain/privacy/index";
import type { Highlight, SessionRecord } from "../../src/domain/session/index";
import type { Reading, SignalFrame } from "../../src/domain/signal/index";

export const EPOCH = 1_800_000_000_000_000;
export const at = (seconds: number): number => EPOCH + seconds * 1_000_000;

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

export function pulse(
  seconds: number,
  value = 70,
  overrides: Partial<Reading> = {},
): SignalFrame {
  return {
    kind: "pulseRate",
    reading: {
      t: at(seconds),
      value,
      confidence: 90,
      stable: true,
      ...overrides,
    },
  };
}

export function wave(
  kind: "pulseWave" | "breathingWave",
  points: readonly [seconds: number, value: number][],
): SignalFrame {
  return {
    kind,
    samples: points.map(([seconds, value]) => ({
      t: at(seconds),
      value,
      stable: true,
    })),
  };
}

export function highlight(
  seconds: number,
  recordingOffsetMs: number | null = null,
  sessionStartedAt = EPOCH,
): Highlight {
  return {
    t: sessionStartedAt + seconds * 1_000_000,
    sessionStartedAt,
    sessionOffsetUs: seconds * 1_000_000,
    recordingOffsetMs,
    label: `spike at ${seconds}`,
    deltaBpm: 12,
    talkingRecent: false,
  };
}

type SourceListener = Parameters<SignalSource["subscribe"]>[0];

export class MemorySource implements SignalSource {
  readonly listeners = new Set<SourceListener>();
  readonly oldListeners: SourceListener[] = [];
  failStart = false;
  failStop = false;
  onStart: (() => void) | null = null;
  starts = 0;
  stops = 0;

  constructor(private readonly calls: string[]) {}

  subscribe(listener: SourceListener): () => void {
    this.calls.push("source.subscribe");
    this.listeners.add(listener);
    this.oldListeners.push(listener);
    return () => {
      this.calls.push("source.unsubscribe");
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    this.calls.push("source.start");
    this.starts++;
    this.onStart?.();
    if (this.failStart) throw new Error("Source start failure");
  }

  async stop(): Promise<void> {
    this.calls.push("source.stop");
    this.stops++;
    if (this.failStop) throw new Error("Source stop failure");
  }

  emit(frame: SignalFrame, captureGeneration?: number): void {
    for (const listener of this.listeners) listener(frame, captureGeneration);
  }
}

export class MemoryPublisher implements OverlayPublisher {
  readonly states: OverlayState[] = [];
  readonly attempts: OverlayState[] = [];
  private readonly viewers = new Set<(state: OverlayState) => void>();
  fail = false;

  /** Like the overlay server, a newly connected viewer receives the cached latest state. */
  connect(viewer: (state: OverlayState) => void): void {
    this.viewers.add(viewer);
    const latest = this.states.at(-1);
    if (latest) viewer(latest);
  }

  async publish(state: OverlayState): Promise<void> {
    this.attempts.push(state);
    if (this.fail) throw new Error("Publication failure");
    this.states.push(state);
    for (const viewer of this.viewers) viewer(state);
  }
}

export class MemoryMarker implements RecordingMarker {
  readonly labels: string[] = [];
  readonly results: (RecordingMarkerResult | Error)[] = [];
  gate: Promise<void> | null = null;

  captureRecording(): RecordingToken {
    return null;
  }

  async createChapter(label: string): Promise<RecordingMarkerResult> {
    this.labels.push(label);
    await this.gate;
    const result = this.results.shift() ?? {
      status: "created",
      recordingOffsetMs: 20_000,
    };
    if (result instanceof Error) throw result;
    return result;
  }
}

export class MemoryHighlights implements HighlightRepository {
  items: Highlight[] = [];
  failAppend = false;
  failList = false;
  failDelete = false;
  lists = 0;
  deletes = 0;

  async append(item: Highlight): Promise<void> {
    if (this.failAppend) throw new Error("Append failure");
    this.items.push({ ...item });
  }

  async updateRecordingOffset(
    { sessionStartedAt, t }: HighlightIdentity,
    recordingOffsetMs: number,
  ): Promise<boolean> {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (item?.sessionStartedAt !== sessionStartedAt || item.t !== t) continue;
      if (item.recordingOffsetMs !== null) return false;
      this.items[index] = { ...item, recordingOffsetMs };
      return true;
    }
    return false;
  }

  async list(): Promise<readonly Highlight[]> {
    this.lists++;
    if (this.failList) throw new Error("List failure");
    return this.items.map((item) => ({ ...item }));
  }

  async deleteAll(): Promise<void> {
    this.deletes++;
    if (this.failDelete) throw new Error("Delete failure");
    this.items = [];
  }
}

export class MemoryRecorder implements SessionRecorder {
  files: SessionRecord[][] = [];
  private current: SessionRecord[] | null = null;
  failStart = false;
  failAppend = false;
  failStop = false;
  failDelete = false;
  starts = 0;
  stops = 0;
  appends = 0;
  deletes = 0;

  constructor(private readonly calls: string[]) {}

  async start(): Promise<void> {
    this.calls.push("recorder.start");
    this.starts++;
    if (this.failStart) throw new Error("Recording start failure");
    this.current = [];
    this.files.push(this.current);
  }

  async append(frame: SessionRecord): Promise<void> {
    this.appends++;
    if (this.failAppend) throw new Error("Recording append failure");
    if (this.current === null) throw new Error("Recording was not started");
    this.current.push(frame);
  }

  async stop(): Promise<void> {
    this.calls.push("recorder.stop");
    this.stops++;
    if (this.failStop) throw new Error("Recording stop failure");
    this.current = null;
  }

  async deleteAll(): Promise<void> {
    this.deletes++;
    if (this.failDelete) throw new Error("Recording delete failure");
    this.files = [];
    this.current = null;
  }
}

export class MemoryClock implements Clock {
  value = at(-10_000);
  reads = 0;

  now(): number {
    this.reads++;
    return this.value;
  }
}

export class MemoryLogger implements Logger {
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

export function fixture(options: StreamSessionOptions = {}) {
  const calls: string[] = [];
  const source = new MemorySource(calls);
  const publisher = new MemoryPublisher();
  const marker = new MemoryMarker();
  const highlights = new MemoryHighlights();
  const recorder = new MemoryRecorder(calls);
  const clock = new MemoryClock();
  const logger = new MemoryLogger();
  const session = new StreamSession(
    { source, publisher, marker, highlights, recorder, clock, logger },
    options,
  );
  const panels: PanelState[] = [];
  session.subscribePanel((state) => panels.push(state));
  return {
    session,
    source,
    publisher,
    marker,
    highlights,
    recorder,
    clock,
    logger,
    calls,
    panels,
  };
}

export const quickPolicy = {
  warmingSeconds: 0,
  baseliningSeconds: 0,
  shortWindowSeconds: 1,
  spikeDeltaBpm: 10,
  talkingSpikeDeltaBpm: 15,
  sustainSeconds: 1,
  cooldownSeconds: 5,
};

export async function pulses(
  session: StreamSession,
  from: number,
  to: number,
  value = 70,
): Promise<void> {
  for (let second = from; second <= to; second++) {
    await session.ingestFrame(pulse(second, value));
  }
}
