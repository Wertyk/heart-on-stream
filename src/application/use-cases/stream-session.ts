import {
  toYouTubeChapters,
  type YouTubeChaptersResult,
} from "../../domain/chapters/index";
import {
  normalizeWave,
  type OverlayWavePoint,
  type PrivacyMode,
  type ProjectionInput,
  projectOverlay,
  type WaveNormalizationState,
} from "../../domain/privacy/index";
import {
  type Highlight,
  SessionMachine,
  type SessionRecord,
  type SpikeEvent,
  type SpikePolicy,
} from "../../domain/session/index";
import type {
  CaptureFrame,
  ProcessingStatus,
  Reading,
  SignalFrame,
  TalkingDetection,
  TimestampUs,
} from "../../domain/signal/index";
import type {
  CapturePauseReason,
  PanelState,
  SessionOperation,
} from "../dto/index";
import type {
  Clock,
  HighlightRepository,
  Logger,
  OverlayPublisher,
  RecordingMarker,
  RecordingToken,
  SessionRecorder,
  SignalSource,
} from "../ports/index";

export interface StreamSessionPorts {
  readonly source: SignalSource;
  readonly publisher: OverlayPublisher;
  readonly marker: RecordingMarker;
  readonly highlights: HighlightRepository;
  readonly recorder: SessionRecorder;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface StreamSessionOptions {
  readonly replay?: boolean;
  readonly policy?: Partial<SpikePolicy>;
}

/** An absent privacy selection is refused; numeric recording needs its own opt-in. */
export interface StartSessionOptions {
  readonly consentRecorded: boolean;
  readonly privacyMode?: PrivacyMode;
  readonly recordingEnabled?: boolean;
}

/** Durations for persisted receipts can be supplied by the caller without an OBS dependency. */
export interface ExportChaptersOptions {
  /** Defaults to this run when it has highlights, or the latest stored session. */
  readonly sessionStartedAt?: TimestampUs;
  readonly recordingDurationMs?: number;
  /** Defaults to elapsed session time only when exporting this service's session. */
  readonly sessionDurationMs?: number;
  readonly introLabel?: string;
}

/** No receipts for the selected session is distinct from too few valid chapters. */
export type ExportChaptersResult =
  | YouTubeChaptersResult
  | { readonly ok: false; readonly reason: "no_highlights" };

export type PanelListener = (state: PanelState) => void;

type SourceRecord = Exclude<SessionRecord, { kind: "drain" }>;

function isTime(t: number): boolean {
  return Number.isSafeInteger(t) && t >= 0;
}

const unusableInputTimeoutUs = 60_000_000;

const sharingLevel: Record<PrivacyMode, number> = {
  off: 0,
  highlightsOnly: 1,
  vibe: 2,
  numbers: 3,
};

interface PendingChapter {
  readonly highlight: Highlight;
  readonly key: string;
  readonly run: readonly Highlight[];
  readonly signal: AbortSignal;
  readonly recording: RecordingToken;
}

/**
 * One live/replay orchestration path. The session queue orders frame processing
 * and recording boundaries. The highlight repository orders disk writes.
 */
export class StreamSession {
  private readonly machine: SessionMachine;
  private readonly replay: boolean;
  private pending: Promise<void> | null = null;
  private readonly listeners = new Set<PanelListener>();
  private readonly errors = new Map<SessionOperation, string>();
  private unsubscribe: (() => void) | null = null;
  private sourceNeedsStop = false;
  private generation = 0;
  private active = false;
  private liveCaptureGeneration = 0;
  private draining = false;
  private drainStartedAt: TimestampUs | null = null;
  private drainedThrough: TimestampUs | null = null;
  // Restrictive requests can change the projection while the queue is busy.
  private readonly sharing: {
    mode: PrivacyMode;
    paused: boolean;
    recordedPauseDelivery: number | null;
    warning: { delivery: number; paused: boolean } | null;
    secondFaceDelivery: number | null;
  } = {
    mode: "off",
    paused: false,
    recordedPauseDelivery: null,
    warning: null,
    secondFaceDelivery: null,
  };
  // The queue owns recording intervals, including history for late SDK batches.
  private secondFaceInterval: {
    start: TimestampUs;
    latestWarning: TimestampUs;
  } | null = null;
  private readonly closedSecondFaceIntervals: {
    start: TimestampUs;
    end: TimestampUs;
  }[] = [];
  private deliverySequence = 0;
  private awaitingCaptureOkSince: TimestampUs | null = null;
  private sharingRevision = 0;
  private modeRevision = 0;
  private pauseRevision = 0;
  private publicationRevision = 0;
  private shareablePulse: ProjectionInput["pulse"] = { kind: "none" };
  private shareableBreathing: number | null = null;
  private shareableSince: TimestampUs | null = null;
  private pauseReason: CapturePauseReason | null = null;
  private unusableInputDeadline: TimestampUs | null = null;
  private captureGapStartedAt: TimestampUs | null = null;
  private finalDurationMs: number | null = null;
  private recording = false;
  private recorderNeedsStop = false;
  private processing: ProcessingStatus = "uninitialized";
  private sdkStarted = false;
  private pulse: Reading | null = null;
  private lastPulseAt: TimestampUs | null = null;
  private breathing: Reading | null = null;
  private talking: TalkingDetection | null = null;
  private runHighlights: Highlight[] = [];
  private readonly pendingChapterWrites = new Map<string, PendingChapter>();
  private chapterCommands = new AbortController();
  private chapterTasks = new Set<Promise<void>>();
  private updatedAt: TimestampUs | null = null;
  private sessionStartUs: TimestampUs | null = null;
  private beatNormalizer: WaveNormalizationState = { history: [] };
  private breathNormalizer: WaveNormalizationState = { history: [] };
  private beatWave: OverlayWavePoint[] = [];
  private unpublishedBeatFromMs: number | null = null;
  private breathWave: OverlayWavePoint[] = [];
  private publishedUntilMs = 0;
  private skipBeatGap = false;

