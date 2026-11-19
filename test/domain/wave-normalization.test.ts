import { describe, expect, it } from "vitest";
import { normalizeWave } from "../../src/domain/privacy/index";
import type { WaveSample } from "../../src/domain/signal/index";

const startUs = 1_800_000_000_000_000;
const options = { sessionStartUs: startUs, windowUs: 1_000_000 };

function sample(value: number, offsetUs = 0): WaveSample {
  return Object.freeze({ value, t: startUs + offsetUs, stable: true });
}

describe("wave normalization", () => {
  it("returns empty animation and history for an empty first batch", () => {
    expect(normalizeWave([], options)).toEqual({
      wave: [],
      state: { history: [] },
    });
  });

  it("centers a single sample without dividing by zero", () => {
    expect(normalizeWave([sample(42)], options).wave).toEqual([
      { v: 0.5, atMs: 0 },
    ]);
  });

  it("centers flat signals, including across batches", () => {
    const first = normalizeWave([sample(-7)], options);
    const next = normalizeWave(
      [sample(-7, 1_000), sample(-7, 2_000)],
      options,
      first.state,
    );
    expect(next.wave).toEqual([
      { v: 0.5, atMs: 1 },
      { v: 0.5, atMs: 2 },
    ]);
  });

  it("maps arbitrary amplitude to 0..1 and epoch microseconds to elapsed ms", () => {
    const result = normalizeWave(
      [sample(-10), sample(10, 1_000), sample(0, 2_000), sample(-10, 2_500)],
      options,
    );
    expect(result.wave).toEqual([
      { v: 0.5, atMs: 0 },
      { v: 1, atMs: 1 },
      { v: 0.5, atMs: 2 },
      { v: 0, atMs: 2.5 },
    ]);
    for (const point of result.wave) {
      expect(Object.keys(point).sort()).toEqual(["atMs", "v"]);
    }
  });

  it("expires extrema from the rolling window and keeps its exact boundary", () => {
    const first = normalizeWave([sample(0), sample(10, 500_000)], options);
    const boundary = normalizeWave(
      [sample(5, 1_000_000)],
      options,
      first.state,
    );
    expect(boundary.wave).toEqual([{ v: 0.5, atMs: 1_000 }]);
    const later = normalizeWave(
      [sample(100, 2_000_001)],
      options,
      boundary.state,
    );
    expect(later.wave).toEqual([{ v: 0.5, atMs: 2_000.001 }]);
    expect(later.state.history).toEqual([sample(100, 2_000_001)]);
  });

  it("is identical across batch splits and never mutates samples or prior state", () => {
    const samples = Object.freeze([
      sample(4),
      sample(8, 300_000),
      sample(2, 800_000),
      sample(9, 1_500_000),
    ]);
    const first = normalizeWave(samples.slice(0, 2), options);
    Object.freeze(first.state.history);
    Object.freeze(first.state);
    const second = normalizeWave(samples.slice(2), options, first.state);
    expect([...first.wave, ...second.wave]).toEqual(
      normalizeWave(samples, options).wave,
    );
    expect(second.state).toEqual(normalizeWave(samples, options).state);
    expect(first.state.history).toEqual(samples.slice(0, 2));
  });

  it("clamps finite extreme amplitudes without overflow or NaN", () => {
    const result = normalizeWave(
      [
        sample(-Number.MAX_VALUE),
        sample(Number.MAX_VALUE, 1_000),
        sample(0, 2_000),
      ],
      options,
    );
    expect(result.wave.map((point) => point.v)).toEqual([0.5, 1, 0.5]);
    for (const point of result.wave) {
      expect(Number.isFinite(point.v)).toBe(true);
      expect(point.v).toBeGreaterThanOrEqual(0);
      expect(point.v).toBeLessThanOrEqual(1);
    }
  });

  it("orders samples and drops invalid, pre-session, duplicate and late samples", () => {
    const first = normalizeWave(
      [
        sample(10, 1_000),
        sample(-10),
        sample(99, 1_000),
        sample(1, -1),
        sample(Number.NaN, 5_000),
      ],
      options,
    );
    expect(first.wave).toEqual([
      { v: 0.5, atMs: 0 },
      { v: 1, atMs: 1 },
    ]);
    const second = normalizeWave(
      [
        sample(100),
        sample(100, 1_000),
        sample(0, 2_000),
        { value: 1, stable: true, t: Number.NaN },
      ],
      options,
      first.state,
    );
    expect(second.wave).toEqual([{ v: 0.5, atMs: 2 }]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unusable normalization window %s",
    (windowUs) => {
      expect(() =>
        normalizeWave([], { sessionStartUs: startUs, windowUs }),
      ).toThrow(RangeError);
    },
  );

  it("rejects a nonfinite session origin", () => {
    expect(() => normalizeWave([], { sessionStartUs: Number.NaN })).toThrow(
      RangeError,
    );
  });
});
