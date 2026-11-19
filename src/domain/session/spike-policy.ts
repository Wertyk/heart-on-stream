/** All calibration thresholds; durations are measurement seconds, not wall time. */
export interface SpikePolicy {
  readonly confidenceMin: number;
  readonly pulseMinBpm: number;
  readonly pulseMaxBpm: number;
  readonly warmingSeconds: number;
  readonly baseliningSeconds: number;
  readonly baselineWindowSeconds: number;
  readonly shortWindowSeconds: number;
  readonly spikeDeltaBpm: number;
  readonly talkingSpikeDeltaBpm: number;
  readonly talkingRecentSeconds: number;
  readonly sustainSeconds: number;
  readonly cooldownSeconds: number;
  readonly validationPauseSeconds: number;
  /** Wait for the SDK's rolling estimate to shed data from invalid conditions. */
  readonly validationSettleSeconds: number;
  /** Elevated starts at this fraction of the currently applicable spike delta. */
  readonly elevatedDeltaFraction: number;
}

export const DEFAULT_SPIKE_POLICY: Readonly<SpikePolicy> = Object.freeze({
  confidenceMin: 50,
  pulseMinBpm: 40,
  pulseMaxBpm: 110,
  warmingSeconds: 12,
  baseliningSeconds: 25,
  baselineWindowSeconds: 120,
  shortWindowSeconds: 5,
  spikeDeltaBpm: 15,
  talkingSpikeDeltaBpm: 20,
  talkingRecentSeconds: 3,
  sustainSeconds: 3,
  cooldownSeconds: 45,
  validationPauseSeconds: 2,
  validationSettleSeconds: 12,
  elevatedDeltaFraction: 0.5,
});

/** Copy overrides so a caller cannot change the policy during a session. */
export function createSpikePolicy(
  overrides: Partial<SpikePolicy> = {},
): Readonly<SpikePolicy> {
  const policy = { ...DEFAULT_SPIKE_POLICY, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Invalid SpikePolicy.${key}`);
    }
  }
  // Calibration can narrow the SDK's supported range, but cannot widen it.
  if (
    policy.confidenceMin > 100 ||
    policy.pulseMinBpm < DEFAULT_SPIKE_POLICY.pulseMinBpm ||
    policy.pulseMaxBpm > DEFAULT_SPIKE_POLICY.pulseMaxBpm ||
    policy.pulseMinBpm > policy.pulseMaxBpm ||
    policy.baselineWindowSeconds === 0 ||
    policy.shortWindowSeconds === 0 ||
    policy.spikeDeltaBpm === 0 ||
    policy.talkingSpikeDeltaBpm < policy.spikeDeltaBpm ||
    policy.elevatedDeltaFraction === 0 ||
    policy.elevatedDeltaFraction > 1
  ) {
    throw new RangeError("Inconsistent SpikePolicy thresholds");
  }
  return Object.freeze(policy);
}
