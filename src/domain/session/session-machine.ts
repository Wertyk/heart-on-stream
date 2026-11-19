import type {
  Reading,
  SessionFrame,
  TimestampUs,
  ValidationState,
} from "../signal/index";
import type { SessionPhase } from "./index";
import { RollingBaseline } from "./rolling-baseline";
import {
  type SessionIntensity,
  SpikeDetector,
  type SpikeEvent,
} from "./spike-detector";
import { createSpikePolicy, type SpikePolicy } from "./spike-policy";

type CalibrationPhase = "warming" | "baselining" | "live";

/** Progress survives interruptions; only eligible measurement time counts. */
export interface CalibrationProgress {
  readonly phase: "warming" | "baselining";
  readonly elapsedSeconds: number;
  readonly requiredSeconds: number;
}

/** Streamer-only state: privacy projection must select overlay-safe fields. */
export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly progress: CalibrationProgress | null;
  /** Origin for session-relative timestamps, including the start of a first wave batch. */
  readonly startedAt: TimestampUs | null;
  readonly t: TimestampUs | null;
  /** Latest valid reading, or a sentinel that never carries an unsupported BPM. */
  readonly pulse: Reading | "out_of_range" | null;
  readonly baselineBpm: number | null;
  readonly intensity: SessionIntensity;
  readonly talkingRecent: boolean;
  readonly validation: ValidationState | null;
}

export type SessionEvent =
  | SpikeEvent
  | {
      readonly kind: "phaseChanged";
      readonly from: SessionPhase;
      readonly to: SessionPhase;
      /** Null only for commands issued before the first measurement. */
      readonly t: TimestampUs | null;
    };

/** Commands use the latest measurement time; reset starts a fresh session. */
export type SessionInput =
  | SessionFrame
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "reset" };

/** Evidence at the pulse timestamp, before the reading can update the baseline. */
export interface PulseComparison {
  readonly baselineBpm: number;
  readonly shortBpm: number;
  readonly thresholdBpm: number;
  readonly candidateSeconds: number;
}

export interface SessionStep {
  readonly snapshot: SessionSnapshot;
  readonly events: readonly SessionEvent[];
  /** Present on usable pulse frames, with a comparison once detection runs. */
  readonly acceptedPulse?: "calibrating" | PulseComparison;
}

function frameTime(frame: SessionFrame): TimestampUs | undefined {
  switch (frame.kind) {
    case "pulseRate":
    case "breathingRate":
      return frame.reading.t;
    case "pulseWave":
    case "breathingWave":
      return frame.samples.at(-1)?.t;
    default:
      return frame.t;
  }
}

function firstMeasurementTime(
  frame: SessionFrame,
  frameEnd: TimestampUs,
): TimestampUs {
  let start = frameEnd;
  if (frame.kind === "pulseWave" || frame.kind === "breathingWave") {
    for (const { t } of frame.samples) {
      if (Number.isSafeInteger(t) && t >= 0) start = Math.min(start, t);
    }
  }
  return start;
}

/**
 * Deterministic, I/O-free session engine. Each signal stream must be ordered;
 * streams may interleave. Time never rewinds, and regressive frames within a
 * stream or duplicate pulse timestamps are ignored. Empty waves advance no time.
 */
export class SessionMachine {
  readonly policy: Readonly<SpikePolicy>;
  private baseline: RollingBaseline;
  private shortWindow: RollingBaseline;
  private detector: SpikeDetector;
  private calibration: CalibrationPhase = "warming";
  private phase: SessionPhase = "warming";
  private warmingUs = 0;
  private baseliningUs = 0;
  private startedAt: TimestampUs | null = null;
  private t: TimestampUs | null = null;
  private pulse: Reading | "out_of_range" | null = null;
  private validation: ValidationState | null = null;
  private invalidSince: TimestampUs | null = null;
  private validationPaused = false;
  private validationRecoveryUntil: TimestampUs | null = null;
  private lastTalkingAt: TimestampUs | null = null;
  private lastPulseAt: TimestampUs | null = null;
  private baselineSampleAt: TimestampUs | null = null;
  private manualPause = false;
  private captureResumedAt: TimestampUs | null = null;
  private captureSuspended = false;
  private readonly frameTimes = new Map<SessionFrame["kind"], TimestampUs>();
  private pulseEligibleSince: TimestampUs | null = null;

