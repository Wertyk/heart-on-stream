import {
  normalizeTimestamp,
  type SdkMetrics,
  type SdkTimestamp,
} from "../metrics-mapper";

function timestamped<T extends { readonly timestamp?: SdkTimestamp | null }>(
  samples: readonly T[] | null | undefined,
): T[] {
  return (samples ?? []).filter(
    (sample) =>
      sample.timestamp != null && normalizeTimestamp(sample.timestamp) !== 0,
  );
}

/** Protobuf's absent/zero timestamps cannot place a measurement on the session clock. */
export function timestampedMetrics(metrics: SdkMetrics): SdkMetrics {
  return {
    cardio: {
      pulseRate: timestamped(metrics.cardio?.pulseRate),
      arterialPressureTrace: timestamped(metrics.cardio?.arterialPressureTrace),
    },
    breathing: {
      rate: timestamped(metrics.breathing?.rate),
      upperTrace: timestamped(metrics.breathing?.upperTrace),
    },
    face: { talking: timestamped(metrics.face?.talking) },
  };
}
