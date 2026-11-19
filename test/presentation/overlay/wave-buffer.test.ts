import { describe, expect, it } from "vitest";
import type { OverlayWave } from "../../../src/domain/privacy/index";
import {
  emptyWaveBuffer,
  interpolateWave,
  playWave,
  receiveBeatWave,
  receiveWave,
  visitBeatPeaks,
  waveTrail,
} from "../../../src/presentation/overlay/wave-buffer";

const wave: OverlayWave = [
  { atMs: 0, v: 0 },
  { atMs: 500, v: 1 },
  { atMs: 1_000, v: 0 },
  { atMs: 1_500, v: 1 },
  { atMs: 2_000, v: 0 },
  { atMs: 2_500, v: 1 },
];

describe("wave accumulation", () => {
  it("replaces provisional gap fill under late waveform batches from the calm replay", () => {
    // Projected excerpts from samples/live-b-calm.jsonl at 111.7–112.2 s.
    const provisional: OverlayWave = [
      { atMs: 110_600, v: 0 },
      { atMs: 110_750, v: 0 },
      { atMs: 110_800, v: 0 },
      { atMs: 110_850, v: 0 },
      { atMs: 110_900, v: 0 },
      { atMs: 110_950, v: 0 },
      { atMs: 111_000, v: 0 },
      { atMs: 111_050, v: 0 },
      { atMs: 111_100, v: 0 },
    ];
    const rise: OverlayWave = [
      { atMs: 110_766.2, v: 0.297 },
      { atMs: 110_795.2, v: 0.494 },
      { atMs: 110_831.7, v: 0.727 },
      { atMs: 110_865.6, v: 0.946 },
      { atMs: 110_901.4, v: 1 },
      { atMs: 110_933.9, v: 1 },
    ];
    const fall: OverlayWave = [
      { atMs: 110_962.6, v: 1 },
      { atMs: 111_002.3, v: 0.93 },
      { atMs: 111_031.1, v: 0.848 },
      { atMs: 111_063.9, v: 0.77 },
      { atMs: 111_096, v: 0.703 },
      { atMs: 111_133.8, v: 0.648 },
    ];
    let buffer = receiveBeatWave(emptyWaveBuffer(), provisional, 111_729.7);
    buffer = receiveBeatWave(
      buffer,
      [...rise, { atMs: 111_100, v: 0 }],
      111_933.4,
    );
    buffer = receiveBeatWave(buffer, fall, 112_136.9);
    expect(buffer.points).toEqual([provisional[0], ...rise, ...fall]);
    const peaks: number[] = [];
    visitBeatPeaks(buffer.points, 110_750, 111_133.8, (peak) =>
      peaks.push(peak),
    );
    expect(peaks).toEqual([110_962.6]);
    expect(interpolateWave(buffer.points, 110_950)).toBe(1);
  });

  it("keeps an aligned sample within the same batch as a nearby measured point", () => {
    const previous: OverlayWave = [
      { atMs: 731, v: 0.5 },
      { atMs: 750, v: 0.9 },
    ];
    const next: OverlayWave = [
      { atMs: 784, v: 0.5 },
      { atMs: 815, v: 0.1 },
    ];
    const buffer = receiveBeatWave(emptyWaveBuffer(), previous, 800);
    expect(receiveBeatWave(buffer, next, 900).points).toEqual([
      ...previous,
      ...next,
    ]);
  });

  it("sorts overlapping bursts, deduplicates by timestamp and never mutates input", () => {
    const initial = receiveWave(
      emptyWaveBuffer(),
      Object.freeze(wave.slice(0, 3)),
      0,
    );
    const result = receiveWave(
      initial,
      [
        { atMs: 1_500, v: 1 },
        { atMs: 500, v: 0.8 },
        { atMs: 1_000, v: 0 },
      ],
      800,
    );
    expect(result.points).toEqual([
      { atMs: 0, v: 0 },
      { atMs: 500, v: 0.8 },
      { atMs: 1_000, v: 0 },
      { atMs: 1_500, v: 1 },
    ]);
    expect(initial.points).toEqual(wave.slice(0, 3));
  });

  it("does not refresh freshness for duplicate, late or empty batches", () => {
    const initial = receiveWave(emptyWaveBuffer(), wave, 100);
    expect(receiveWave(initial, wave, 800).receivedAtMs).toBe(100);
    expect(receiveWave(initial, wave.slice(0, 3), 900).receivedAtMs).toBe(100);
    expect(receiveWave(initial, [], 1_000)).toBe(initial);
  });

  it("starts a fresh timeline when a batch moves backwards beyond 1.5 s", () => {
    const initial = playWave(
      receiveWave(emptyWaveBuffer(), wave, 100),
      1_100,
    ).buffer;
    // The newest point need not be the last point in a batch.
    const restarted = receiveWave(
      initial,
      [
        { atMs: 800, v: 1 },
        { atMs: 0, v: 0 },
      ],
      1_200,
    );
    expect(restarted.points).toEqual([
      { atMs: 0, v: 0 },
      { atMs: 800, v: 1 },
    ]);
    expect(restarted.receivedAtMs).toBe(1_200);
    expect(restarted.playedAtMs).toBe(1_200);
    expect(restarted.cursorAtMs).toBe(-700);
    expect(playWave(restarted, 2_300).value).toBe(0.5);
    expect(initial.points).toEqual(wave);
  });

  it.each([1_000, 1_500, 2_500])(
    "preserves the timeline for an overlapping batch ending at %i ms",
    (atMs) => {
      const initial = playWave(
        receiveWave(emptyWaveBuffer(), wave, 100),
        600,
      ).buffer;
      const overlap = receiveWave(
        initial,
        [
          { atMs, v: 0.7 },
          { atMs: 0, v: 0 },
        ],
        900,
      );
      expect(overlap.points).toHaveLength(wave.length);
      expect(overlap.points.at(-1)?.atMs).toBe(2_500);
      expect(overlap.points.find((point) => point.atMs === atMs)?.v).toBe(0.7);
      expect(overlap.receivedAtMs).toBe(initial.receivedAtMs);
      expect(overlap.playedAtMs).toBe(initial.playedAtMs);
      expect(overlap.cursorAtMs).toBe(initial.cursorAtMs);
    },
  );

  it("bounds retained history by time and point count during long sessions", () => {
    const many = Array.from({ length: 20_001 }, (_, atMs) => ({
      atMs,
      v: 0.5,
    }));
    const result = receiveWave(emptyWaveBuffer(), many, 0);
    expect(result.points.length).toBeLessThanOrEqual(4_096);
    expect(result.points[0]?.atMs).toBeGreaterThanOrEqual(8_000);
    const sparse = receiveWave(
      emptyWaveBuffer(),
      [
        { atMs: 0, v: 1 },
        { atMs: 13_000, v: 1 },
      ],
      0,
    );
    expect(sparse.points).toEqual([{ atMs: 13_000, v: 1 }]);
  });
});