  constructor(
    private readonly ports: StreamSessionPorts,
    options: StreamSessionOptions = {},
  ) {
    this.machine = new SessionMachine(options.policy);
    this.replay = options.replay ?? false;
  }

  /** Detached snapshots are suitable for IPC; subscribers cannot mutate session state. */
  get panelState(): PanelState {
    const snapshot = this.machine.snapshot;
    const replayPaused = this.replay && this.pauseReason !== null;
    const showReadings =
      this.active && this.sharing.secondFaceDelivery === null;
    return {
      active: this.active,
      t: this.updatedAt,
      phase: this.active ? (replayPaused ? "paused" : snapshot.phase) : null,
      progress: this.active ? snapshot.progress : null,
      baselineBpm: this.active ? snapshot.baselineBpm : null,
      intensity: this.active && !replayPaused ? snapshot.intensity : "calm",
      pauseReason: this.pauseReason,
      talkingRecent: showReadings && snapshot.talkingRecent,
      privacyMode: this.sharing.mode,
      replay: this.replay,
      recording: this.recording,
      pulse: showReadings && this.pulse !== null ? { ...this.pulse } : null,
      pulseOutOfRange: showReadings && snapshot.pulse === "out_of_range",
      breathing:
        showReadings && this.breathing !== null ? { ...this.breathing } : null,
      talking:
        showReadings && this.talking !== null ? { ...this.talking } : null,
      validation: this.active ? snapshot.validation : null,
      processing: this.processing,
      sdkStarted: this.sdkStarted,
      highlights: this.currentHighlights,
      errors: [...this.errors].map(([operation, message]) => ({
        operation,
        message,
      })),
    };
  }

  /** Main schedules this deadline even if no further SDK events arrive. */
  get validationDeadlineUs(): TimestampUs | null {
    return this.unusableInputDeadline;
  }

  /** Origin shared by the panel receipt and the stored highlight timestamps. */
  get sessionStartedAt(): TimestampUs | null {
    return this.sessionStartUs;
  }

  /** Assigned at the live capture boundary before accepting that capture's IPC. */
  get captureGeneration(): number {
    return this.liveCaptureGeneration;
  }

  /** The receipt and its export use highlights produced by this run. */
  get currentHighlights(): readonly Highlight[] {
    return this.runHighlights.map((highlight) => ({ ...highlight }));
  }

  /** Preserve session time when End arrives before capture produces another event. */
  get sessionDurationMs(): number {
    if (this.finalDurationMs !== null) return this.finalDurationMs;
    const duration =
      this.captureGapStartedAt === null
        ? this.elapsedMs()
        : this.durationThrough(this.ports.clock.now());
    const origin = this.sessionStartUs ?? this.drainStartedAt;
    return origin === null || this.drainedThrough === null
      ? duration
      : Math.max(duration, (this.drainedThrough - origin) / 1_000);
  }

