import type { OverlayWave, OverlayWavePoint } from "../../domain/privacy/index";

const delayMs = 1_500;
const restMs = 500;
const historyMs = 12_000;
const maxPoints = 4_096;

/** Explicit browser times make playback deterministic under irregular batches. */
export interface WaveBuffer {
  readonly points: OverlayWave;
  readonly receivedAtMs: number | null;
  readonly cursorAtMs: number | null;
  readonly playedAtMs: number | null;
}

export function emptyWaveBuffer(): WaveBuffer {
  return { points: [], receivedAtMs: null, cursorAtMs: null, playedAtMs: null };
}

/** Overlaps deduplicate; a backwards jump beyond the delay starts a new timeline. */
export function receiveWave(
  buffer: WaveBuffer,
  batch: OverlayWave,
  nowMs: number,
): WaveBuffer {
  if (batch.length === 0) return buffer;
  const previousNewest = buffer.points.at(-1)?.atMs;
  const batchNewest = batch.reduce(
    (newest, point) => Math.max(newest, point.atMs),
    -1,
  );
  if (previousNewest !== undefined && previousNewest - batchNewest > delayMs) {
    buffer = emptyWaveBuffer();
  }
  const pointsByTime = new Map(
    buffer.points.map((point) => [point.atMs, point]),
  );
  for (const point of batch)
    pointsByTime.set(point.atMs, { v: point.v, atMs: point.atMs });
  const sorted = [...pointsByTime.values()].sort((a, b) => a.atMs - b.atMs);
  const newest = sorted.at(-1);
  if (!newest) return buffer;
  const advanced =
    buffer.receivedAtMs === null ||
    newest.atMs > (buffer.points.at(-1)?.atMs ?? -1);
  // Once playback has rested, rebuffer a returning signal instead of spending
  // seconds chasing a cursor that ran ahead during a long upstream gap.
  const rebuffer =
    advanced &&
    buffer.receivedAtMs !== null &&
    nowMs - buffer.receivedAtMs >= 3_500 &&
    buffer.cursorAtMs !== null &&
    buffer.cursorAtMs >= (buffer.points.at(-1)?.atMs ?? 0) + restMs;
  return {
    points: sorted
      .filter((point) => point.atMs >= newest.atMs - historyMs)
      .slice(-maxPoints),
    receivedAtMs: advanced ? nowMs : buffer.receivedAtMs,
    cursorAtMs: rebuffer
      ? newest.atMs - delayMs
      : (buffer.cursorAtMs ?? newest.atMs - delayMs),
    playedAtMs: rebuffer ? nowMs : (buffer.playedAtMs ?? nowMs),
  };
}

function smoothStep(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

/** Interpolate actual points only; draining the final point eases to rest in 0.5 s. */
export function interpolateWave(points: OverlayWave, atMs: number): number {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || atMs < first.atMs) return 0;
  if (atMs >= last.atMs)
    return last.v * (1 - smoothStep((atMs - last.atMs) / restMs));
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const point = points[mid];
    if (point && point.atMs <= atMs) low = mid;
    else high = mid;
  }
  const before = points[low];
  const after = points[high];
  if (!before || !after) return 0;
  return (
    before.v +
    (after.v - before.v) * ((atMs - before.atMs) / (after.atMs - before.atMs))
  );
}

/** Advance continuously, correcting burst timing drift by at most 15% per frame. */
export function playWave(
  buffer: WaveBuffer,
  nowMs: number,
): {
  buffer: WaveBuffer;
  value: number;
  opacity: number;
} {
  const newest = buffer.points.at(-1);
  if (
    !newest ||
    buffer.receivedAtMs === null ||
    buffer.cursorAtMs === null ||
    buffer.playedAtMs === null
  ) {
    return { buffer, value: 0, opacity: 0 };
  }
  const elapsed = Math.max(0, nowMs - buffer.playedAtMs);
  const age = Math.max(0, nowMs - buffer.receivedAtMs);
  const target = newest.atMs - delayMs + age;
  const next = buffer.cursorAtMs + elapsed;
  const correction = Math.max(
    -elapsed * 0.15,
    Math.min(elapsed * 0.15, target - next),
  );
  const cursorAtMs = next + correction;
  return {
    buffer: { ...buffer, cursorAtMs, playedAtMs: nowMs },
    value: interpolateWave(buffer.points, cursorAtMs),
    opacity: 1 - smoothStep((age - 3_000) / restMs),
  };
}

/** A trailing six-second segment, clipped to the delayed playback cursor. */
export function waveTrail(buffer: WaveBuffer): OverlayWave {
  const cursor = buffer.cursorAtMs;
  if (cursor === null || buffer.points.length === 0) return [];
  const start = Math.max(buffer.points[0]?.atMs ?? 0, cursor - 6_000);
  if (start > cursor) return [];
  const points: OverlayWavePoint[] = [
    { atMs: start, v: interpolateWave(buffer.points, start) },
  ];
  points.push(
    ...buffer.points.filter(
      (point) => point.atMs > start && point.atMs < cursor,
    ),
  );
  if (cursor > start)
    points.push({ atMs: cursor, v: interpolateWave(buffer.points, cursor) });
  return points;
}