  constructor(overrides: Partial<SpikePolicy> = {}) {
    this.policy = createSpikePolicy(overrides);
    this.baseline = new RollingBaseline(this.policy.baselineWindowSeconds);
    this.shortWindow = new RollingBaseline(this.policy.shortWindowSeconds);
    this.detector = new SpikeDetector(this.policy);
  }

  get snapshot(): SessionSnapshot {
    const baselineBpm = this.t === null ? null : this.baseline.medianAt(this.t);
    const shortBpm = this.t === null ? null : this.shortWindow.medianAt(this.t);
    const talkingRecent = this.talkingRecent();
    const delta =
      baselineBpm === null || shortBpm === null ? null : shortBpm - baselineBpm;
    return {
      phase: this.phase,
      progress:
        this.calibration === "live"
          ? null
          : {
              phase: this.calibration,
              elapsedSeconds:
                (this.calibration === "warming"
                  ? this.warmingUs
                  : this.baseliningUs) / 1_000_000,
              requiredSeconds:
                this.calibration === "warming"
                  ? this.policy.warmingSeconds
                  : this.policy.baseliningSeconds,
            },
      startedAt: this.startedAt,
      t: this.t,
      pulse:
        this.pulse === null || this.pulse === "out_of_range"
          ? this.pulse
          : { ...this.pulse },
      baselineBpm,
      intensity:
        this.phase === "live"
          ? this.detector.intensity(delta, talkingRecent)
          : "calm",
      talkingRecent,
      validation: this.validation === null ? null : { ...this.validation },
    };
  }

  step(input: SessionInput): SessionStep {
    const events: SessionEvent[] = [];
    if (input.kind === "reset") {
      const oldTime = this.t;
      this.calibration = "warming";
      this.warmingUs = 0;
      this.baseliningUs = 0;
      this.startedAt = null;
      this.t = null;
      this.pulse = null;
      this.validation = null;
      this.invalidSince = null;
      this.validationPaused = false;
      this.validationRecoveryUntil = null;
      this.lastTalkingAt = null;
      this.lastPulseAt = null;
      this.baselineSampleAt = null;
      this.manualPause = false;
      this.captureResumedAt = null;
      this.captureSuspended = false;
      this.frameTimes.clear();
      this.baseline.clear();
      this.shortWindow.clear();
      this.detector = new SpikeDetector(this.policy);
      this.changePhase("warming", events, oldTime);
      this.pulseEligibleSince = null;
    } else if (input.kind === "pause" || input.kind === "resume") {
      this.manualPause = input.kind === "pause";
      this.refreshPhase(events);
    } else {
      const t = frameTime(input);
      const previousStreamTime = this.frameTimes.get(input.kind);
      if (
        t === undefined ||
        !Number.isSafeInteger(t) ||
        t < 0 ||
        (previousStreamTime !== undefined && t < previousStreamTime) ||
        (input.kind === "pulseRate" && t === this.lastPulseAt)
      ) {
        return { snapshot: this.snapshot, events };
      }
      if (input.kind === "capture") {
        // Freeze measurement time until fresh input so the baseline survives the gap.
        this.frameTimes.set(input.kind, t);
        if (input.state === "paused") this.captureSuspended = true;
        else if (this.captureSuspended) {
          this.captureSuspended = false;
          this.captureResumedAt = t;
        }
        this.refreshPhase(events, t);
        return { snapshot: this.snapshot, events };
      }
      if (
        this.captureSuspended ||
        (this.captureResumedAt !== null && t < this.captureResumedAt)
      )
        return { snapshot: this.snapshot, events };
      this.frameTimes.set(input.kind, t);
      this.startedAt ??= firstMeasurementTime(input, t);
      this.advance(Math.max(this.t ?? t, t));
      // Observe an elapsed validation timeout before a recovery at this time.
      this.refreshPhase(events);
      if (input.kind === "validation") {
        this.validation = { t, code: input.code, hint: input.hint };
        if (input.code === "ok") {
          if (this.invalidSince !== null) {
            this.validationRecoveryUntil =
              t + this.policy.validationSettleSeconds * 1_000_000;
          }
          this.invalidSince = null;
          this.validationPaused = false;
        } else {
          this.invalidSince ??= t;
          this.interrupt();
        }
      } else if (input.kind === "talking" && input.stable && input.detected) {
        this.lastTalkingAt = t;
      }
      this.refreshPhase(events);
      if (input.kind !== "pulseRate") {
        const baseline = this.baseline.medianAt(this.t ?? t);
        const short = this.shortWindow.medianAt(this.t ?? t);
        if (baseline !== null && short !== null) {
          this.detector.reconcile(short - baseline, this.talkingRecent());
        }
      }
      if (input.kind === "pulseRate") {
        this.lastPulseAt = t;
        const acceptedPulse = this.ingestPulse(input.reading, events);
        if (acceptedPulse !== undefined) {
          return { snapshot: this.snapshot, events, acceptedPulse };
        }
      }
    }
    return { snapshot: this.snapshot, events };
  }

