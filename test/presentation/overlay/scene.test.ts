import { describe, expect, it } from "vitest";
import type {
  NumbersOverlayState,
  VibeOverlayState,
} from "../../../src/domain/privacy/index";
import {
  advanceScene,
  disconnectScene,
  emptyScene,
  receiveSnapshot,
} from "../../../src/presentation/overlay/scene";
import { overlayView } from "../../../src/presentation/overlay/view";
import { playWave } from "../../../src/presentation/overlay/wave-buffer";

const vibe: VibeOverlayState = {
  mode: "vibe",
  replay: true,
  status: "live",
  intensity: "spike",
  beatWave: [{ atMs: 2_000, v: 1 }],
  breathWave: [{ atMs: 2_000, v: 0.8 }],
};
const numbers: NumbersOverlayState = {
  ...vibe,
  mode: "numbers",
  pulseBpm: 72.4,
  breathingRate: 13.7,
};

describe("privacy and status presentation", () => {
  it("shows no numerical labels in Vibe", () => {
    const view = overlayView(vibe);
    expect(view).toMatchObject({
      visible: true,
      replay: true,
      pulseLabel: null,
      breathingLabel: null,
      readingsCaption: null,
      intensity: "spike",
    });
  });

  it("shows rounded rates, unavailable estimates and out of range in Numbers", () => {
    expect(overlayView(numbers)).toMatchObject({
      pulseLabel: "72 BPM",
      breathingLabel: "14 breaths/min",
      readingsCaption: "camera estimate · not medical",
    });
    expect(
      overlayView({
        ...numbers,
        pulseBpm: "out_of_range",
        breathingRate: null,
      }),
    ).toMatchObject({ pulseLabel: "out of range", breathingLabel: null });
    expect(overlayView({ ...numbers, pulseBpm: null })).toMatchObject({
      pulseLabel: null,
    });
  });

  it.each(["off", "highlightsOnly"] as const)(
    "renders nothing in %s, even during replay",
    (mode) => {
      expect(overlayView({ mode, replay: true })).toMatchObject({
        visible: false,
        replay: false,
        pulseLabel: null,
        breathingLabel: null,
        readingsCaption: null,
      });
      const scene = receiveSnapshot(
        receiveSnapshot(emptyScene(), vibe, 0),
        { mode, replay: true },
        100,
      );
      expect(scene.beat.points).toEqual([]);
      expect(scene.breath.points).toEqual([]);
    },
  );

  it("dims paused activity, keeps the REPLAY badge and shows calibration", () => {
    expect(overlayView({ ...vibe, status: "paused" })).toMatchObject({
      paused: true,
      statusLabel: "paused",
      replay: true,
    });
    expect(overlayView({ ...vibe, status: "calibrating" })).toMatchObject({
      paused: false,
      statusLabel: "calibrating",
    });
    expect(overlayView({ ...vibe, replay: false }).replay).toBe(false);
    expect(overlayView(null).visible).toBe(false);
  });

  it.each(["live", "paused", "calibrating"] as const)(
    "retains the Numbers caption while %s in live and replay mode",
    (status) => {
      for (const replay of [false, true])
        expect(
          overlayView({ ...numbers, status, replay }).readingsCaption,
        ).toBe("camera estimate · not medical");
    },
  );
});

