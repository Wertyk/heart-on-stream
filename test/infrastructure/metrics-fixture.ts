import { decodeMetrics, Metrics } from "@smartspectra/node-sdk/messages";
import type { SignalFrame } from "../../src/domain/signal/index";

export const fixtureStartUs = 1_794_873_600_000_000;

// Original synthetic window based on the installed generated.d.ts field types.
// The SDK's own encoder/decoder supplies real float32 fields and protobuf Longs.
export function decodedMetricsFixture(): ReturnType<typeof decodeMetrics> {
  const t = fixtureStartUs;
  return decodeMetrics(
    Metrics.encode(
      Metrics.create({
        cardio: {
          pulseRate: [
            { value: 72.5, confidence: 87.5, stable: true, timestamp: t },
            {
              value: 74,
              confidence: 49.5,
              stable: false,
              timestamp: t + 1_000_000,
            },
          ],
          arterialPressureTrace: [
            { value: 0.25, confidence: 90, stable: true, timestamp: t },
            { value: 0.5, confidence: 91, stable: true, timestamp: t + 33_000 },
            {
              value: -0.25,
              confidence: 0,
              stable: false,
              timestamp: t + 66_000,
            },
          ],
        },
        breathing: {
          rate: [
            { value: 14.5, confidence: 80, stable: true, timestamp: t },
            {
              value: 15,
              confidence: 0,
              stable: false,
              timestamp: t + 1_000_000,
            },
          ],
          upperTrace: [
            { value: -0.5, stable: true, timestamp: t },
            { value: 0.25, stable: true, timestamp: t + 33_000 },
            { value: 0.5, stable: false, timestamp: t + 66_000 },
          ],
          lowerTrace: [{ value: 999, stable: true, timestamp: t }],
        },
        face: {
          talking: [
            { detected: false, stable: true, timestamp: t },
            { detected: true, stable: false, timestamp: t + 500_000 },
          ],
          blinking: [{ detected: true, stable: true, timestamp: t }],
        },
      }),
    ).finish(),
  );
}

export function expectedMetricFrames(): SignalFrame[] {
  const t = fixtureStartUs;
  return [
    { kind: "talking", t, detected: false, stable: true },
    {
      kind: "pulseRate",
      reading: { value: 72.5, confidence: 87.5, stable: true, t },
    },
    { kind: "pulseWave", samples: [{ value: 0.25, stable: true, t }] },
    {
      kind: "breathingRate",
      reading: { value: 14.5, confidence: 80, stable: true, t },
    },
    { kind: "breathingWave", samples: [{ value: -0.5, stable: true, t }] },
    {
      kind: "pulseWave",
      samples: [{ value: 0.5, stable: true, t: t + 33_000 }],
    },
    {
      kind: "breathingWave",
      samples: [{ value: 0.25, stable: true, t: t + 33_000 }],
    },
    {
      kind: "pulseWave",
      samples: [{ value: -0.25, stable: false, t: t + 66_000 }],
    },
    {
      kind: "breathingWave",
      samples: [{ value: 0.5, stable: false, t: t + 66_000 }],
    },
    { kind: "talking", t: t + 500_000, detected: true, stable: false },
    {
      kind: "pulseRate",
      reading: { value: 74, confidence: 49.5, stable: false, t: t + 1_000_000 },
    },
    {
      kind: "breathingRate",
      reading: { value: 15, confidence: 0, stable: false, t: t + 1_000_000 },
    },
  ];
}
