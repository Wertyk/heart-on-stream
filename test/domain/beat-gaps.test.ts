import { describe, expect, it } from "vitest";
import {
  fillBeatWaveGaps,
  type OverlayWave,
} from "../../src/domain/privacy/index";

const window = { fromMs: 0, toMs: 3_000, pulseBpm: 60 };

describe("beat waveform gap filling", () => {
  it("synthesizes normalized periodic beats at the last valid rate", () => {
    const wave = fillBeatWaveGaps([], window);
    expect(wave).toHaveLength(60);
    expect(wave[0]?.atMs).toBe(0);
    expect(wave.at(-1)?.atMs).toBe(2_950);
    expect(wave.find((point) => point.atMs === 100)?.v).toBeGreaterThan(0.9);
    expect(wave.find((point) => point.atMs === 500)?.v).toBe(0);
    for (let index = 0; index < 20; index += 1) {
      expect(wave[index]?.v).toBeCloseTo(wave[index + 20]?.v ?? -1);
    }
    for (const point of wave) {
      expect(Object.keys(point).sort()).toEqual(["atMs", "v"]);
      expect(point.v).toBeGreaterThanOrEqual(0);
      expect(point.v).toBeLessThanOrEqual(1);
    }
  });

  it("changes the synthesized period with the supplied rate", () => {
    const wave = fillBeatWaveGaps([], { ...window, pulseBpm: 100 });
    expect(wave.find((point) => point.atMs === 50)?.v).toBeCloseTo(
      wave.find((point) => point.atMs === 650)?.v ?? -1,
    );
    expect(wave.find((point) => point.atMs === 300)?.v).toBe(0);
  });

  it.each([null, 0, 39.9, 110.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "stops synthesizing without a usable rate (%s), preserving real points",
    (pulseBpm) => {
      const realWave = [{ v: 0.7, atMs: 500 }];
      expect(fillBeatWaveGaps([], { ...window, pulseBpm })).toEqual([]);
      expect(fillBeatWaveGaps(realWave, { ...window, pulseBpm })).toEqual(
        realWave,
      );
    },
  );

  it("fills leading, interior and trailing gaps without overlapping real spans", () => {
    const real: OverlayWave = Object.freeze([
      Object.freeze({ v: 0.3, atMs: 500 }),
      Object.freeze({ v: 0.4, atMs: 700 }),
      Object.freeze({ v: 0.5, atMs: 900 }),
      Object.freeze({ v: 0.6, atMs: 2_000 }),
      Object.freeze({ v: 0.7, atMs: 2_200 }),
    ]);
    const result = fillBeatWaveGaps(real, window);
    for (const point of real) expect(result).toContainEqual(point);
    const synthetic = result.filter(
      (point) => !real.some((r) => r.atMs === point.atMs),
    );
    expect(synthetic.some((point) => point.atMs < 375)).toBe(true);
    expect(
      synthetic.some((point) => point.atMs > 1_025 && point.atMs < 1_875),
    ).toBe(true);
    expect(synthetic.some((point) => point.atMs > 2_325)).toBe(true);
    expect(
      synthetic.every((point) =>
        real.every((r) => Math.abs(r.atMs - point.atMs) > 125),
      ),
    ).toBe(true);
    expect(
      synthetic.some((point) => point.atMs >= 500 && point.atMs <= 900),
    ).toBe(false);
    expect(result.map((point) => point.atMs)).toEqual(
      [...result.map((point) => point.atMs)].sort((a, b) => a - b),
    );
    expect(real).toHaveLength(5);
  });

  it("emits no synthetic points when the entire window has real coverage", () => {
    const real = Array.from({ length: 10 }, (_, index) => ({
      v: 0.4,
      atMs: index * 100,
    }));
    expect(fillBeatWaveGaps(real, { ...window, toMs: 1_000 })).toEqual(real);
  });

  it("lets real points outside the window protect its coverage boundaries", () => {
    expect(
      fillBeatWaveGaps([{ v: 0.4, atMs: 1_000 }], {
        fromMs: 900,
        toMs: 1_000,
        pulseBpm: 60,
      }),
    ).toEqual([]);
  });

  it("uses half-open windows and a session-anchored grid across batch splits", () => {
    const first = fillBeatWaveGaps([], { ...window, toMs: 1_023 });
    const second = fillBeatWaveGaps([], { ...window, fromMs: 1_023 });
    expect([...first, ...second]).toEqual(fillBeatWaveGaps([], window));
    expect(fillBeatWaveGaps([], { ...window, fromMs: 200, toMs: 200 })).toEqual(
      [],
    );
  });

  it("does not carry a valid rate into a subsequent invalidated window", () => {
    expect(fillBeatWaveGaps([], { ...window, toMs: 1_000 })).toHaveLength(20);
    expect(
      fillBeatWaveGaps([], { ...window, fromMs: 1_000, pulseBpm: null }),
    ).toEqual([]);
  });

  it.each([
    { fromMs: -1, toMs: 100 },
    { fromMs: 100, toMs: 50 },
    { fromMs: Number.NaN, toMs: 100 },
    { fromMs: 0, toMs: Number.POSITIVE_INFINITY },
  ])("rejects an invalid time window %j", (span) => {
    expect(() => fillBeatWaveGaps([], { ...span, pulseBpm: 60 })).toThrow(
      RangeError,
    );
  });
});
