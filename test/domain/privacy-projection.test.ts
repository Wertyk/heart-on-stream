import { describe, expect, it } from "vitest";
import {
  type OverlayState,
  type PrivacyMode,
  type ProjectionInput,
  projectOverlay,
} from "../../src/domain/privacy/index";

const input: ProjectionInput = {
  status: "live",
  intensity: "elevated",
  pulse: { kind: "valid", bpm: 72.6 },
  breathingRate: 18.3,
  beatWave: [{ v: 0.25, atMs: 0 }],
  breathWave: [{ v: 0.75, atMs: 0 }],
  beatWindow: { fromMs: 0, toMs: 100 },
  replay: false,
};

const animationKeys = [
  "mode",
  "beatWave",
  "breathWave",
  "intensity",
  "status",
  "replay",
];

function assertNoReadings(state: OverlayState): void {
  const forbiddenKeys =
    /pulse|bpm|breathingRate|confidence|stable|stability|baseline|delta|change/iu;
  const sensitiveValues = [72.6, 18.3, 96, 88, 67, 12];
  function walk(value: unknown, path: string): void {
    if (typeof value === "number") {
      expect(sensitiveValues).not.toContain(value);
      expect(path).toMatch(/^(beatWave|breathWave)\.\d+\.(v|atMs)$/u);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      if (path.endsWith(".v")) expect(value).toBeLessThanOrEqual(1);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        walk(entry, `${path}.${index}`);
      });
    } else if (value !== null && typeof value === "object") {
      if (path) expect(Object.keys(value).sort()).toEqual(["atMs", "v"]);
      for (const [key, entry] of Object.entries(value)) {
        expect(key).not.toMatch(forbiddenKeys);
        walk(entry, path ? `${path}.${key}` : key);
      }
    } else {
      expect(typeof value === "string" || typeof value === "boolean").toBe(
        true,
      );
    }
  }
  walk(state, "");
}

describe("projectOverlay privacy policy", () => {
  it.each<[PrivacyMode, string[]]>([
    ["off", ["mode", "replay"]],
    ["highlightsOnly", ["mode", "replay"]],
    ["vibe", animationKeys],
    ["numbers", [...animationKeys, "pulseBpm", "breathingRate"]],
  ])("publishes exactly the allowed keys for %s", (mode, keys) => {
    const output = projectOverlay(input, mode);
    expect(Object.keys(output).sort()).toEqual([...keys].sort());
    expect(output.mode).toBe(mode);
  });

  it.each(["off", "highlightsOnly", "vibe"] as const)(
    "%s recursively removes readings even from contaminated nested input",
    (mode) => {
      const contaminated = {
        ...input,
        pulseBpm: 72.6,
        confidence: 96,
        stable: true,
        stability: 88,
        baseline: 67,
        deltaBpm: 12,
        changeVsBaseline: 12,
        privateReadings: { bpm: 72.6, breathingRate: 18.3 },
        pulse: { kind: "valid" as const, bpm: 72.6, confidence: 96 },
        beatWave: [
          { v: 0.25, atMs: 0, bpm: 72.6, confidence: 96, baseline: 67 },
        ],
        breathWave: [
          { v: 0.75, atMs: 0, breathingRate: 18.3, stable: true, delta: 12 },
        ],
      };
      const output = projectOverlay(contaminated, mode);
      expect(Object.keys(output).sort()).toEqual(
        (mode === "vibe" ? [...animationKeys] : ["mode", "replay"]).sort(),
      );
      assertNoReadings(output);
    },
  );

  it.each([
    [40, 40],
    [110, 110],
    [72.6, 73],
    [39.999, "out_of_range"],
    [110.001, "out_of_range"],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ] as const)(
    "projects valid-kind pulse %s as %s in Numbers",
    (bpm, expected) => {
      expect(
        projectOverlay({ ...input, pulse: { kind: "valid", bpm } }, "numbers"),
      ).toMatchObject({ pulseBpm: expected, breathingRate: 18 });
    },
  );

  it.each([
    [{ kind: "outOfRange" }, "out_of_range"],
    [{ kind: "none" }, null],
  ] as const)("projects %j explicitly in Numbers", (pulse, expected) => {
    expect(projectOverlay({ ...input, pulse }, "numbers")).toMatchObject({
      pulseBpm: expected,
    });
  });

  it("rounds the audited breathing estimate to a whole number in Numbers", () => {
    expect(
      projectOverlay({ ...input, breathingRate: 14.789 }, "numbers"),
    ).toMatchObject({ breathingRate: 15 });
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses null for unavailable or nonfinite breathing rate %s",
    (breathingRate) => {
      expect(
        projectOverlay({ ...input, breathingRate }, "numbers"),
      ).toMatchObject({ breathingRate: null });
    },
  );

  it.each(["vibe", "numbers"] as const)(
    "%s retains every presentation status and replay indication",
    (mode) => {
      for (const status of ["calibrating", "live", "paused"] as const) {
        for (const replay of [false, true]) {
          expect(
            projectOverlay({ ...input, status, replay }, mode),
          ).toMatchObject({
            status,
            replay,
          });
        }
      }
    },
  );

  it.each(["off", "highlightsOnly"] as const)(
    "%s retains only mode and replay even while paused",
    (mode) => {
      for (const replay of [false, true]) {
        expect(
          projectOverlay({ ...input, status: "paused", replay }, mode),
        ).toEqual({
          mode,
          replay,
        });
      }
    },
  );

  it("fills a missing beat batch upstream without publishing the fallback rate", () => {
    const output = projectOverlay(
      {
        ...input,
        beatWave: [],
        beatWindow: { fromMs: 0, toMs: 2_000 },
        pulse: { kind: "valid", bpm: 60 },
      },
      "vibe",
    );
    expect(output.mode).toBe("vibe");
    if (output.mode !== "vibe") throw new Error("Expected Vibe output.");
    expect(output.beatWave).toHaveLength(40);
    expect(output.beatWave.some((point) => point.v > 0.9)).toBe(true);
    expect(Object.keys(output).sort()).toEqual([...animationKeys].sort());
    assertNoReadings(output);
  });

  it.each(["none", "outOfRange"] as const)(
    "stops fallback beats when the rate becomes %s",
    (kind) => {
      expect(
        projectOverlay({ ...input, beatWave: [], pulse: { kind } }, "vibe"),
      ).toMatchObject({ beatWave: [] });
    },
  );

  it("stops fallback beats while paused", () => {
    expect(
      projectOverlay({ ...input, status: "paused", beatWave: [] }, "vibe"),
    ).toMatchObject({ status: "paused", beatWave: [] });
  });

  it("copies, sanitizes and clamps wave points without mutating input", () => {
    const beat = Object.freeze({ v: 2, atMs: 0 });
    const breath = Object.freeze({ v: -2, atMs: 0 });
    const output = projectOverlay(
      {
        ...input,
        beatWave: Object.freeze([beat]),
        breathWave: Object.freeze([
          breath,
          { v: Number.NaN, atMs: 10 },
          { v: 0.5, atMs: -1 },
          { v: 0.5, atMs: Number.POSITIVE_INFINITY },
        ]),
      },
      "numbers",
    );
    if (output.mode !== "numbers") throw new Error("Expected Numbers output.");
    expect(output.beatWave).toEqual([{ v: 1, atMs: 0 }]);
    expect(output.breathWave).toEqual([{ v: 0, atMs: 0 }]);
    expect(output.beatWave[0]).not.toBe(beat);
    expect(output.breathWave[0]).not.toBe(breath);
    expect(beat.v).toBe(2);
    expect(breath.v).toBe(-2);
  });
});