  private talkingRecent(t = this.t): boolean {
    return (
      t !== null &&
      this.lastTalkingAt !== null &&
      t - this.lastTalkingAt <= this.policy.talkingRecentSeconds * 1_000_000
    );
  }

  private advance(t: TimestampUs): void {
    let previousTime = this.t ?? t;
    if (this.captureResumedAt !== null) {
      this.baseline.shiftBy(t - previousTime);
      this.pulseEligibleSince = t;
      previousTime = t;
      this.captureResumedAt = null;
    }
    let warmingEndAt = t;
    if (this.calibration === "warming" && this.phase === "warming") {
      warmingEndAt =
        previousTime + this.policy.warmingSeconds * 1_000_000 - this.warmingUs;
      const end =
        this.invalidSince === null
          ? t
          : Math.min(
              t,
              this.invalidSince +
                this.policy.validationPauseSeconds * 1_000_000,
            );
      this.warmingUs = Math.min(
        this.policy.warmingSeconds * 1_000_000,
        this.warmingUs + Math.max(0, end - previousTime),
      );
    }
    this.t = t;
    this.baseline.pruneAt(t);
    this.shortWindow.pruneAt(t);
    // A gap longer than the short window cannot establish continuous evidence.
    if (
      this.lastPulseAt !== null &&
      t - this.lastPulseAt > this.policy.shortWindowSeconds * 1_000_000
    ) {
      this.interrupt();
    }
    if (
      this.calibration === "warming" &&
      this.warmingUs >= this.policy.warmingSeconds * 1_000_000
    ) {
      this.calibration = "baselining";
      this.pulseEligibleSince = warmingEndAt;
    }
  }

  private blocked(): boolean {
    return (
      this.manualPause || this.captureSuspended || this.validationBlocked()
    );
  }

  private validationBlocked(): boolean {
    return (
      this.validationPaused ||
      this.validation?.code === "multipleFacesFound" ||
      (this.invalidSince !== null &&
        this.t !== null &&
        this.t - this.invalidSince >
          this.policy.validationPauseSeconds * 1_000_000)
    );
  }

  private refreshPhase(events: SessionEvent[], t = this.t): void {
    // Once validation has paused measurement, require OK before resuming.
    this.validationPaused = this.validationBlocked();
    this.changePhase(
      this.blocked()
        ? "paused"
        : this.pulse === "out_of_range"
          ? "out_of_range"
          : this.calibration,
      events,
      t,
    );
    if (this.phase === "paused" || this.phase === "out_of_range") {
      this.interrupt();
    }
  }