  /** Immediately sends the current snapshot and then each subsequent publication. */
  subscribePanel(listener: PanelListener): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for commands and source frames already delivered to this service. */
  whenIdle(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  /** Wait for this run's OBS replies so export can use the acknowledged offsets. */
  async settleChapters(): Promise<void> {
    await Promise.all(this.chapterTasks);
  }

  /** Refuses consent/mode omissions before opening either capture or recording. */
  startSession(options: StartSessionOptions): Promise<void> {
    const sharingRevision = this.sharingRevision;
    return this.enqueue(async () => {
      if (options.consentRecorded !== true) {
        throw new Error("Recorded consent is required before starting.");
      }
      if (
        options.privacyMode !== "vibe" &&
        options.privacyMode !== "numbers" &&
        options.privacyMode !== "highlightsOnly"
      ) {
        throw new Error("Select an enabled privacy mode before starting.");
      }
      if (this.active) throw new Error("A session is already running.");
      if (this.sourceNeedsStop) {
        await this.stopSource();
        if (this.sourceNeedsStop) {
          this.emitPanel();
          throw new Error("The previous signal source could not be stopped.");
        }
      }
      if (this.recorderNeedsStop) {
        await this.stopRecorder();
        if (this.recorderNeedsStop) {
          this.emitPanel();
          throw new Error(
            "The previous session recording could not be closed.",
          );
        }
      }
      this.machine.step({ kind: "reset" });
      this.errors.clear();
      if (sharingRevision === this.sharingRevision) {
        this.sharing.mode = options.privacyMode;
        this.sharing.paused = false;
        this.draining = false;
      }
      this.drainStartedAt = null;
      this.drainedThrough = null;
      this.sharing.recordedPauseDelivery = null;
      this.sharing.warning = null;
      this.sharing.secondFaceDelivery = null;
      this.secondFaceInterval = null;
      this.closedSecondFaceIntervals.length = 0;
      this.awaitingCaptureOkSince = null;
      this.shareableSince = null;
      this.clearShareableReadings();
      this.runHighlights = [];
      this.chapterTasks = new Set();
      this.pauseReason = null;
      this.unusableInputDeadline = null;
      this.captureGapStartedAt = null;
      this.finalDurationMs = null;
      this.processing = "starting";
      this.sdkStarted = false;
      this.pulse = null;
      this.lastPulseAt = null;
      this.breathing = null;
      this.talking = null;
      this.sessionStartUs = null;
      this.beatNormalizer = { history: [] };
      this.breathNormalizer = { history: [] };
      this.beatWave = [];
      this.unpublishedBeatFromMs = null;
      this.breathWave = [];
      this.publishedUntilMs = 0;
      this.skipBeatGap = false;
      this.updatedAt = this.ports.clock.now();
      await this.loadHighlights();
      if (options.recordingEnabled === true) {
        this.recorderNeedsStop = true;
        try {
          await this.ports.recorder.start();
          this.recording = true;
        } catch {
          this.report("recordingStart", "Session recording could not start.");
          await this.stopRecorder();
        }
      }
      this.active = true;
      if (!this.replay) this.liveCaptureGeneration++;
      this.sourceNeedsStop = true;
      const generation = ++this.generation;
      try {
        this.unsubscribe = this.ports.source.subscribe(
          (frame, captureGeneration) => {
            void this.queueFrame(frame, generation, captureGeneration).catch(
              () => this.ports.logger.error("Signal frame ingestion failed."),
            );
          },
        );
        await this.ports.source.start();
      } catch {
        this.report("sourceStart", "Signal source could not start.");
        await this.stop();
        this.processing = "error";
        this.emitPanel();
        throw new Error("Signal source could not start.");
      }
      if (this.sharing.mode !== "off") await this.publish(true);
      this.emitPanel();
    });
  }

  /** Direct frame ingestion uses the same path as a subscribed source frame. */
  ingestFrame(frame: SignalFrame): Promise<void> {
    return this.queueFrame(frame);
  }

  /** Off closes recording at the request boundary. End allows SDK shutdown frames. */
  async withdrawSharing(shutdown?: "drain"): Promise<void> {
    if (shutdown === "drain") {
      if (this.draining) return;
      this.draining = true;
      // Queue the boundary before publishing Off can notify listeners.
      if (!this.replay) {
        void this.enqueue(() => {
          if (this.active && this.finalDurationMs === null)
            return this.appendRecording({ kind: "drain" });
        });
      }
      return this.latchOff();
    }
    const publication = this.latchOff();
    const requestedAt = this.ports.clock.now();
    const finalization = this.enqueue(async () => {
      if (!this.active) return;
      this.finalDurationMs ??= this.replay
        ? this.sessionDurationMs
        : this.durationThrough(requestedAt);
      this.unusableInputDeadline = null;
      this.clearShareableReadings();
      this.clearWaves();
      if (this.recording) await this.finishRecording(this.sessionDurationMs);
      this.emitPanel();
    });
    await Promise.all([publication, finalization]);
  }

  private latchOff(): Promise<void> | undefined {
    this.sharingRevision++;
    this.modeRevision++;
    this.pauseRevision++;
    if (this.sharing.mode === "off") return;
    this.sharing.mode = "off";
    this.sharing.paused = true;
    const publication = this.publish();
    this.emitPanel();
    return publication;
  }

  /** Off closes this session; another enabled mode requires fresh start consent. */
  setPrivacyMode(mode: PrivacyMode): Promise<void> {
    if (mode === "off") {
      const withdrawal = this.withdrawSharing();
      return this.enqueue(async () => {
        await this.stop();
        await withdrawal;
      });
    }
    if (mode !== "vibe" && mode !== "numbers" && mode !== "highlightsOnly") {
      return Promise.reject(new Error("Unknown privacy mode."));
    }
    const revision = ++this.modeRevision;
    if (sharingLevel[mode] < sharingLevel[this.sharing.mode]) {
      this.sharing.mode = mode;
      const publication = this.publish().then(() => this.emitPanel());
      return this.enqueue(() => publication);
    }
    return this.enqueue(() => {
      if (revision !== this.modeRevision) return;
      if (!this.active || this.sharing.mode === "off")
        throw new Error("Start a new session to enable capture.");
      this.sharing.mode = mode;
      return this.publishAndEmitPanel();
    });
  }

  /** An explicit Pause cannot cancel a pause the application has already latched. */
  setPaused(paused: boolean): Promise<void> {
    const revision = ++this.pauseRevision;
    const requestedAt = this.ports.clock.now();
    let publication: Promise<void> | undefined;
    if (paused && this.sharing.mode !== "off" && !this.sharing.paused) {
      this.sharing.paused = true;
      // Freeze at the request boundary even if earlier frames are still queued.
      if (this.replay) this.ports.source.pause?.();
      publication = this.publish();
    }
    return this.enqueue(async () => {
      // End keeps the current generation open for the SDK's shutdown frames.
      if (!this.active || this.finalDurationMs !== null || this.draining)
        return;
      const changed = (this.pauseReason !== null) !== paused;
      const boundary = changed
        ? this.setCapturePause(paused ? "manual" : null, requestedAt)
        : undefined;
      const latchChanged =
        revision === this.pauseRevision &&
        this.sharing.mode !== "off" &&
        this.sharing.paused !== paused;
      if (latchChanged) this.sharing.paused = paused;
      if (this.replay && revision === this.pauseRevision) {
        // Start may have been queued at Pause. Resume must follow older frames
        // and respect a newer Pause or End request.
        if (paused) this.ports.source.pause?.();
        else this.ports.source.resume?.();
      }
      if (publication) {
        await publication;
        this.touch();
        this.emitPanel();
      } else if (changed || latchChanged) await this.publishAndEmitPanel();
      if (boundary) await this.appendRecording(boundary);
    });
  }

  private async publishAndEmitPanel(): Promise<void> {
    this.touch();
    if (this.sharing.mode !== "off") await this.publish(true);
    this.emitPanel();
  }

  /** Called by the live host even if the SDK sends no new validation events. */
  checkValidationTimeout(): Promise<void> {
    const checkedAt = this.ports.clock.now();
    return this.enqueue(async () => {
      if (this.draining) return;
      const boundary = this.autoPauseIfDue(checkedAt);
      if (!boundary) return;
      await this.publishAndEmitPanel();
      await this.appendRecording(boundary);
    });
  }

  /** Finalizes optional recording and publishes Off, retaining highlight receipts. */
  stopSession(): Promise<void> {
    const publication = this.latchOff();
    // Unsent chapters stay valid after End: the marker sends them only into the same OBS recording.
    return this.enqueue(async () => {
      await this.stop();
      await publication;
    });
  }

  /**
   * Export one session: the latest with highlights, or an explicit selection.
   * A known OBS duration selects the recording timeline. Otherwise a session
   * timeline is available when at least one receipt has only a session offset.
   */
  async exportChapters(
    options: ExportChaptersOptions = {},
  ): Promise<ExportChaptersResult> {
    if (
      this.chapterTasks.size > 0 &&
      (options.sessionStartedAt === undefined ||
        options.sessionStartedAt === this.sessionStartUs)
    ) {
      const run = this.runHighlights;
      await this.settleChapters();
      if (run !== this.runHighlights)
        return { ok: false, reason: "no_highlights" };
    }
    return this.enqueue(async () => {
      let sessionStartedAt = options.sessionStartedAt;
      if (sessionStartedAt === undefined && this.runHighlights.length > 0)
        sessionStartedAt = this.sessionStartUs ?? undefined;
      let stored: readonly Highlight[] = [];
      if (sessionStartedAt !== this.sessionStartUs) {
        const loaded = await this.loadHighlights();
        if (!loaded) {
          this.emitPanel();
          throw new Error("Highlights could not be loaded for export.");
        }
        stored = loaded;
        if (sessionStartedAt === undefined) {
          for (const highlight of stored) {
            sessionStartedAt = Math.max(
              sessionStartedAt ?? highlight.sessionStartedAt,
              highlight.sessionStartedAt,
            );
          }
        }
      }
      const sessionHighlights =
        sessionStartedAt === this.sessionStartUs
          ? this.currentHighlights
          : stored.filter(
              (highlight) => highlight.sessionStartedAt === sessionStartedAt,
            );
      if (sessionHighlights.length === 0) {
        return { ok: false, reason: "no_highlights" };
      }
      const useRecording =
        options.recordingDurationMs !== undefined ||
        sessionHighlights.every(
          (highlight) => highlight.recordingOffsetMs !== null,
        );
      const highlights = useRecording
        ? sessionHighlights.filter(
            (highlight) => highlight.recordingOffsetMs !== null,
          )
        : sessionHighlights.map((highlight) => ({
            ...highlight,
            recordingOffsetMs: null,
          }));
      const durationMs = useRecording
        ? (options.recordingDurationMs ?? Number.NaN)
        : (options.sessionDurationMs ??
          (sessionStartedAt === this.sessionStartUs
            ? this.sessionDurationMs
            : Number.NaN));
      return toYouTubeChapters(highlights, {
        durationMs,
        ...(options.introLabel === undefined
          ? {}
          : { introLabel: options.introLabel }),
      });
    });
  }

  /** Stop first so pending frames cannot recreate files after the deletion. */
  deleteAllData(): Promise<void> {
    const publication = this.latchOff();
    this.chapterCommands.abort();
    this.chapterCommands = new AbortController();
    this.pendingChapterWrites.clear();
    return this.enqueue(async () => {
      await this.stop();
      await publication;
      let failed = false;
      try {
        await this.ports.highlights.deleteAll();
        this.runHighlights = [];
      } catch {
        failed = true;
        this.report(
          "highlightDelete",
          "Stored highlights could not be deleted.",
        );
      }
      try {
        await this.ports.recorder.deleteAll();
      } catch {
        failed = true;
        this.report(
          "recordingDelete",
          "Session recordings could not be deleted.",
        );
      }
      this.emitPanel();
      if (failed) throw new Error("Some stored data could not be deleted.");
    });
  }

  private enqueue<T>(
    operation: () => T | Promise<T>,
    immediate = false,
  ): Promise<T> {
    let start: (() => void) | undefined;
    const result = immediate
      ? new Promise<T>((resolve, reject) => {
          start = () => {
            try {
              resolve(operation());
            } catch (error) {
              reject(error);
            }
          };
        })
      : this.whenIdle().then(operation);
    const settle = () => {
      if (this.pending === pending) this.pending = null;
    };
    const pending = result.then(settle, settle);
    this.pending = pending;
    // Reserve the queue before a synchronous publication can call back into it.
    start?.();
    return result;
  }

  private queueFrame(
    frame: SessionRecord,
    generation?: number,
    captureGeneration?: number,
  ): Promise<void> {
    const currentSource = () =>
      generation === undefined || generation === this.generation;
    const currentCapture = () =>
      captureGeneration === undefined ||
      captureGeneration === this.liveCaptureGeneration;
    if (!currentSource() || !currentCapture()) return Promise.resolve();
    if (frame.kind === "drain") {
      // Replay End can arrive while earlier frames are still being persisted.
      return this.replay && this.active && this.finalDurationMs === null
        ? this.withdrawSharing("drain")
        : Promise.resolve();
    }
    // Frames delivered before End still run through detection and persistence.
    const draining = this.draining;
    const signal = this.chapterCommands.signal;
    const delivery = ++this.deliverySequence;
    // A queued pulse can confirm a spike after OBS has moved to another file.
    const recording =
      frame.kind === "pulseRate" ? this.ports.marker.captureRecording() : null;
    const restrict =
      this.active &&
      this.finalDurationMs === null &&
      !draining &&
      this.sharing.mode !== "off";
    const warning =
      restrict && frame.kind === "validation" && frame.code !== "ok";
    const secondFace =
      this.active &&
      this.finalDurationMs === null &&
      frame.kind === "validation" &&
      frame.code === "multipleFacesFound" &&
      isTime(frame.t);
    const recordedPause =
      restrict &&
      this.replay &&
      frame.kind === "capture" &&
      frame.state === "paused";
    // An idle replay can publish the queued restriction at delivery in one step.
    const immediate =
      this.replay && (warning || recordedPause) && this.pending === null;
    if (warning) {
      // Only a second face pauses the overlay during the validation grace period.
      this.sharing.warning = {
        delivery,
        paused:
          frame.code === "multipleFacesFound" ||
          this.sharing.warning?.paused === true,
      };
    }
    const hidePanel = secondFace && this.sharing.secondFaceDelivery === null;
    if (secondFace) this.sharing.secondFaceDelivery = delivery;
    if (recordedPause) this.sharing.recordedPauseDelivery = delivery;
    const ingestion = this.enqueue(() => {
      if (!currentSource()) return;
      // Resume may retire a warning's capture after it has latched at delivery.
      if (secondFace && this.active && this.finalDurationMs === null)
        this.openSecondFaceInterval(frame.t);
      if (!currentCapture()) return;
      // Startup can arrive while sharing is paused or End is draining frames.
      if (
        !this.replay &&
        this.active &&
        frame.kind === "processing" &&
        (frame.status === "starting" || frame.status === "running") &&
        isTime(frame.t)
      )
        this.sdkStarted = true;
      return draining && !(this.replay && frame.kind === "end")
        ? this.recordDrainFrame(frame, delivery)
        : this.ingest(frame, signal, delivery, recording);
    }, immediate);
    if (this.replay && frame.kind === "end" && this.active)
      void this.latchOff();
    else if ((warning || recordedPause) && !immediate) void this.publish();
    if (hidePanel) this.emitPanel();
    return ingestion;
  }

  private async ingest(
    sourceFrame: SourceRecord,
    signal: AbortSignal,
    delivery: number,
    recording: RecordingToken,
  ): Promise<void> {
    if (!this.active || this.finalDurationMs !== null) return;
    const frame = this.filterSecondFaceReadings(sourceFrame);
    if (frame === null) return;
    if (frame.kind === "end") {
      this.finalDurationMs = frame.durationUs / 1_000;
      return;
    }
    if (!this.replay && this.pauseReason !== null) return;
    if (this.replay && frame.kind === "capture" && frame.state === "resumed") {
      this.requireCaptureOk(frame.t);
      const pauseDelivery = this.sharing.recordedPauseDelivery;
      if (pauseDelivery !== null && delivery > pauseDelivery)
        this.sharing.recordedPauseDelivery = null;
    }
    const previousValidation =
      frame.kind === "validation"
        ? this.machine.snapshot.validation?.code
        : undefined;
    const { snapshot, events, acceptedPulse } = this.machine.step(frame);
    const spike = events.find((event) => event.kind === "spike");
    let boundary: CaptureFrame | undefined;
    if (
      frame.kind === "validation" &&
      snapshot.validation?.t === frame.t &&
      snapshot.validation.code === frame.code
    ) {
      if (frame.code === "ok") {
        if (!this.replay) this.unusableInputDeadline = null;
        if (frame.t >= (this.awaitingCaptureOkSince ?? 0)) {
          if (this.awaitingCaptureOkSince !== null) {
            this.awaitingCaptureOkSince = null;
            this.advanceShareableSince(frame.t);
          }
          if (this.sharing.warning && delivery > this.sharing.warning.delivery)
            this.sharing.warning = null;
          this.closeSecondFaceInterval(frame.t, delivery);
        }
      } else if (!this.replay) {
        const now = this.ports.clock.now();
        this.unusableInputDeadline ??= now + unusableInputTimeoutUs;
        boundary = this.autoPauseIfDue(now);
      }
    }
    this.sessionStartUs ??= snapshot.startedAt;
    if (
      this.pauseReason === null &&
      this.captureGapStartedAt !== null &&
      snapshot.t !== null &&
      this.updatedAt !== null &&
      snapshot.t > this.updatedAt
    ) {
      this.captureGapStartedAt = null;
    }
    if (
      frame.kind === "pulseRate" &&
      isTime(frame.reading.t) &&
      (this.lastPulseAt === null || frame.reading.t > this.lastPulseAt)
    ) {
      this.lastPulseAt = frame.reading.t;
      // Quality remains visible to the streamer; unsupported rates stay nonnumeric.
      this.pulse =
        Number.isFinite(frame.reading.value) &&
        frame.reading.value >= this.machine.policy.pulseMinBpm &&
        frame.reading.value <= this.machine.policy.pulseMaxBpm
          ? { ...frame.reading }
          : null;
    } else if (
      frame.kind === "breathingRate" &&
      isTime(frame.reading.t) &&
      (this.breathing === null || frame.reading.t >= this.breathing.t)
    ) {
      this.breathing = { ...frame.reading };
    } else if (
      frame.kind === "talking" &&
      isTime(frame.t) &&
      (this.talking === null || frame.t >= this.talking.t)
    ) {
      this.talking = {
        t: frame.t,
        detected: frame.detected,
        stable: frame.stable,
      };
    } else if (frame.kind === "processing" && isTime(frame.t)) {
      this.processing = frame.status;
    }
    const blocked =
      this.signalsWithheld ||
      this.pauseReason !== null ||
      snapshot.phase === "paused" ||
      (snapshot.validation !== null && snapshot.validation.code !== "ok");
    if (blocked) {
      this.advanceShareableSince(snapshot.t);
      this.clearShareableReadings();
      this.clearWaves();
      this.skipBeatGap = true;
    } else {
      if (
        frame.kind === "validation" &&
        snapshot.validation?.code === "ok" &&
        previousValidation !== "ok"
      ) {
        this.advanceShareableSince(snapshot.validation.t);
      }
      for (const event of events) {
        if (event.kind === "phaseChanged" && event.from === "paused")
          this.advanceShareableSince(event.t);
      }
      if (
        this.skipBeatGap &&
        snapshot.t !== null &&
        snapshot.t > (this.updatedAt ?? snapshot.t)
      ) {
        // Never synthesize beats across a pause in live capture or replay.
        this.publishedUntilMs = this.elapsedMs();
        this.skipBeatGap = false;
      }
      if (
        frame.kind === "pulseRate" &&
        frame.reading.t >= (this.shareableSince ?? 0)
      ) {
        if (acceptedPulse !== undefined)
          this.shareablePulse = { kind: "valid", bpm: frame.reading.value };
        else if (
          snapshot.pulse === "out_of_range" &&
          this.lastPulseAt === frame.reading.t &&
          (frame.reading.value < this.machine.policy.pulseMinBpm ||
            frame.reading.value > this.machine.policy.pulseMaxBpm)
        )
          this.shareablePulse = { kind: "outOfRange" };
      } else if (
        frame.kind === "breathingRate" &&
        frame.reading.t >= (this.shareableSince ?? 0) &&
        frame.reading.stable &&
        this.breathing?.t === frame.reading.t
      ) {
        this.shareableBreathing = frame.reading.value;
      }
    }
    if (
      this.sessionStartUs !== null &&
      (frame.kind === "pulseWave" || frame.kind === "breathingWave")
    ) {
      const pulse = frame.kind === "pulseWave";
      const batch = normalizeWave(
        frame.samples,
        { sessionStartUs: this.sessionStartUs },
        pulse ? this.beatNormalizer : this.breathNormalizer,
      );
      if (pulse) this.beatNormalizer = batch.state;
      else this.breathNormalizer = batch.state;
      if (!blocked) {
        if (pulse) {
          this.beatWave.push(...batch.wave);
          const first = batch.wave[0];
          if (first) {
            this.unpublishedBeatFromMs = Math.min(
              this.unpublishedBeatFromMs ?? first.atMs,
              first.atMs,
            );
          }
        } else this.breathWave.push(...batch.wave);
      }
    }
    this.touch();
    if (blocked && this.sharing.mode !== "off") await this.publish(true);
    const chapter = spike && (await this.recordSpike(spike, recording, signal));
    await this.appendRecording(frame);
    if (boundary) await this.appendRecording(boundary);
    if (!blocked && this.sharing.mode !== "off" && !this.sharing.paused)
      await this.publish(true);
    if (chapter) this.trackChapter(chapter);
    this.emitPanel();
  }

  private openSecondFaceInterval(t: TimestampUs): void {
    const interval = this.secondFaceInterval;
    if (interval !== null) {
      interval.start = Math.min(interval.start, t);
      interval.latestWarning = Math.max(interval.latestWarning, t);
      return;
    }
    this.secondFaceInterval = { start: t, latestWarning: t };
    this.pulse = null;
    this.breathing = null;
    this.talking = null;
  }

  private closeSecondFaceInterval(t: TimestampUs, delivery: number): void {
    const interval = this.secondFaceInterval;
    if (interval === null || t < interval.latestWarning) return;
    this.closedSecondFaceIntervals.push({ start: interval.start, end: t });
    this.secondFaceInterval = null;
    const warningDelivery = this.sharing.secondFaceDelivery;
    if (warningDelivery !== null && delivery > warningDelivery)
      this.sharing.secondFaceDelivery = null;
  }

  private filterSecondFaceReadings(frame: SourceRecord): SourceRecord | null {
    const blocked = (t: TimestampUs) =>
      this.secondFaceInterval !== null ||
      this.closedSecondFaceIntervals.some(
        ({ start, end }) => t >= start && t < end,
      );
    switch (frame.kind) {
      case "pulseRate":
      case "breathingRate":
        return blocked(frame.reading.t) ? null : frame;
      case "talking":
        return blocked(frame.t) ? null : frame;
      case "pulseWave":
      case "breathingWave": {
        if (this.secondFaceInterval !== null) return null;
        if (this.closedSecondFaceIntervals.length === 0) return frame;
        const samples = frame.samples.filter(({ t }) => !blocked(t));
        if (samples.length === frame.samples.length) return frame;
        return samples.length === 0 ? null : { ...frame, samples };
      }
      default:
        return frame;
    }
  }

  private async appendRecording(frame: SessionRecord): Promise<void> {
    if (!this.recording) return;
    try {
      await this.ports.recorder.append(frame);
    } catch {
      this.report("recordingAppend", "A signal frame could not be recorded.");
    }
  }

  private async recordDrainFrame(
    frame: SourceRecord,
    delivery: number,
  ): Promise<void> {
    if (!this.active || this.finalDurationMs !== null || frame.kind === "end")
      return;
    // Keep the full shutdown duration even when a reading is discarded.
    if (frame.kind === "pulseWave" || frame.kind === "breathingWave") {
      for (const sample of frame.samples) this.extendDrain(sample.t);
    } else if (frame.kind === "pulseRate" || frame.kind === "breathingRate") {
      this.extendDrain(frame.reading.t);
    } else {
      this.extendDrain(frame.t);
    }
    if (
      frame.kind === "validation" &&
      frame.code === "ok" &&
      frame.t >=
        Math.max(
          this.machine.snapshot.validation?.t ?? 0,
          this.awaitingCaptureOkSince ?? 0,
        )
    )
      this.closeSecondFaceInterval(frame.t, delivery);
    const allowed = this.filterSecondFaceReadings(frame);
    if (allowed !== null) await this.appendRecording(allowed);
  }

  private extendDrain(t: TimestampUs): void {
    if (!isTime(t)) return;
    this.drainStartedAt ??= t;
    this.drainedThrough = Math.max(this.drainedThrough ?? t, t);
  }

  private autoPauseIfDue(now: TimestampUs): CaptureFrame | undefined {
    if (this.unusableInputDeadline === null || now < this.unusableInputDeadline)
      return;
    this.sharing.paused = true;
    return this.setCapturePause("unusableInput", now);
  }

  private setCapturePause(
    reason: CapturePauseReason | null,
    requestedAt: TimestampUs,
  ): CaptureFrame | undefined {
    this.pauseReason = reason;
    this.unusableInputDeadline = null;
    this.clearWaves();
    this.skipBeatGap = true;
    const t = this.machine.snapshot.t;
    this.advanceShareableSince(t);
    this.clearShareableReadings();
    // Manual replay controls preserve the machine's detection windows. Only
    // capture boundaries from the file change its measurement state in replay.
    if (this.replay) return;
    this.processing = reason === null ? "starting" : "idle";
    if (reason !== null && this.sessionStartUs !== null)
      this.captureGapStartedAt ??= requestedAt;
    const boundary: CaptureFrame = {
      kind: "capture",
      state: reason === null ? "resumed" : "paused",
      t: Math.max(t ?? 0, this.captureGapStartedAt ?? 0, requestedAt),
    };
    this.machine.step(boundary);
    if (reason === null) {
      this.liveCaptureGeneration++;
      this.requireCaptureOk(boundary.t);
    }
    return boundary;
  }

  private requireCaptureOk(t: TimestampUs): void {
    this.awaitingCaptureOkSince = t;
    this.advanceShareableSince(t);
  }

  private advanceShareableSince(t: TimestampUs | null): void {
    if (t !== null) this.shareableSince = Math.max(this.shareableSince ?? 0, t);
  }

  private clearShareableReadings(): void {
    this.shareablePulse = { kind: "none" };
    this.shareableBreathing = null;
  }

  private clearWaves(): void {
    this.beatWave = [];
    this.unpublishedBeatFromMs = null;
    this.breathWave = [];
  }

  private async recordSpike(
    event: SpikeEvent,
    recording: RecordingToken,
    signal: AbortSignal,
  ): Promise<PendingChapter> {
    const sessionStartedAt = this.sessionStartUs ?? event.t;
    const highlight: Highlight = {
      t: event.t,
      sessionStartedAt,
      sessionOffsetUs: Math.max(0, event.t - sessionStartedAt),
      recordingOffsetMs: null,
      label: `spike +${Math.round(event.deltaBpm)} vs baseline`,
      deltaBpm: event.deltaBpm,
      talkingRecent: event.talkingRecent,
    };
    const chapter = {
      highlight,
      key: `${sessionStartedAt}:${event.t}`,
      run: this.runHighlights,
      signal,
      recording,
    };
    // A pending append already owns the newest receipt for these timestamps.
    this.pendingChapterWrites.set(chapter.key, chapter);
    try {
      await this.ports.highlights.append(highlight);
    } catch {
      if (this.pendingChapterWrites.get(chapter.key) === chapter)
        this.pendingChapterWrites.delete(chapter.key);
      this.report("highlightAppend", "A highlight could not be saved locally.");
    }
    this.runHighlights.push(highlight);
    return chapter;
  }

  private trackChapter(chapter: PendingChapter): void {
    const tasks = this.chapterTasks;
    const task = this.markChapter(chapter).finally(() => tasks.delete(task));
    tasks.add(task);
  }

  private async markChapter(chapter: PendingChapter): Promise<void> {
    const { highlight, key } = chapter;
    try {
      if (chapter.signal.aborted) return;
      const result = await this.ports.marker.createChapter(
        highlight.label,
        chapter.signal,
        chapter.recording,
      );
      if (chapter.signal.aborted) return;
      if (result.status === "unavailable" && result.reason === "cancelled")
        return;
      if (
        result.status !== "created" ||
        !Number.isFinite(result.recordingOffsetMs) ||
        result.recordingOffsetMs < 0
      ) {
        this.ports.logger.warn(
          "Recording chapter unavailable; keeping local highlight.",
        );
        return;
      }
      const offset = result.recordingOffsetMs;
      const index =
        chapter.run === this.runHighlights
          ? this.runHighlights.indexOf(highlight)
          : -1;
      if (index >= 0)
        this.runHighlights[index] = { ...highlight, recordingOffsetMs: offset };
      // The repository serializes this write with appends and deletion.
      if (this.pendingChapterWrites.get(key) === chapter)
        void this.saveChapterOffset(chapter, offset);
      if (index >= 0) this.emitPanel();
    } catch {
      this.reportChapterError(
        chapter,
        "marker",
        "Recording chapter failed; keeping local highlight.",
      );
    } finally {
      if (this.pendingChapterWrites.get(key) === chapter)
        this.pendingChapterWrites.delete(key);
    }
  }

  private async saveChapterOffset(
    chapter: PendingChapter,
    recordingOffsetMs: number,
  ): Promise<void> {
    try {
      await this.ports.highlights.updateRecordingOffset(
        chapter.highlight,
        recordingOffsetMs,
      );
    } catch {
      this.reportChapterError(
        chapter,
        "highlightUpdate",
        "A recording offset could not be saved locally.",
      );
    }
  }

  private reportChapterError(
    chapter: PendingChapter,
    operation: "marker" | "highlightUpdate",
    message: string,
  ): void {
    if (chapter.signal.aborted || chapter.run !== this.runHighlights) {
      this.ports.logger.error(message);
      return;
    }
    this.report(operation, message);
    this.emitPanel();
  }

  private get signalsWithheld(): boolean {
    return (
      this.sharing.warning !== null || this.awaitingCaptureOkSince !== null
    );
  }

  private projection(): ProjectionInput {
    const snapshot = this.machine.snapshot;
    const paused =
      this.sharing.paused ||
      this.sharing.recordedPauseDelivery !== null ||
      this.sharing.warning?.paused === true ||
      snapshot.phase === "paused";
    const hideSignals = paused || this.signalsWithheld;
    return {
      status: paused
        ? "paused"
        : snapshot.phase === "warming" || snapshot.phase === "baselining"
          ? "calibrating"
          : "live",
      intensity: paused ? "calm" : snapshot.intensity,
      pulse: hideSignals ? { kind: "none" } : this.shareablePulse,
      breathingRate: hideSignals ? null : this.shareableBreathing,
      beatWave: hideSignals ? [] : this.beatWave,
      breathWave: hideSignals ? [] : this.breathWave,
      // Late SDK waves may replace fallback points already sent at these times.
      beatWindow: {
        fromMs: Math.min(
          this.publishedUntilMs,
          this.unpublishedBeatFromMs ?? this.publishedUntilMs,
        ),
        toMs: this.elapsedMs(),
      },
      replay: this.replay,
    };
  }

  private async publish(advanceWave = false): Promise<void> {
    const revision = ++this.publicationRevision;
    const input = this.projection();
    try {
      await this.ports.publisher.publish(
        projectOverlay(input, this.sharing.mode),
      );
      if (!advanceWave || revision !== this.publicationRevision) return;
      this.publishedUntilMs = input.beatWindow.toMs;
      // Retain boundary points to cover adjacent fallback windows without repeats.
      this.beatWave = this.beatWave.filter(
        (point) => point.atMs >= this.publishedUntilMs - 125,
      );
      this.unpublishedBeatFromMs =
        this.beatWave.find((point) => point.atMs >= this.publishedUntilMs)
          ?.atMs ?? null;
      this.breathWave = [];
    } catch {
      this.report("overlayPublish", "Overlay state could not be published.");
    }
  }

  private async stop(): Promise<void> {
    const durationMs = this.active ? this.sessionDurationMs : null;
    if (durationMs !== null) this.finalDurationMs = durationMs;
    this.active = false;
    this.draining = false;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const needsOff =
      this.sharing.mode !== "off" || this.errors.has("overlayPublish");
    this.sharing.mode = "off";
    this.sharing.paused = true;
    this.pauseReason = null;
    this.unusableInputDeadline = null;
    this.captureGapStartedAt = null;
    this.machine.step({ kind: "pause" });
    this.clearShareableReadings();
    this.clearWaves();
    this.touch();
    // Clear cached readings without waiting for capture or file finalization.
    const publication = needsOff ? this.publish() : undefined;
    await this.stopSource();
    await this.finishRecording(
      this.sessionStartUs === null && this.drainStartedAt === null
        ? null
        : durationMs,
    );
    await publication;
    this.emitPanel();
  }

  private async finishRecording(durationMs: number | null): Promise<void> {
    if (durationMs !== null) {
      await this.appendRecording({
        kind: "end",
        durationUs: Math.round(durationMs * 1_000),
      });
    }
    await this.stopRecorder();
  }

  private async stopSource(): Promise<void> {
    if (!this.sourceNeedsStop) return;
    try {
      await this.ports.source.stop();
      this.sourceNeedsStop = false;
      this.processing = "idle";
    } catch {
      this.processing = "error";
      this.report("sourceStop", "Signal source could not stop.");
    }
  }

  private async stopRecorder(): Promise<void> {
    this.recording = false;
    if (!this.recorderNeedsStop) return;
    try {
      await this.ports.recorder.stop();
      this.recorderNeedsStop = false;
    } catch {
      this.report("recordingStop", "Session recording could not be finalized.");
    }
  }

  private async loadHighlights(): Promise<readonly Highlight[] | undefined> {
    try {
      return await this.ports.highlights.list();
    } catch {
      this.report("highlightLoad", "Stored highlights could not be loaded.");
    }
  }

  private elapsedMs(): number {
    const t = this.machine.snapshot.t;
    return t === null || this.sessionStartUs === null
      ? 0
      : Math.max(0, (t - this.sessionStartUs) / 1_000);
  }

  private durationThrough(t: TimestampUs): number {
    return this.sessionStartUs === null
      ? 0
      : Math.max(this.elapsedMs(), (t - this.sessionStartUs) / 1_000);
  }

  private touch(): void {
    this.updatedAt = this.machine.snapshot.t ?? this.ports.clock.now();
  }

  private report(operation: SessionOperation, message: string): void {
    this.errors.set(operation, message);
    this.ports.logger.error(message);
  }

  private notify(listener: PanelListener): void {
    try {
      listener(this.panelState);
    } catch {
      this.ports.logger.error("Panel state listener failed.");
    }
  }

  private emitPanel(): void {
    for (const listener of this.listeners) this.notify(listener);
  }
}
