export const pulseWindowUs = 120_000_000;

export interface PulsePoint {
  readonly t: number;
  readonly value: number;
}

/** Stores distinct readings for the current run and rejects data retained across a pause. */
export class PulseHistory {
  private readonly points: PulsePoint[] = [];
  private hiddenThrough = -Infinity;

  get samples(): readonly PulsePoint[] {
    return this.points;
  }

  reset(): void {
    this.points.length = 0;
    this.hiddenThrough = -Infinity;
  }

  update<T extends PulsePoint>(
    now: number | null,
    pulse: T | null,
    hidden: boolean,
  ): T | null {
    if (hidden) {
      this.hiddenThrough = Math.max(
        this.hiddenThrough,
        now ?? -Infinity,
        pulse?.t ?? -Infinity,
        this.points.at(-1)?.t ?? -Infinity,
      );
      this.points.length = 0;
      return null;
    }

    if (pulse && pulse.t <= this.hiddenThrough) pulse = null;
    const end = Math.max(now ?? -Infinity, pulse?.t ?? -Infinity);
    const since = end - pulseWindowUs;
    const first = this.points[0];
    if (first && first.t < since) {
      const keep = this.points.findIndex((point) => point.t >= since);
      this.points.splice(0, keep === -1 ? this.points.length : keep);
    }
    if (
      pulse &&
      pulse.t >= since &&
      pulse.t > (this.points.at(-1)?.t ?? -Infinity)
    )
      this.points.push({ t: pulse.t, value: pulse.value });
    return pulse;
  }
}