describe("accelerated replay", () => {
  it.each([2, 8, 20])(
    "keeps both wave displays and rings active at %i×",
    (speed) => {
      let scene = emptyScene();
      let batchEndMs = 600;
      for (let nowMs = 0; nowMs <= 20_000; nowMs += 20) {
        while (batchEndMs / speed <= nowMs) {
          const points = Array.from({ length: 15 }, (_, index) => {
            const atMs = batchEndMs - 600 + index * 40;
            return { atMs, v: 1 - Math.abs((atMs % 800) - 400) / 400 };
          });
          scene = receiveSnapshot(
            scene,
            { ...vibe, beatWave: points, breathWave: points },
            batchEndMs / speed,
          );
          batchEndMs += 600;
        }
        const frame = advanceScene(scene, nowMs);
        scene = frame.scene;
        if (nowMs < 19_000) continue;
        expect(frame.animation.pulseTrace?.points.length).toBeGreaterThan(1);
        expect(frame.animation.breathRibbon?.points.length).toBeGreaterThan(1);
        expect(frame.animation.ringProgress.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("snapshot accumulation and reset", () => {
  it.each(["calibrating", "live"] as const)(
    "resets both wave timelines without a mode or status change while %s",
    (status) => {
      const scene = receiveSnapshot(
        emptyScene(),
        {
          ...vibe,
          status,
          beatWave: [{ atMs: 10_000, v: 1 }],
          breathWave: [{ atMs: 12_000, v: 0.8 }],
        },
        100,
      );
      const next = receiveSnapshot(
        scene,
        {
          ...vibe,
          status,
          beatWave: [
            { atMs: 0, v: 0 },
            { atMs: 2_000, v: 1 },
          ],
          breathWave: [
            { atMs: 0, v: 0.2 },
            { atMs: 2_400, v: 1 },
          ],
        },
        1_000,
      );
      expect(next.beat.points).toEqual([
        { atMs: 0, v: 0 },
        { atMs: 2_000, v: 1 },
      ]);
      expect(next.breath.points).toEqual([
        { atMs: 0, v: 0.2 },
        { atMs: 2_400, v: 1 },
      ]);
      expect(next.beat.cursorAtMs).toBe(500);
      expect(next.breath.cursorAtMs).toBe(900);
      expect(next.beat.receivedAtMs).toBe(1_000);
      expect(next.breath.receivedAtMs).toBe(1_000);
      expect(playWave(next.beat, 1_000).value).toBe(0.25);
      expect(playWave(next.breath, 1_000).value).toBeCloseTo(0.5);
    },
  );

  it("retains both timelines for overlapping and duplicated snapshots", () => {
    const scene = receiveSnapshot(
      emptyScene(),
      {
        ...vibe,
        beatWave: [
          { atMs: 9_000, v: 0 },
          { atMs: 10_000, v: 1 },
        ],
        breathWave: [
          { atMs: 10_000, v: 0.2 },
          { atMs: 12_000, v: 0.8 },
        ],
      },
      100,
    );
    const overlap = receiveSnapshot(
      scene,
      {
        ...vibe,
        beatWave: [{ atMs: 9_000, v: 0.5 }],
        breathWave: [{ atMs: 10_500, v: 0.4 }],
      },
      900,
    );
    expect(overlap.beat.points).toEqual([
      { atMs: 9_000, v: 0.5 },
      { atMs: 10_000, v: 1 },
    ]);
    expect(overlap.breath.points).toEqual([
      { atMs: 10_000, v: 0.2 },
      { atMs: 10_500, v: 0.4 },
      { atMs: 12_000, v: 0.8 },
    ]);
    expect(overlap.beat.cursorAtMs).toBe(scene.beat.cursorAtMs);
    expect(overlap.breath.cursorAtMs).toBe(scene.breath.cursorAtMs);
    expect(overlap.beat.receivedAtMs).toBe(100);
    expect(overlap.breath.receivedAtMs).toBe(100);
    const duplicate = receiveSnapshot(
      overlap,
      {
        ...vibe,
        beatWave: overlap.beat.points,
        breathWave: overlap.breath.points,
      },
      1_000,
    );
    expect(duplicate.beat).toEqual(overlap.beat);
    expect(duplicate.breath).toEqual(overlap.breath);
  });

  it("accumulates batches across full snapshots while replacing display fields", () => {
    const scene = receiveSnapshot(emptyScene(), vibe, 0);
    const next = receiveSnapshot(
      scene,
      {
        ...vibe,
        intensity: "calm",
        beatWave: [{ atMs: 3_000, v: 0 }],
        breathWave: [],
      },
      1_000,
    );
    expect(next.beat.points).toHaveLength(2);
    expect(next.breath.points).toEqual(vibe.breathWave);
    expect(next.state).toMatchObject({ intensity: "calm" });
  });

  it("discards paused points and does not resurrect them on resume", () => {
    const scene = receiveSnapshot(emptyScene(), vibe, 0);
    const paused = receiveSnapshot(scene, { ...vibe, status: "paused" }, 500);
    expect(paused.beat.points).toEqual([]);
    const resumed = receiveSnapshot(
      paused,
      { ...vibe, beatWave: [], breathWave: [] },
      1_000,
    );
    expect(resumed.beat.points).toEqual([]);
    expect(resumed.breath.points).toEqual([]);
  });

  it("discards old session times on privacy changes or renewed calibration", () => {
    const scene = receiveSnapshot(emptyScene(), vibe, 0);
    const restarted = receiveSnapshot(
      scene,
      { ...vibe, status: "calibrating", beatWave: [{ atMs: 0, v: 0 }] },
      1_000,
    );
    expect(restarted.beat.points).toEqual([{ atMs: 0, v: 0 }]);
    const switched = receiveSnapshot(
      scene,
      { ...numbers, beatWave: [] },
      1_000,
    );
    expect(switched.beat.points).toEqual([]);
  });

  it("keeps the heart visible while disconnected and clears stale numerical labels", () => {
    const scene = receiveSnapshot(emptyScene(), numbers, 0);
    const offline = disconnectScene(scene);
    expect(overlayView(offline.state)).toMatchObject({
      visible: true,
      replay: true,
      pulseLabel: null,
      breathingLabel: null,
    });
    expect(offline.beat).toBe(scene.beat);
    expect(disconnectScene(emptyScene())).toEqual(emptyScene());
  });
});