  private changePhase(
    to: SessionPhase,
    events: SessionEvent[],
    t = this.t,
  ): void {
    if (to === this.phase) return;
    if (this.phase === "paused" || this.phase === "out_of_range") {
      this.pulseEligibleSince = t;
    }
    events.push({ kind: "phaseChanged", from: this.phase, to, t });
    this.phase = to;
  }

  private interrupt(): void {
    this.baselineSampleAt = null;
    this.shortWindow.clear();
    this.detector.interrupt();
  }

  private ingestPulse(
    reading: Reading,
    events: SessionEvent[],
  ): SessionStep["acceptedPulse"] {
    if (
      this.invalidSince !== null ||
      (this.validationRecoveryUntil !== null &&
        reading.t < this.validationRecoveryUntil)
    ) {
      return;
    }
    if (
      Number.isFinite(reading.value) &&
      (reading.value < this.policy.pulseMinBpm ||
        reading.value > this.policy.pulseMaxBpm)
    ) {
      this.pulse = "out_of_range";
      this.refreshPhase(events);
      return;
    }
    if (
      !reading.stable ||
      !Number.isFinite(reading.value) ||
      !Number.isFinite(reading.confidence) ||
      reading.confidence < this.policy.confidenceMin ||
      reading.confidence > 100
    ) {
      this.interrupt();
      return;
    }
    if (this.blocked()) return;
    // Late batches can update quality, but cannot restore pre-resume evidence or
    // confirm a rise after their entire short window has already elapsed.
    if (
      (this.pulseEligibleSince !== null &&
        reading.t < this.pulseEligibleSince) ||
      (this.t !== null &&
        this.t - reading.t > this.policy.shortWindowSeconds * 1_000_000)
    ) {
      this.interrupt();
      return;
    }
    this.pulse = { ...reading };
    this.refreshPhase(events);
    if (this.calibration === "warming") return "calibrating";

    const t = reading.t;
    const baseline = this.baseline.medianAt(t);
    this.shortWindow.add(t, reading.value);
    const short = this.shortWindow.medianAt(t) ?? reading.value;
    // Use the reading's time for recency even when a wave advanced the clock.
    // A known newer talking detection conservatively keeps the higher delta.
    const talkingRecent = this.talkingRecent(t);
    if (this.calibration === "baselining") {
      this.baseline.add(t, reading.value);
      if (this.baselineSampleAt !== null) {
        this.baseliningUs = Math.min(
          this.policy.baseliningSeconds * 1_000_000,
          this.baseliningUs + t - this.baselineSampleAt,
        );
      }
      this.baselineSampleAt = t;
      if (this.baseliningUs >= this.policy.baseliningSeconds * 1_000_000) {
        this.calibration = "live";
        this.refreshPhase(events);
      }
      return "calibrating";
    }
    if (baseline === null) {
      // No reference remains in the rolling window: calibrate honestly again.
      this.calibration = "baselining";
      this.baseliningUs = 0;
      this.baselineSampleAt = t;
      this.baseline.add(t, reading.value);
      this.detector.interrupt();
      this.refreshPhase(events);
      return "calibrating";
    }
    const delta = short - baseline;
    const threshold = this.detector.threshold(talkingRecent);
    // Exclude tentative rises too, including their leading edge and cooldown.
    // Otherwise a long rise would gradually become its own baseline.
    if (reading.value - baseline < threshold && delta < threshold) {
      this.baseline.add(t, reading.value);
    }
    const spike = this.detector.observe(t, delta, talkingRecent);
    if (spike !== null) events.push(spike);
    return {
      baselineBpm: baseline,
      shortBpm: short,
      thresholdBpm: threshold,
      candidateSeconds: this.detector.candidateDurationUs(t) / 1_000_000,
    };
  }
}
