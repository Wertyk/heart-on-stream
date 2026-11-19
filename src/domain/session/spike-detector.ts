import type { TimestampUs } from "../signal/index";
import type { SpikePolicy } from "./spike-policy";

/** Relative activity for an overlay, independent of numeric readings. */
export type SessionIntensity = "calm" | "elevated" | "spike";

/** A receipt input; labels and recording positions belong to the application. */
export interface SpikeEvent {
  readonly kind: "spike";
  readonly t: TimestampUs;
  readonly deltaBpm: number;
  readonly talkingRecent: boolean;
}

/** Tracks sustained relative rises; every observation supplies measurement time. */
export class SpikeDetector {
  private candidateSince: TimestampUs | null = null;
  private lastSpikeAt: TimestampUs | null = null;
  private sustained = false;

  constructor(private readonly policy: Readonly<SpikePolicy>) {}

  threshold(talkingRecent: boolean): number {
    return talkingRecent
      ? this.policy.talkingSpikeDeltaBpm
      : this.policy.spikeDeltaBpm;
  }

  /** Invalid samples and interruptions break sustain, but preserve cooldown. */
  interrupt(): void {
    this.candidateSince = null;
    this.sustained = false;
  }

  /** Metadata can cancel a candidate, but cannot confirm a spike without a pulse. */
  reconcile(deltaBpm: number, talkingRecent: boolean): void {
    if (deltaBpm < this.threshold(talkingRecent)) this.interrupt();
  }

  /** Elapsed time supported by the current run of above-threshold observations. */
  candidateDurationUs(t: TimestampUs): number {
    return this.candidateSince === null ? 0 : t - this.candidateSince;
  }

  intensity(deltaBpm: number | null, talkingRecent: boolean): SessionIntensity {
    const threshold = this.threshold(talkingRecent);
    if (deltaBpm === null) return "calm";
    if (this.sustained && deltaBpm >= threshold) return "spike";
    return deltaBpm >= threshold * this.policy.elevatedDeltaFraction
      ? "elevated"
      : "calm";
  }

  observe(
    t: TimestampUs,
    deltaBpm: number,
    talkingRecent: boolean,
  ): SpikeEvent | null {
    if (deltaBpm < this.threshold(talkingRecent)) {
      this.interrupt();
      return null;
    }
    this.candidateSince ??= t;
    this.sustained =
      this.candidateDurationUs(t) >= this.policy.sustainSeconds * 1_000_000;
    if (
      !this.sustained ||
      (this.lastSpikeAt !== null &&
        t - this.lastSpikeAt < this.policy.cooldownSeconds * 1_000_000)
    ) {
      return null;
    }
    this.lastSpikeAt = t;
    return { kind: "spike", t, deltaBpm, talkingRecent };
  }
}