describe("jitter-buffer playback", () => {
  it("starts 1.5 s behind the newest point and interpolates between samples", () => {
    const buffer = receiveWave(emptyWaveBuffer(), wave, 10_000);
    const first = playWave(buffer, 10_000);
    expect(first.buffer.cursorAtMs).toBe(1_000);
    expect(first.value).toBe(0);
    const next = playWave(first.buffer, 10_250);
    expect(next.buffer.cursorAtMs).toBe(1_250);
    expect(next.value).toBe(0.5);
  });

  it("keeps a continuous cursor through irregular bursts rather than jumping to newest", () => {
    let buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    buffer = playWave(buffer, 800).buffer;
    buffer = receiveWave(buffer, [{ atMs: 3_500, v: 0 }], 800);
    expect(playWave(buffer, 800).buffer.cursorAtMs).toBe(1_800);
    const frame = playWave(buffer, 816);
    expect(frame.buffer.cursorAtMs).toBeCloseTo(1_818.4);
    expect(frame.value).toBeCloseTo(interpolateWave(buffer.points, 1_818.4));
  });

  it("drains queued points then eases to rest in 500 ms without synthesizing beats", () => {
    const buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    expect(playWave(buffer, 1_500).value).toBe(1);
    expect(playWave(buffer, 1_750).value).toBe(0.5);
    expect(playWave(buffer, 2_000).value).toBe(0);
    expect(playWave(buffer, 20_000).value).toBe(0);
  });

  it("fades an absent breathing ribbon after 3 s even if old batches keep arriving", () => {
    const buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    const duplicate = receiveWave(buffer, wave, 3_100);
    expect(playWave(duplicate, 3_000).opacity).toBe(1);
    expect(playWave(duplicate, 3_250).opacity).toBe(0.5);
    expect(playWave(duplicate, 3_500).opacity).toBe(0);
    const resumed = receiveWave(duplicate, [{ atMs: 6_000, v: 0.5 }], 4_000);
    expect(playWave(resumed, 4_000).opacity).toBe(1);
  });

  it("rests before the first sample and when no data has arrived", () => {
    expect(playWave(emptyWaveBuffer(), 500)).toMatchObject({
      value: 0,
      opacity: 0,
    });
    expect(interpolateWave([], 0)).toBe(0);
    expect(interpolateWave([{ atMs: 100, v: 1 }], 99)).toBe(0);
    expect(interpolateWave([{ atMs: 100, v: 1 }], 350)).toBe(0.5);
    expect(waveTrail(emptyWaveBuffer())).toEqual([]);
  });

  it("rebuffers after a long dropout once playback has reached rest", () => {
    const stopped = playWave(receiveWave(emptyWaveBuffer(), wave, 0), 10_000);
    expect(stopped.value).toBe(0);
    const resumed = receiveWave(
      stopped.buffer,
      [
        { atMs: 3_000, v: 0 },
        { atMs: 4_000, v: 1 },
        { atMs: 5_000, v: 0 },
      ],
      10_000,
    );
    expect(playWave(resumed, 10_000).buffer.cursorAtMs).toBe(3_500);
    expect(playWave(resumed, 10_000).value).toBe(0.5);
  });

  it("clips the breathing trail to the playback cursor and six seconds of history", () => {
    const points = Array.from({ length: 11 }, (_, index) => ({
      atMs: index * 1_000,
      v: index % 2,
    }));
    const frame = playWave(receiveWave(emptyWaveBuffer(), points, 0), 0);
    const trail = waveTrail(frame.buffer);
    expect(trail[0]).toEqual({ atMs: 2_500, v: 0.5 });
    expect(trail.at(-1)).toEqual({ atMs: 8_500, v: 0.5 });
    expect(trail.every((point) => point.atMs <= 8_500)).toBe(true);
  });
});
