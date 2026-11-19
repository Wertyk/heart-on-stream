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

  it("removes the provisional peak after the measured batch ending at 40.034 s", () => {
    const provisional: OverlayWave = [
      { atMs: 40_000, v: 0.2 },
      { atMs: 40_050, v: 0.4 },
      { atMs: 40_100, v: 1 },
      { atMs: 40_150, v: 0.3 },
      { atMs: 40_200, v: 0.2 },
    ];
    const measured: OverlayWave = [
      { atMs: 39_970, v: 0.2 },
      { atMs: 40_003, v: 0.2 },
      { atMs: 40_034, v: 0.2 },
    ];
    const buffer = receiveBeatWave(emptyWaveBuffer(), provisional, 41_000);
    const replaced = receiveBeatWave(buffer, measured, 41_100);
    const peaks: number[] = [];
    visitBeatPeaks(replaced.points, 39_970, 40_200, (peak) => peaks.push(peak));
    expect(peaks).toEqual([]);
    expect(replaced.points).toEqual([...measured, provisional.at(-1)]);
  });

  it("preserves known measured samples under trailing coverage", () => {
    const previous: OverlayWave = [
      { atMs: 40_100, v: 0.5 },
      { atMs: 40_134, v: 0.4 },
    ];
    const late: OverlayWave = [{ atMs: 40_034, v: 0.2 }];
    const buffer = receiveBeatWave(emptyWaveBuffer(), previous, 41_000);
    expect(receiveBeatWave(buffer, late, 41_100).points).toEqual([
      ...late,
      ...previous,
    ]);
  });

  it("extends coverage from a measured sample aligned with the gap-fill grid", () => {
    const provisional: OverlayWave = [
      { atMs: 40_100, v: 1 },
      { atMs: 40_150, v: 0 },
      { atMs: 40_200, v: 0 },
    ];
    const measured: OverlayWave = [
      { atMs: 40_017, v: 0.2 },
      { atMs: 40_050, v: 0.2 },
    ];
    const buffer = receiveBeatWave(emptyWaveBuffer(), provisional, 41_000);
    expect(receiveBeatWave(buffer, measured, 41_100).points).toEqual([
      ...measured,
      provisional.at(-1),
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

  it("matches the pre-replay-fix live cursor sequence across jitter and rebuffering", () => {
    let buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    const cursorAt = (nowMs: number) => {
      buffer = playWave(buffer, nowMs).buffer;
      return buffer.cursorAtMs;
    };

    const cursors = [cursorAt(0), cursorAt(800)];
    buffer = receiveWave(buffer, [{ atMs: 3_500, v: 0 }], 800);
    cursors.push(cursorAt(800), cursorAt(816), cursorAt(1_000));
    buffer = receiveWave(buffer, [{ atMs: 3_500, v: 0 }], 1_200);
    cursors.push(cursorAt(1_200), cursorAt(5_000));
    buffer = receiveWave(buffer, [{ atMs: 5_000, v: 0.5 }], 5_000);
    cursors.push(cursorAt(5_000), cursorAt(5_250));

    expect(cursors).toEqual([
      1_000, 1_800, 1_800, 1_818.4, 2_030, 2_260, 6_200, 3_500, 3_750,
    ]);
  });

  it("holds at the delayed replay edge and fast-forwards when a batch leaves it far behind", () => {
    const buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    const held = playWave(buffer, 500, 2_500);
    expect(held.buffer.cursorAtMs).toBe(1_000);
    const advanced = receiveWave(held.buffer, [{ atMs: 6_000, v: 0.5 }], 500);
    expect(playWave(advanced, 516, 6_000).buffer.cursorAtMs).toBe(4_500);
  });

  it.each([0.25, 0.5, 1, 2, 8, 20])(
    "advances between batches at the observed %s× rate until the safety margin",
    (speed) => {
      let buffer = receiveWave(emptyWaveBuffer(), wave, 0);
      buffer = playWave(buffer, 0, 2_500).buffer;
      buffer = playWave(buffer, 500 / speed, 2_500).buffer;
      const secondBatchAt = 2_000 / speed;
      buffer = receiveWave(buffer, [{ atMs: 4_500, v: 0.5 }], secondBatchAt);
      const observed = playWave(buffer, secondBatchAt, 4_500).buffer;
      const next = playWave(observed, secondBatchAt + 10, 4_500).buffer;
      expect(next.cursorAtMs).toBeCloseTo(
        (observed.cursorAtMs ?? 0) + 10 * speed,
      );

      const drainedAt = secondBatchAt + 10 + 2_000 / speed;
      const drained = playWave(next, drainedAt, 4_500).buffer;
      expect(drained.cursorAtMs).toBe(4_375);
      expect(playWave(drained, drainedAt + 10, 4_500).buffer.cursorAtMs).toBe(
        4_375,
      );
    },
  );

  it("fades a replay wave after a gap in recording time or a prolonged stall", () => {
    const buffer = receiveWave(emptyWaveBuffer(), wave, 0);
    expect(playWave(buffer, 4_000, 3_500).opacity).toBe(1);
    expect(playWave(buffer, 4_000, 6_000).opacity).toBe(0);
    expect(playWave(buffer, 14_000, 2_500).opacity).toBe(0);
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
