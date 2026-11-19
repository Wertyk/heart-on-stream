import { decodeMetrics, Metrics } from "@smartspectra/node-sdk/messages";
import { describe, expect, it } from "vitest";
import { SessionMachine } from "../../src/domain/session/index";
import {
  mapMetrics,
  mapProcessingEvent,
  mapProcessingStatus,
  mapValidationCode,
  mapValidationEvent,
  normalizeTimestamp,
  type SdkMetrics,
} from "../../src/infrastructure/smartspectra/metrics-mapper";
import {
  decodedMetricsFixture,
  expectedMetricFrames,
  fixtureStartUs,
} from "./metrics-fixture";

describe("SDK metrics mapper", () => {
  it("maps every measurement in a real encoded/decoded SDK window, in chronological order", () => {
    const metrics = decodedMetricsFixture();
    expect(typeof metrics.cardio?.pulseRate?.[0]?.timestamp).toBe("object");
    expect(mapMetrics(metrics)).toEqual(expectedMetricFrames());
    // The same slice is pure and contains no accumulated state.
    expect(mapMetrics(metrics)).toEqual(expectedMetricFrames());
  });

  it("keeps adjacent waveform samples in order and does not retain SDK confidence on waves", () => {
    expect(
      mapMetrics({
        cardio: {
          arterialPressureTrace: [
            { value: 0.25, stable: true, confidence: 88, timestamp: 1n },
            { value: -0.5, stable: false, confidence: 0, timestamp: 2 },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "pulseWave",
        samples: [
          { value: 0.25, stable: true, t: 1 },
          { value: -0.5, stable: false, t: 2 },
        ],
      },
    ]);
  });

  it.each([
    { stable: true, spikeCount: 0 },
    { stable: false, spikeCount: 1 },
  ])(
    "applies the talking threshold to the confirming pulse when talking stability is $stable",
    ({ stable, spikeCount }) => {
      const machine = new SessionMachine({
        warmingSeconds: 0,
        baseliningSeconds: 0,
        shortWindowSeconds: 1,
      });
      const pulse = (second: number, value: number) => ({
        timestamp: fixtureStartUs + second * 1_000_000,
        value,
        confidence: 80,
        stable: true,
      });
      const confirmingPulse = pulse(9, 87);
      const frames = mapMetrics({
        cardio: {
          pulseRate: [
            ...Array.from({ length: 6 }, (_, second) => pulse(second, 70)),
            ...Array.from({ length: 3 }, (_, second) => pulse(second + 6, 87)),
            confirmingPulse,
          ],
        },
        face: {
          talking: [
            { timestamp: confirmingPulse.timestamp, detected: true, stable },
          ],
        },
      });
      const spikes = frames
        .flatMap((frame) => machine.step(frame).events)
        .filter((event) => event.kind === "spike");
      expect(machine.snapshot.phase).toBe("live");
      expect(machine.snapshot.talkingRecent).toBe(stable);
      expect(spikes).toHaveLength(spikeCount);
      if (!stable)
        expect(spikes[0]).toMatchObject({
          t: confirmingPulse.timestamp,
          deltaBpm: 17,
        });
    },
  );

  it.each<SdkMetrics>([
    {},
    { cardio: {}, breathing: {}, face: {} },
    { cardio: null, breathing: null, face: null },
    {
      cardio: { pulseRate: [], arterialPressureTrace: [] },
      breathing: { rate: [], upperTrace: [] },
      face: { talking: [] },
    },
    {
      cardio: { pulseRate: null, arterialPressureTrace: null },
      breathing: { rate: null, upperTrace: null },
      face: { talking: null },
    },
    decodeMetrics(Metrics.encode({}).finish()),
  ])("returns no frames for missing or empty arrays: %j", (metrics) => {
    expect(mapMetrics(metrics)).toEqual([]);
  });

  it("honors protobuf defaults when scalars are omitted", () => {
    expect(
      mapMetrics(
        decodeMetrics(
          Metrics.encode({
            cardio: { pulseRate: [{}], arterialPressureTrace: [{}] },
            breathing: { rate: [{}], upperTrace: [{}] },
            face: { talking: [{}] },
          }).finish(),
        ),
      ),
    ).toEqual([
      { kind: "talking", detected: false, stable: false, t: 0 },
      {
        kind: "pulseRate",
        reading: { value: 0, confidence: 0, stable: false, t: 0 },
      },
      { kind: "pulseWave", samples: [{ value: 0, stable: false, t: 0 }] },
      {
        kind: "breathingRate",
        reading: { value: 0, confidence: 0, stable: false, t: 0 },
      },
      { kind: "breathingWave", samples: [{ value: 0, stable: false, t: 0 }] },
    ]);
  });

  it("rejects nonfinite measurement values, confidence and timestamps", () => {
    expect(() =>
      mapMetrics({ cardio: { pulseRate: [{ value: Number.NaN }] } }),
    ).toThrow("finite");
    expect(() =>
      mapMetrics({
        breathing: { rate: [{ confidence: Number.POSITIVE_INFINITY }] },
      }),
    ).toThrow("finite");
    expect(() =>
      mapMetrics({ face: { talking: [{ timestamp: Number.NaN }] } }),
    ).toThrow("timestamp");
  });
});

describe("SDK timestamp normalization", () => {
  it("normalizes numbers, bigints and real protobuf Longs to identical epoch microseconds", () => {
    const timestamp = decodedMetricsFixture().cardio?.pulseRate?.[0]?.timestamp;
    if (timestamp == null) throw new Error("Fixture timestamp missing");
    expect(normalizeTimestamp(fixtureStartUs)).toBe(fixtureStartUs);
    expect(normalizeTimestamp(BigInt(fixtureStartUs))).toBe(fixtureStartUs);
    expect(normalizeTimestamp(timestamp)).toBe(fixtureStartUs);
    const longLike = {
      low: 123,
      high: 456,
      unsigned: false,
      toNumber: () => fixtureStartUs,
    };
    expect(normalizeTimestamp(longLike)).toBe(fixtureStartUs);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    9_007_199_254_740_993n,
    { toNumber: () => Number.NaN },
    { toNumber: () => Number.POSITIVE_INFINITY },
  ])("rejects invalid or imprecise timestamps (case %#)", (timestamp) => {
    expect(() => normalizeTimestamp(timestamp)).toThrow("finite, safe integer");
  });
});

describe("SDK status events", () => {
  it.each([
    [0, "ok"],
    [1, "noFaceFound"],
    [2, "multipleFacesFound"],
    [3, "faceNotCentered"],
    [4, "faceSizeOutOfRange"],
    [5, "tooDark"],
    [6, "tooBright"],
    [7, "chestNotVisible"],
    [10, "cameraTuning"],
    [11, "frameRateTooLow"],
    [12, "excessiveMotion"],
    [13, "faceTooClose"],
    [14, "faceTooFar"],
    [15, "faceTooHigh"],
    [16, "faceTooLow"],
    [17, "faceNotForward"],
  ] as const)("maps validation %s to %s", (code, expected) => {
    expect(mapValidationCode(code)).toBe(expected);
  });

  it.each([
    [0, "uninitialized"],
    [1, "idle"],
    [2, "starting"],
    [3, "running"],
    [4, "stopping"],
    [5, "error"],
  ] as const)("maps processing %s to %s", (code, expected) => {
    expect(mapProcessingStatus(code)).toBe(expected);
  });

  it.each([-1, 8, 9, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "maps unknown status codes %s to conservative domain states",
    (code) => {
      expect(mapValidationCode(code)).toBe("noFaceFound");
      expect(mapProcessingStatus(code)).toBe("error");
    },
  );

  it("preserves validation hints verbatim and takes explicit processing time", () => {
    const hint = "  Move into even light.\nKeep your face centered.  ";
    expect(mapValidationEvent(5, BigInt(fixtureStartUs), hint)).toEqual({
      kind: "validation",
      code: "tooDark",
      t: fixtureStartUs,
      hint,
    });
    expect(mapProcessingEvent(3, fixtureStartUs)).toEqual({
      kind: "processing",
      status: "running",
      t: fixtureStartUs,
    });
    expect(mapValidationEvent(99, fixtureStartUs, hint)).toEqual({
      kind: "validation",
      code: "noFaceFound",
      t: fixtureStartUs,
      hint,
    });
    expect(mapProcessingEvent(99, fixtureStartUs)).toEqual({
      kind: "processing",
      status: "error",
      t: fixtureStartUs,
    });
    expect(() => mapProcessingEvent(3, Number.NaN)).toThrow("timestamp");
    expect(() => mapValidationEvent(0, Number.POSITIVE_INFINITY, "")).toThrow(
      "timestamp",
    );
  });
});
