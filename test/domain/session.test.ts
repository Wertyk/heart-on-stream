import { describe, expect, it } from "vitest";
import {
  createSpikePolicy,
  DEFAULT_SPIKE_POLICY,
  RollingBaseline,
  type SessionEvent,
  SessionMachine,
  type SessionSnapshot,
  type SpikePolicy,
} from "../../src/domain/session/index";
import type {
  Reading,
  SignalFrame,
  ValidationCode,
} from "../../src/domain/signal/index";

// An epoch-sized origin catches accidental seconds/milliseconds conversions.
const EPOCH = 1_800_000_000_000_000;
const at = (seconds: number): number => EPOCH + Math.round(seconds * 1_000_000);

function pulse(
  seconds: number,
  value = 70,
  overrides: Partial<Reading> = {},
): SignalFrame {
  return {
    kind: "pulseRate",
    reading: {
      t: at(seconds),
      value,
      confidence: 50,
      stable: true,
      ...overrides,
    },
  };
}

function validation(seconds: number, code: ValidationCode = "ok"): SignalFrame {
  return { kind: "validation", t: at(seconds), code, hint: `Hint: ${code}` };
}

function talking(seconds: number, detected = true, stable = true): SignalFrame {
  return { kind: "talking", t: at(seconds), detected, stable };
}

function pulses(
  machine: SessionMachine,
  from: number,
  to: number,
  value = 70,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let second = from; second <= to; second++) {
    events.push(...machine.step(pulse(second, value)).events);
  }
  return events;
}

/** Start live quickly while retaining the default spike, cooldown and safety rules. */
function liveMachine(overrides: Partial<SpikePolicy> = {}): SessionMachine {
  const machine = new SessionMachine({
    warmingSeconds: 0,
    baseliningSeconds: 0,
    shortWindowSeconds: 1,
    ...overrides,
  });
  machine.step(pulse(0));
  expect(machine.snapshot.phase).toBe("live");
  return machine;
}

const spikes = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.kind === "spike");

