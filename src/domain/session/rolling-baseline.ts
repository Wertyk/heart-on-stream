import type { TimestampUs } from "../signal/index";

interface PulseSample {
  readonly t: TimestampUs;
  readonly bpm: number;
}

/** A time-bounded median; the session machine decides which samples qualify. */
export class RollingBaseline {
  private samples: PulseSample[] = [];

  constructor(private readonly windowSeconds: number) {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new RangeError("A median window must have a positive duration");
    }
  }

  add(t: TimestampUs, bpm: number): void {
    this.samples.push({ t, bpm });
  }

  /** The window is (t - duration, t]; a sample expires exactly at its boundary. */
  medianAt(t: TimestampUs): number | null {
    const cutoff = t - this.windowSeconds * 1_000_000;
    const values = this.samples
      .filter((sample) => sample.t > cutoff && sample.t <= t)
      .map((sample) => sample.bpm)
      .sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const upper = values[middle];
    if (upper === undefined) return null;
    return values.length % 2 === 0
      ? ((values[middle - 1] ?? upper) + upper) / 2
      : upper;
  }

  pruneAt(t: TimestampUs): void {
    const cutoff = t - this.windowSeconds * 1_000_000;
    this.samples = this.samples.filter((sample) => sample.t > cutoff);
  }

  /** A period without capture does not age existing baseline samples. */
  shiftBy(durationUs: number): void {
    this.samples = this.samples.map(({ t, bpm }) => ({
      t: t + durationUs,
      bpm,
    }));
  }

  clear(): void {
    this.samples = [];
  }
}
