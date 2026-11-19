import type {
  ProcessingStatus,
  Reading,
  SignalFrame,
  TimestampUs,
  ValidationCode,
  WaveSample,
} from "../../domain/signal/index";

/** Structural subset of decoded SDK messages; Longs stay renderer-safe. */
export type SdkTimestamp = number | bigint | { toNumber(): number };

interface Measurement {
  readonly value?: number | null;
  readonly stable?: boolean | null;
  readonly timestamp?: SdkTimestamp | null;
}

interface MeasurementWithConfidence extends Measurement {
  readonly confidence?: number | null;
}

/** Accepts decodeMetrics output without importing the SDK's native entry point. */
export interface SdkMetrics {
  readonly cardio?: {
    readonly pulseRate?: readonly MeasurementWithConfidence[] | null;
    readonly arterialPressureTrace?:
      | readonly MeasurementWithConfidence[]
      | null;
  } | null;
  readonly breathing?: {
    readonly rate?: readonly MeasurementWithConfidence[] | null;
    readonly upperTrace?: readonly Measurement[] | null;
  } | null;
  readonly face?: {
    readonly talking?:
      | readonly {
          readonly detected?: boolean | null;
          readonly stable?: boolean | null;
          readonly timestamp?: SdkTimestamp | null;
        }[]
      | null;
  } | null;
}

/** Rejects invalid or imprecise times rather than corrupting replay timing. */
export function normalizeTimestamp(timestamp: SdkTimestamp): TimestampUs {
  const value =
    typeof timestamp === "object" ? timestamp.toNumber() : Number(timestamp);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      "SDK timestamp must be a finite, safe integer in microseconds",
    );
  }
  return value;
}

const validationCodes: Readonly<Partial<Record<number, ValidationCode>>> = {
  0: "ok",
  1: "noFaceFound",
  2: "multipleFacesFound",
  3: "faceNotCentered",
  4: "faceSizeOutOfRange",
  5: "tooDark",
  6: "tooBright",
  7: "chestNotVisible",
  10: "cameraTuning",
  11: "frameRateTooLow",
  12: "excessiveMotion",
  13: "faceTooClose",
  14: "faceTooFar",
  15: "faceTooHigh",
  16: "faceTooLow",
  17: "faceNotForward",
};

const processingStatuses: Readonly<Partial<Record<number, ProcessingStatus>>> =
  {
    0: "uninitialized",
    1: "idle",
    2: "starting",
    3: "running",
    4: "stopping",
    5: "error",
  };

/** Unknown SDK conditions are non-OK so new codes cannot imply readiness. */
export function mapValidationCode(code: number): ValidationCode {
  return validationCodes[code] ?? "noFaceFound";
}

/** Unknown SDK lifecycle states cannot imply that measurement is running. */
export function mapProcessingStatus(status: number): ProcessingStatus {
  return processingStatuses[status] ?? "error";
}

/** Preserves the SDK hint verbatim for the streamer's condition checklist. */
export function mapValidationEvent(
  code: number,
  timestamp: SdkTimestamp,
  hint: string,
): SignalFrame {
  return {
    kind: "validation",
    code: mapValidationCode(code),
    t: normalizeTimestamp(timestamp),
    hint,
  };
}

/** The host supplies Clock.now() because processing events have no SDK time. */
export function mapProcessingEvent(
  status: number,
  timestamp: SdkTimestamp,
): SignalFrame {
  return {
    kind: "processing",
    status: mapProcessingStatus(status),
    t: normalizeTimestamp(timestamp),
  };
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("SDK measurement values must be finite");
  }
  return value;
}

function waveSample(measurement: Measurement): WaveSample {
  // Missing protobuf scalars have their protobuf defaults, including epoch zero.
  return {
    value: finite(measurement.value ?? 0),
    stable: measurement.stable ?? false,
    t: normalizeTimestamp(measurement.timestamp ?? 0),
  };
}

function reading(measurement: MeasurementWithConfidence): Reading {
  return {
    ...waveSample(measurement),
    confidence: finite(measurement.confidence ?? 0),
  };
}

/**
 * Emits every measurement in a window, merging channels by timestamp. Ties use
 * channel order: talking, pulse rate, pulse wave, breathing rate, breathing wave.
 * Adjacent waveform samples share a batch; interleaving channels split batches
 * so replay sees the same chronological sequence. No history is accumulated.
 */
export function mapMetrics(metrics: SdkMetrics): SignalFrame[] {
  const events: { t: number; frame: SignalFrame }[] = [];
  for (const detection of metrics.face?.talking ?? []) {
    const t = normalizeTimestamp(detection.timestamp ?? 0);
    events.push({
      t,
      frame: {
        kind: "talking",
        t,
        detected: detection.detected ?? false,
        stable: detection.stable ?? false,
      },
    });
  }
  for (const measurement of metrics.cardio?.pulseRate ?? []) {
    const value = reading(measurement);
    events.push({ t: value.t, frame: { kind: "pulseRate", reading: value } });
  }
  for (const measurement of metrics.cardio?.arterialPressureTrace ?? []) {
    const sample = waveSample(measurement);
    events.push({
      t: sample.t,
      frame: { kind: "pulseWave", samples: [sample] },
    });
  }
  for (const measurement of metrics.breathing?.rate ?? []) {
    const value = reading(measurement);
    events.push({
      t: value.t,
      frame: { kind: "breathingRate", reading: value },
    });
  }
  for (const measurement of metrics.breathing?.upperTrace ?? []) {
    const sample = waveSample(measurement);
    events.push({
      t: sample.t,
      frame: { kind: "breathingWave", samples: [sample] },
    });
  }
  events.sort((a, b) => a.t - b.t);
  const frames: SignalFrame[] = [];
  let waveBatch:
    | { kind: "pulseWave" | "breathingWave"; samples: WaveSample[] }
    | undefined;
  for (const { frame } of events) {
    if (frame.kind === "pulseWave" || frame.kind === "breathingWave") {
      if (waveBatch?.kind === frame.kind) {
        waveBatch.samples.push(...frame.samples);
      } else {
        waveBatch = { kind: frame.kind, samples: [...frame.samples] };
        frames.push(waveBatch);
      }
    } else {
      waveBatch = undefined;
      frames.push(frame);
    }
  }
  return frames;
}