describe("SpikePolicy", () => {
  it("contains every calibrated threshold in one overridable policy", () => {
    expect(DEFAULT_SPIKE_POLICY).toEqual({
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
    const overrides = { spikeDeltaBpm: 8, talkingSpikeDeltaBpm: 12 };
    const policy = createSpikePolicy(overrides);
    overrides.spikeDeltaBpm = 100;
    expect(policy.spikeDeltaBpm).toBe(8);
    expect(policy.talkingSpikeDeltaBpm).toBe(12);
    expect(policy.warmingSeconds).toBe(12);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each<Partial<SpikePolicy>>([
    { confidenceMin: 101 },
    { confidenceMin: -1 },
    { pulseMinBpm: 39 },
    { pulseMaxBpm: 111 },
    { pulseMinBpm: 90, pulseMaxBpm: 80 },
    { baselineWindowSeconds: 0 },
    { shortWindowSeconds: 0 },
    { sustainSeconds: -1 },
    { validationSettleSeconds: -1 },
    { cooldownSeconds: Number.NaN },
    { warmingSeconds: Number.POSITIVE_INFINITY },
    { spikeDeltaBpm: 0 },
    { talkingSpikeDeltaBpm: 9 },
    { elevatedDeltaFraction: 0 },
    { elevatedDeltaFraction: 1.1 },
  ])("rejects unusable thresholds: %j", (overrides) => {
    expect(() => new SessionMachine(overrides)).toThrow(RangeError);
  });
});

describe("rolling baseline", () => {
  it("takes the median, averaging the middle pair for an even sample count", () => {
    const baseline = new RollingBaseline(120);
    expect(baseline.medianAt(at(0))).toBeNull();
    baseline.add(at(0), 70);
    baseline.add(at(1), 110);
    baseline.add(at(2), 60);
    expect(baseline.medianAt(at(2))).toBe(70);
    baseline.add(at(3), 80);
    expect(baseline.medianAt(at(3))).toBe(75);
    expect(baseline.medianAt(at(1))).toBe(90);
  });

  it("expires samples at exactly 120 seconds and prunes without changing the median", () => {
    const baseline = new RollingBaseline(120);
    baseline.add(at(0), 60);
    baseline.add(at(1), 80);
    expect(baseline.medianAt(at(119.999999))).toBe(70);
    expect(baseline.medianAt(at(120))).toBe(80);
    baseline.pruneAt(at(120));
    expect(baseline.medianAt(at(120))).toBe(80);
    expect(baseline.medianAt(at(121))).toBeNull();
    baseline.clear();
    expect(baseline.medianAt(at(1))).toBeNull();
  });
});

describe("session calibration", () => {
  it("exposes warming and baselining progress at the exact default boundaries", () => {
    const machine = new SessionMachine();
    expect(machine.snapshot).toMatchObject({
      phase: "warming",
      startedAt: null,
      t: null,
      pulse: null,
      baselineBpm: null,
      progress: { phase: "warming", elapsedSeconds: 0, requiredSeconds: 12 },
    });
    machine.step(pulse(0));
    machine.step(pulse(7));
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(7);
    expect(machine.snapshot.baselineBpm).toBeNull();
    machine.step(pulse(11.999999));
    expect(machine.snapshot.phase).toBe("warming");
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(11.999999);
    expect(machine.step(pulse(12)).events).toEqual([
      { kind: "phaseChanged", from: "warming", to: "baselining", t: at(12) },
    ]);
    expect(machine.snapshot.progress).toEqual({
      phase: "baselining",
      elapsedSeconds: 0,
      requiredSeconds: 25,
    });
    pulses(machine, 13, 36);
    machine.step(pulse(36.999999));
    expect(machine.snapshot.phase).toBe("baselining");
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(24.999999);
    expect(machine.step(pulse(37)).events).toEqual([
      { kind: "phaseChanged", from: "baselining", to: "live", t: at(37) },
    ]);
    expect(machine.snapshot).toMatchObject({
      phase: "live",
      progress: null,
      baselineBpm: 70,
      startedAt: at(0),
    });
  });

  it("freezes warming progress on manual pause and resumes the remaining time", () => {
    const machine = new SessionMachine();
    machine.step(pulse(0));
    machine.step(pulse(7));
    machine.step({ kind: "pause" });
    machine.step(pulse(100));
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(7);
    machine.step({ kind: "resume" });
    machine.step(pulse(104.999999));
    expect(machine.snapshot.phase).toBe("warming");
    machine.step(pulse(105));
    expect(machine.snapshot.phase).toBe("baselining");
  });

  it("counts only intervals bracketed by valid samples during baselining", () => {
    const machine = new SessionMachine({
      warmingSeconds: 0,
      baseliningSeconds: 4,
    });
    machine.step(pulse(0));
    machine.step(pulse(1));
    machine.step(pulse(2, 90, { stable: false }));
    machine.step(pulse(3));
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(1);
    pulses(machine, 4, 5);
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(3);
    machine.step(pulse(6));
    expect(machine.snapshot.phase).toBe("live");
    expect(machine.snapshot.baselineBpm).toBe(70);
  });

  it("does not count missing pulse windows as baseline collection time", () => {
    const machine = new SessionMachine({
      warmingSeconds: 0,
      baseliningSeconds: 4,
    });
    machine.step(pulse(0));
    machine.step(pulse(1));
    machine.step(pulse(100));
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(1);
    pulses(machine, 101, 103);
    expect(machine.snapshot.phase).toBe("live");
  });

  it("never emits a spike while warming or collecting the initial baseline", () => {
    const machine = new SessionMachine();
    const events = [
      ...pulses(machine, 0, 11, 40),
      ...pulses(machine, 12, 36, 110),
    ];
    expect(spikes(events)).toEqual([]);
    expect(machine.snapshot.phase).toBe("baselining");
    expect(machine.snapshot.intensity).toBe("calm");
    expect(machine.snapshot.baselineBpm).toBe(110);
  });

  it("does not count delayed warming samples toward baselining", () => {
    const machine = new SessionMachine();
    machine.step(pulse(0));
    machine.step({
      kind: "pulseWave",
      samples: [{ t: at(13), value: 0.4, stable: true }],
    });
    machine.step(pulse(8));
    expect(machine.snapshot.phase).toBe("baselining");
    expect(machine.snapshot.baselineBpm).toBeNull();
    machine.step(pulse(12));
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(0);
    machine.step(pulse(13));
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(1);
  });
});

describe("sample eligibility and safe readings", () => {
  it.each([40, 110])(
    "accepts exactly %i BPM at exactly confidence 50",
    (value) => {
      const machine = new SessionMachine({
        warmingSeconds: 0,
        baseliningSeconds: 0,
      });
      machine.step(pulse(0, value));
      expect(machine.snapshot.phase).toBe("live");
      expect(machine.snapshot.pulse).toEqual({
        t: at(0),
        value,
        stable: true,
        confidence: 50,
      });
      expect(machine.snapshot.baselineBpm).toBe(value);
    },
  );

  it.each<Partial<Reading>>([
    { stable: false },
    { confidence: 49.999999 },
    { confidence: Number.NaN },
    { confidence: Number.POSITIVE_INFINITY },
    { confidence: 101 },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
  ])(
    "ignores invalid samples in the baseline, detector and displayed reading: %j",
    (bad) => {
      const machine = liveMachine();
      expect(spikes(pulses(machine, 2, 4, 85))).toEqual([]);
      const previous = machine.snapshot.pulse;
      const result = machine.step(pulse(5, 100, bad));
      expect(result.snapshot.pulse).toEqual(previous);
      expect(result.snapshot.baselineBpm).toBe(70);
      expect(result.snapshot.intensity).toBe("calm");
      expect(spikes(result.events)).toEqual([]);
      expect(spikes(pulses(machine, 6, 8, 85))).toEqual([]);
      expect(spikes(machine.step(pulse(9, 85)).events)).toHaveLength(1);
    },
  );

  it.each([39.999999, 110.000001, 0, -10, 200])(
    "represents %s BPM only as out_of_range and resumes on a valid reading",
    (value) => {
      const machine = liveMachine();
      const result = machine.step(pulse(1, value));
      expect(result.snapshot.phase).toBe("out_of_range");
      expect(result.snapshot.pulse).toBe("out_of_range");
      expect(result.snapshot.baselineBpm).toBe(70);
      expect(result.snapshot.intensity).toBe("calm");
      expect(spikes(result.events)).toEqual([]);
      machine.step(pulse(2, 70, { stable: false }));
      expect(machine.snapshot.pulse).toBe("out_of_range");
      expect(machine.snapshot.phase).toBe("out_of_range");
      machine.step(pulse(3, 75));
      expect(machine.snapshot.phase).toBe("live");
      expect(machine.snapshot.pulse).toMatchObject({ value: 75 });
    },
  );

  it("applies a calibrated confidence minimum and a narrowed supported range", () => {
    const machine = new SessionMachine({
      warmingSeconds: 0,
      baseliningSeconds: 0,
      confidenceMin: 60,
      pulseMinBpm: 60,
      pulseMaxBpm: 100,
    });
    machine.step(pulse(0, 70, { confidence: 59.999999 }));
    expect(machine.snapshot.pulse).toBeNull();
    expect(machine.snapshot.baselineBpm).toBeNull();
    machine.step(pulse(1, 70, { confidence: 60 }));
    expect(machine.snapshot.phase).toBe("live");
    machine.step(pulse(2, 59.999999, { confidence: 60 }));
    expect(machine.snapshot.pulse).toBe("out_of_range");
    machine.step(pulse(3, 60, { confidence: 60 }));
    expect(machine.snapshot.pulse).toMatchObject({ value: 60 });
    machine.step(pulse(4, 100, { confidence: 60 }));
    expect(machine.snapshot.pulse).toMatchObject({ value: 100 });
    machine.step(pulse(5, 100.000001, { confidence: 60 }));
    expect(machine.snapshot.pulse).toBe("out_of_range");
  });
});

describe("measurement interruptions", () => {
  it("honors a calibrated validation grace duration", () => {
    const machine = liveMachine({ validationPauseSeconds: 1 });
    machine.step(validation(0, "tooDark"));
    machine.step(pulse(1));
    expect(machine.snapshot.phase).toBe("live");
    machine.step(pulse(1.000001));
    expect(machine.snapshot.phase).toBe("paused");
  });
  it("pauses only after more than two seconds of non-OK validation", () => {
    const machine = liveMachine();
    machine.step(validation(1, "tooDark"));
    machine.step(pulse(2));
    machine.step(validation(3, "tooBright"));
    expect(machine.snapshot.phase).toBe("live");
    const result = machine.step(pulse(3.000001, 80));
    expect(result.snapshot.phase).toBe("paused");
    expect(result.snapshot.pulse).toMatchObject({ value: 70 });
    expect(result.events).toEqual([
      { kind: "phaseChanged", from: "live", to: "paused", t: at(3.000001) },
    ]);
    expect(machine.step(validation(4)).snapshot.phase).toBe("live");
    expect(machine.snapshot.validation).toEqual({
      t: at(4),
      code: "ok",
      hint: "Hint: ok",
    });
  });

  it("restarts the non-OK grace period after validation recovers", () => {
    const machine = liveMachine();
    machine.step(validation(1, "tooDark"));
    machine.step(validation(2));
    machine.step(validation(3, "noFaceFound"));
    machine.step(pulse(5));
    expect(machine.snapshot.phase).toBe("live");
    machine.step(pulse(5.000001));
    expect(machine.snapshot.phase).toBe("paused");
  });

  it("excludes even high-confidence readings throughout a brief validation failure", () => {
    const machine = liveMachine({ validationSettleSeconds: 0 });
    expect(spikes(pulses(machine, 2, 4, 85))).toEqual([]);
    machine.step(validation(4, "excessiveMotion"));
    const previous = machine.snapshot.pulse;
    for (const input of [pulse(5, 55), pulse(5.5, 111)]) {
      const step = machine.step(input);
      expect(step.acceptedPulse).toBeUndefined();
      expect(step.snapshot).toMatchObject({
        phase: "live",
        baselineBpm: 70,
        pulse: previous,
        intensity: "calm",
      });
    }
    machine.step(validation(6));
    expect(spikes(pulses(machine, 6, 8, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(9, 85)).events)).toHaveLength(1);
  });

  it("settles from the SDK recovery timestamp and ignores repeated OK updates", () => {
    const machine = liveMachine({ shortWindowSeconds: 5 });
    machine.step(validation(5, "excessiveMotion"));
    machine.step({
      kind: "pulseWave",
      samples: [{ t: at(12), value: 0.4, stable: true }],
    });
    machine.step(validation(10));
    machine.step(validation(15));
    expect(machine.step(pulse(21.999999, 55)).acceptedPulse).toBeUndefined();
    expect(machine.snapshot.pulse).toMatchObject({ t: at(0), value: 70 });
    expect(machine.step(pulse(22, 85)).acceptedPulse).toEqual({
      baselineBpm: 70,
      shortBpm: 85,
      thresholdBpm: 15,
      candidateSeconds: 0,
    });
  });

  it("restarts settling after renewed invalidation and clears it on reset", () => {
    const machine = liveMachine();
    machine.step(validation(1, "excessiveMotion"));
    machine.step(validation(4));
    machine.step(validation(5, "tooDark"));
    machine.step(validation(6));
    expect(machine.step(pulse(16, 85)).acceptedPulse).toBeUndefined();
    machine.step({ kind: "reset" });
    expect(machine.step(pulse(0)).acceptedPulse).toBe("calibrating");
    expect(machine.snapshot.phase).toBe("live");
  });

  it("counts neither invalid nor settling readings toward the initial baseline", () => {
    const machine = new SessionMachine({
      warmingSeconds: 0,
      baseliningSeconds: 3,
    });
    pulses(machine, 0, 1);
    machine.step(validation(1, "excessiveMotion"));
    machine.step(pulse(2, 55));
    machine.step(validation(3));
    machine.step(pulse(14, 55));
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(1);
    pulses(machine, 15, 16);
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(2);
    expect(machine.step(pulse(17)).snapshot.phase).toBe("live");
  });

  it("pauses immediately for a second face and recovers only when that condition clears", () => {
    const machine = liveMachine();
    expect(spikes(pulses(machine, 2, 4, 85))).toEqual([]);
    expect(
      machine.step(validation(4, "multipleFacesFound")).snapshot.phase,
    ).toBe("paused");
    expect(spikes(pulses(machine, 5, 6, 85))).toEqual([]);
    expect(machine.step({ kind: "resume" }).snapshot.phase).toBe("paused");
    machine.step(validation(7));
    expect(machine.snapshot.phase).toBe("live");
    expect(spikes(pulses(machine, 7, 21, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(22, 85)).events)).toHaveLength(1);
  });

  it("does not resume a multiple-face pause on another non-OK validation code", () => {
    const machine = liveMachine();
    machine.step(validation(0, "multipleFacesFound"));
    machine.step(validation(1, "tooDark"));
    expect(machine.snapshot.phase).toBe("paused");
    machine.step(validation(2));
    expect(machine.snapshot.phase).toBe("live");
  });

  it("manual pause stays latched through validation recovery until manual resume", () => {
    const machine = liveMachine();
    expect(machine.step({ kind: "pause" }).events).toEqual([
      { kind: "phaseChanged", from: "live", to: "paused", t: at(0) },
    ]);
    expect(machine.step({ kind: "pause" }).events).toEqual([]);
    machine.step(validation(1, "multipleFacesFound"));
    machine.step(validation(2));
    pulses(machine, 3, 10, 90);
    expect(machine.snapshot.phase).toBe("paused");
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(machine.snapshot.pulse).toMatchObject({ value: 70 });
    machine.step({ kind: "resume" });
    expect(machine.snapshot.phase).toBe("live");
    expect(spikes(pulses(machine, 11, 16, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(17, 85)).events)).toHaveLength(1);
  });

  it("breaks sustain even if the next validation frame is already OK", () => {
    const machine = liveMachine({
      shortWindowSeconds: 10,
      validationSettleSeconds: 0,
    });
    expect(spikes(pulses(machine, 1, 3, 85))).toEqual([]);
    machine.step(validation(4, "tooDark"));
    const recovery = machine.step(validation(6.000001));
    expect(recovery.events).toMatchObject([
      { kind: "phaseChanged", to: "paused" },
      { kind: "phaseChanged", to: "live" },
    ]);
    expect(spikes(pulses(machine, 7, 9, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(10, 85)).events)).toHaveLength(1);
  });

  it("caps warming time at the validation grace deadline even across sparse frames", () => {
    const machine = new SessionMachine();
    machine.step(validation(0));
    machine.step(validation(3, "noFaceFound"));
    machine.step(validation(100, "noFaceFound"));
    expect(machine.snapshot.phase).toBe("paused");
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(5);
    machine.step(validation(101));
    machine.step(validation(108));
    expect(machine.snapshot.phase).toBe("baselining");
  });
});

describe("spikes relative to a personal baseline", () => {
  it("requires delta >= 15 and sustain >= 3 seconds, including the exact boundaries", () => {
    const machine = liveMachine();
    pulses(machine, 1, 5);
    expect(spikes(machine.step(pulse(6, 84.999999)).events)).toEqual([]);
    expect(machine.snapshot.intensity).toBe("elevated");
    // A fresh reference avoids the intentionally adaptive median of sub-threshold samples.
    const exact = liveMachine();
    expect(spikes(pulses(exact, 1, 3, 85))).toEqual([]);
    expect(exact.snapshot.intensity).toBe("elevated");
    expect(spikes(exact.step(pulse(3.999999, 85)).events)).toEqual([]);
    expect(spikes(exact.step(pulse(4, 85)).events)).toEqual([
      { kind: "spike", t: at(4), deltaBpm: 15, talkingRecent: false },
    ]);
    expect(exact.snapshot.intensity).toBe("spike");
  });

  it("uses the short-window median rather than a single high reading", () => {
    const machine = liveMachine({ shortWindowSeconds: 5, sustainSeconds: 0 });
    pulses(machine, 1, 5);
    expect(spikes(machine.step(pulse(6, 100)).events)).toEqual([]);
    expect(machine.snapshot.intensity).toBe("calm");
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(spikes(machine.step(pulse(7, 100)).events)).toEqual([]);
    expect(spikes(machine.step(pulse(8, 100)).events)).toEqual([
      { kind: "spike", t: at(8), deltaBpm: 30, talkingRecent: false },
    ]);
  });

  it("keeps the baseline free of leading-edge, sustained and cooldown spike samples", () => {
    const machine = liveMachine({ shortWindowSeconds: 5 });
    pulses(machine, 1, 30);
    const events = pulses(machine, 31, 100, 90);
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(spikes(events)).toEqual([
      { kind: "spike", t: at(36), deltaBpm: 20, talkingRecent: false },
      { kind: "spike", t: at(81), deltaBpm: 20, talkingRecent: false },
    ]);
    pulses(machine, 101, 110);
    expect(machine.snapshot.baselineBpm).toBe(70);
    expect(machine.snapshot.intensity).toBe("calm");
  });

  it("respects the 45-second cooldown, including its exact boundary", () => {
    const machine = liveMachine();
    expect(spikes(pulses(machine, 1, 4, 85))).toEqual([
      { kind: "spike", t: at(4), deltaBpm: 15, talkingRecent: false },
    ]);
    expect(spikes(pulses(machine, 5, 48, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(48.999999, 85)).events)).toEqual([]);
    expect(spikes(machine.step(pulse(49, 85)).events)).toEqual([
      { kind: "spike", t: at(49), deltaBpm: 15, talkingRecent: false },
    ]);
  });

  it("preserves cooldown across manual pause and recovery", () => {
    const machine = liveMachine();
    pulses(machine, 1, 6, 85);
    machine.step({ kind: "pause" });
    machine.step(pulse(7));
    machine.step({ kind: "resume" });
    expect(spikes(pulses(machine, 8, 48, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(49, 85)).events)).toHaveLength(1);
  });

  it("requires a fresh sustained interval after a gap longer than the short window", () => {
    const machine = liveMachine();
    expect(spikes(pulses(machine, 1, 3, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(10, 85)).events)).toEqual([]);
    expect(spikes(pulses(machine, 11, 12, 85))).toEqual([]);
    expect(spikes(machine.step(pulse(13, 85)).events)).toHaveLength(1);
  });

  it("adapts the rolling baseline to non-spike values after the old window expires", () => {
    const machine = liveMachine();
    pulses(machine, 1, 120, 74);
    expect(machine.snapshot.phase).toBe("live");
    expect(machine.snapshot.baselineBpm).toBe(74);
    expect(machine.snapshot.intensity).toBe("calm");
  });

  it("re-baselines if no non-spike reference remains in the rolling window", () => {
    const machine = liveMachine({
      baselineWindowSeconds: 10,
      baseliningSeconds: 0,
    });
    pulses(machine, 1, 9, 90);
    const result = machine.step(pulse(10, 90));
    expect(result.snapshot.phase).toBe("baselining");
    expect(result.snapshot.progress?.elapsedSeconds).toBe(0);
    expect(spikes(result.events)).toEqual([]);
  });

  it("honors calibrated delta, sustain, cooldown and elevated fraction values", () => {
    const machine = liveMachine({
      spikeDeltaBpm: 6,
      talkingSpikeDeltaBpm: 8,
      sustainSeconds: 2,
      cooldownSeconds: 4,
      elevatedDeltaFraction: 0.25,
    });
    expect(spikes(pulses(machine, 1, 2, 76))).toEqual([]);
    expect(spikes(machine.step(pulse(3, 76)).events)).toHaveLength(1);
    expect(spikes(pulses(machine, 4, 6, 76))).toEqual([]);
    expect(spikes(machine.step(pulse(7, 76)).events)).toHaveLength(1);
  });

  it("defines elevated as at least half the applicable spike delta", () => {
    const below = liveMachine();
    below.step(pulse(1, 84.999998));
    // Baseline becomes the median of 70 and 84.999998: delta is 7.499999.
    expect(below.snapshot.intensity).toBe("calm");
    const exact = liveMachine({ baselineWindowSeconds: 120 });
    pulses(exact, 1, 5);
    exact.step(pulse(6, 77.5));
    expect(exact.snapshot.intensity).toBe("elevated");
    const withTalking = liveMachine();
    pulses(withTalking, 1, 5);
    withTalking.step(talking(6));
    withTalking.step(pulse(6, 79.999999));
    expect(withTalking.snapshot.intensity).toBe("calm");
    withTalking.step(pulse(7, 80));
    expect(withTalking.snapshot.intensity).toBe("elevated");
  });
});

describe("talking recency", () => {
  it("uses the higher +20 delta while talking remains recent", () => {
    const machine = liveMachine();
    for (let second = 1; second <= 10; second++) {
      machine.step(talking(second));
      expect(spikes(machine.step(pulse(second, 89.999999)).events)).toEqual([]);
    }
    const exact = liveMachine();
    const events: SessionEvent[] = [];
    for (let second = 1; second <= 4; second++) {
      exact.step(talking(second));
      events.push(...exact.step(pulse(second, 90)).events);
    }
    expect(spikes(events)).toEqual([
      { kind: "spike", t: at(4), deltaBpm: 20, talkingRecent: true },
    ]);
  });

  it("includes exactly the last three seconds and ignores unstable detections", () => {
    const machine = liveMachine();
    machine.step(talking(1));
    machine.step(talking(2, false));
    machine.step(talking(3, true, false));
    machine.step(validation(4));
    expect(machine.snapshot.talkingRecent).toBe(true);
    machine.step(validation(4.000001));
    expect(machine.snapshot.talkingRecent).toBe(false);
  });

  it("cancels an in-flight +15 candidate when recent talking raises the threshold", () => {
    const machine = liveMachine();
    expect(spikes(pulses(machine, 2, 4, 85))).toEqual([]);
    machine.step(talking(4));
    expect(spikes(pulses(machine, 5, 7, 85))).toEqual([]);
    // Talking ceases to be recent after t=7; the lower threshold starts fresh.
    expect(spikes(pulses(machine, 8, 10, 100))).toEqual([]);
    expect(spikes(machine.step(pulse(11, 100)).events)).toHaveLength(1);
  });

  it("honors a calibrated talking recency window", () => {
    const machine = liveMachine({ talkingRecentSeconds: 1 });
    machine.step(talking(1));
    machine.step(validation(2));
    expect(machine.snapshot.talkingRecent).toBe(true);
    machine.step(validation(2.000001));
    expect(machine.snapshot.talkingRecent).toBe(false);
  });

  it("uses pulse time for talking recency when waveform time is newer", () => {
    const machine = liveMachine({ shortWindowSeconds: 5, sustainSeconds: 0 });
    pulses(machine, 1, 5);
    machine.step(talking(6));
    machine.step({
      kind: "pulseWave",
      samples: [{ t: at(10), value: 0.4, stable: true }],
    });
    // The current snapshot is past the talking window; this delayed pulse is not.
    expect(machine.snapshot.talkingRecent).toBe(false);
    expect(spikes(machine.step(pulse(9, 85)).events)).toEqual([]);
  });
});

describe("deterministic session driving", () => {
  it("reset clears timing, baseline, talking, validation, manual pause and cooldown", () => {
    const machine = liveMachine();
    pulses(machine, 1, 6, 85);
    machine.step(talking(6));
    machine.step(validation(6, "multipleFacesFound"));
    machine.step({ kind: "pause" });
    const reset = machine.step({ kind: "reset" });
    expect(reset.snapshot).toEqual(new SessionMachine(machine.policy).snapshot);
    expect(reset.events).toEqual([
      { kind: "phaseChanged", from: "paused", to: "warming", t: at(6) },
    ]);
    machine.step(pulse(0));
    expect(spikes(pulses(machine, 1, 6, 85))).toHaveLength(1);
  });

  it("supports commands before the first frame without inventing a timestamp", () => {
    const machine = new SessionMachine();
    expect(machine.step({ kind: "pause" }).events).toEqual([
      { kind: "phaseChanged", from: "warming", to: "paused", t: null },
    ]);
    expect(machine.step({ kind: "resume" }).snapshot.t).toBeNull();
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(0);
  });

  it("advances from SDK times on every frame variant and ignores empty wave batches", () => {
    const machine = new SessionMachine();
    machine.step({ kind: "processing", t: at(0), status: "running" });
    machine.step({
      kind: "breathingRate",
      reading: { t: at(1), value: 15, stable: true, confidence: 90 },
    });
    machine.step({
      kind: "breathingWave",
      samples: [{ t: at(2), value: 0.2, stable: true }],
    });
    machine.step({
      kind: "pulseWave",
      samples: [{ t: at(3), value: 0.4, stable: true }],
    });
    expect(machine.snapshot.progress?.elapsedSeconds).toBe(3);
    expect(machine.snapshot.pulse).toBeNull();
    machine.step({ kind: "pulseWave", samples: [] });
    expect(machine.snapshot.t).toBe(at(3));
  });

  it("ignores regressive, duplicate pulse and malformed timestamps", () => {
    const machine = liveMachine();
    machine.step(pulse(1));
    machine.step(validation(1));
    const before = machine.snapshot;
    for (const frame of [
      pulse(0.5, 110),
      pulse(1, 110),
      validation(0.5, "multipleFacesFound"),
      pulse(2, 110, { t: Number.NaN }),
      pulse(2, 110, { t: Number.MAX_SAFE_INTEGER + 1 }),
      pulse(2, 110, { t: -1 }),
    ]) {
      expect(machine.step(frame)).toEqual({ snapshot: before, events: [] });
    }
  });

  it("accepts interleaved pulse and validation times without rewinding the session clock", () => {
    const machine = liveMachine({ shortWindowSeconds: 5 });
    machine.step({
      kind: "pulseWave",
      samples: [{ t: at(1.5), value: 0.4, stable: true }],
    });
    machine.step(pulse(1, 72));
    expect(machine.snapshot.t).toBe(at(1.5));
    expect(machine.snapshot.pulse).toMatchObject({ value: 72, t: at(1) });
    machine.step(validation(1, "multipleFacesFound"));
    expect(machine.snapshot.phase).toBe("paused");
    expect(machine.snapshot.validation).toMatchObject({ t: at(1) });
    expect(machine.snapshot.t).toBe(at(1.5));
  });

  it("does not restore pre-resume or stale pulse evidence from delayed batches", () => {
    const machine = liveMachine({ shortWindowSeconds: 5 });
    machine.step({ kind: "pause" });
    machine.step(validation(10));
    machine.step({ kind: "resume" });
    machine.step(pulse(9, 90));
    expect(machine.snapshot.pulse).toMatchObject({ value: 70 });
    machine.step(pulse(10));
    machine.step(validation(30));
    expect(spikes(machine.step(pulse(11, 90)).events)).toEqual([]);
    expect(machine.snapshot.pulse).toMatchObject({ value: 70 });
    expect(machine.snapshot.intensity).toBe("calm");
  });

  it("copies input and snapshot readings so external mutation cannot alter the machine", () => {
    const machine = liveMachine();
    const frame = pulse(1);
    if (frame.kind !== "pulseRate") throw new Error("Expected a pulse frame");
    machine.step(frame);
    Object.assign(frame.reading, { value: 200 });
    const snapshot = machine.snapshot;
    if (snapshot.pulse === null || snapshot.pulse === "out_of_range") {
      throw new Error("Expected a valid pulse");
    }
    Object.assign(snapshot.pulse, { value: 200 });
    expect(machine.snapshot.pulse).toMatchObject({ value: 70 });
  });

  it("replays a longer calm → spike → recovery scenario identically with arbitrary snapshot polling", () => {
    const frames = [
      ...Array.from({ length: 73 }, (_, second) => pulse(second)),
      ...Array.from({ length: 18 }, (_, offset) => pulse(73 + offset, 85)),
      ...Array.from({ length: 90 }, (_, offset) => pulse(91 + offset)),
    ];
    function replay(poll: boolean): {
      events: SessionEvent[];
      snapshot: SessionSnapshot;
    } {
      const machine = new SessionMachine();
      const events: SessionEvent[] = [];
      for (const frame of frames) {
        if (poll) {
          void machine.snapshot;
          void machine.snapshot;
        }
        events.push(...machine.step(frame).events);
      }
      return { events, snapshot: machine.snapshot };
    }
    const result = replay(false);
    expect(replay(true)).toEqual(result);
    expect(spikes(result.events)).toEqual([
      { kind: "spike", t: at(78), deltaBpm: 15, talkingRecent: false },
    ]);
    expect(
      result.events.filter((event) => event.kind === "phaseChanged"),
    ).toEqual([
      { kind: "phaseChanged", from: "warming", to: "baselining", t: at(12) },
      { kind: "phaseChanged", from: "baselining", to: "live", t: at(37) },
    ]);
    expect(result.snapshot).toMatchObject({
      phase: "live",
      baselineBpm: 70,
      intensity: "calm",
      talkingRecent: false,
    });
  });
});
