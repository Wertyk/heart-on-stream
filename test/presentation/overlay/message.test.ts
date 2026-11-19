import { describe, expect, it } from "vitest";
import { parseOverlayMessage } from "../../../src/presentation/overlay/message";

const vibe = {
  mode: "vibe",
  replay: true,
  status: "live",
  intensity: "calm",
  beatWave: [{ atMs: 123, v: 0.5 }],
  breathWave: [],
};
const numbers = { ...vibe, mode: "numbers", pulseBpm: 72, breathingRate: 14.6 };

describe("overlay snapshot validation", () => {
  it("accepts all modes and both visible snapshot shapes", () => {
    for (const state of [
      vibe,
      numbers,
      { mode: "off", replay: false },
      { mode: "highlightsOnly", replay: true },
    ]) {
      expect(parseOverlayMessage(JSON.stringify(state))).toEqual(state);
    }
  });

  it("copies allowlisted fields so extra readings cannot survive in Vibe or hidden modes", () => {
    expect(
      parseOverlayMessage(
        JSON.stringify({
          ...vibe,
          pulseBpm: 91,
          baseline: 73,
          beatWave: [{ atMs: 123, v: 0.5, confidence: 99 }],
        }),
      ),
    ).toEqual(vibe);
    expect(
      parseOverlayMessage(JSON.stringify({ ...numbers, mode: "off" })),
    ).toEqual({ mode: "off", replay: true });
    expect(
      parseOverlayMessage(
        JSON.stringify({ ...numbers, mode: "highlightsOnly" }),
      ),
    ).toEqual({ mode: "highlightsOnly", replay: true });
  });

  it.each([
    null,
    {},
    1,
    "{",
    "null",
    "[]",
    '"vibe"',
    '{"mode":"vibe"}',
    '{"mode":"other","replay":true}',
  ])("ignores malformed or unknown input %s", (data) => {
    expect(parseOverlayMessage(data)).toBeNull();
  });

  it.each([
    { replay: 1 },
    { status: "warming" },
    { intensity: "unknown" },
    { beatWave: null },
    { breathWave: {} },
    { beatWave: [null] },
    { beatWave: [{ v: -0.1, atMs: 0 }] },
    { beatWave: [{ v: 1.1, atMs: 0 }] },
    { beatWave: [{ v: "0.5", atMs: 0 }] },
    { beatWave: [{ v: 0.5, atMs: -1 }] },
    { breathWave: [{ v: 0.5 }] },
    { status: null },
  ])("ignores invalid wave/state fields %j", (change) => {
    expect(
      parseOverlayMessage(JSON.stringify({ ...vibe, ...change })),
    ).toBeNull();
  });

  it("rejects overflowed numeric points rather than poisoning interpolation", () => {
    const message = JSON.stringify(vibe).replace('"atMs":123', '"atMs":1e400');
    expect(parseOverlayMessage(message)).toBeNull();
  });

  it.each([null, "out_of_range", 40, 110])(
    "accepts Numbers pulse %s",
    (pulseBpm) => {
      expect(
        parseOverlayMessage(
          JSON.stringify({ ...numbers, pulseBpm, breathingRate: null }),
        ),
      ).toEqual({ ...numbers, pulseBpm, breathingRate: null });
    },
  );

  it.each([
    { pulseBpm: 39 },
    { pulseBpm: 111 },
    { pulseBpm: "72" },
    { pulseBpm: "out of range" },
    { breathingRate: -1 },
    { breathingRate: "14" },
  ])("ignores invalid Numbers fields %j", (change) => {
    expect(
      parseOverlayMessage(JSON.stringify({ ...numbers, ...change })),
    ).toBeNull();
  });

  it("requires both rate fields in a full Numbers snapshot", () => {
    expect(
      parseOverlayMessage(
        JSON.stringify({ ...vibe, mode: "numbers", pulseBpm: 72 }),
      ),
    ).toBeNull();
    expect(
      parseOverlayMessage(
        JSON.stringify({ ...vibe, mode: "numbers", breathingRate: 14 }),
      ),
    ).toBeNull();
  });
});
