import type { OverlayWave, OverlayWavePoint } from "../../domain/privacy/index";

const delayMs = 1_500;
const maxPlaybackLagMs = 2 * delayMs;
const catchUpMs = 100;
const restMs = 500;
const minReplaySpeed = 0.25;
const historyMs = 12_000;
const maxPoints = 4_096;
const breathTrailMs = 6_000;
const pulseTraceMs = 4_000;
// Match the upstream coverage window when an uncovered gap reaches the overlay.
export const maxBeatGapMs = 250;
const gapFillStepMs = 50;
const gapFillCoverageMs = maxBeatGapMs / 2;

/** Explicit browser times make playback deterministic under irregular batches. */
export interface WaveBuffer {
  readonly points: OverlayWave;
  readonly receivedAtMs: number | null;
  readonly cursorAtMs: number | null;
  readonly playedAtMs: number | null;
  readonly measuredGridTimes?: ReadonlySet<number>;
}

export function emptyWaveBuffer(): WaveBuffer {
  return { points: [], receivedAtMs: null, cursorAtMs: null, playedAtMs: null };
}

/** Late pulse batches replace the covered interval, including stale gap-fill timestamps. */
export function receiveBeatWave(
  buffer: WaveBuffer,
  batch: OverlayWave,
  nowMs: number,
): WaveBuffer {
  return receiveWave(buffer, batch, nowMs, "replace");
}

/** Overlaps deduplicate; a backwards jump beyond the delay starts a new timeline. */
export function receiveWave(
  buffer: WaveBuffer,
  batch: OverlayWave,
  nowMs: number,
  overlap: "merge" | "replace" = "merge",
): WaveBuffer {
  if (batch.length === 0) return buffer;
  const previousNewest = buffer.points.at(-1)?.atMs;
  let batchOldest = Infinity;
  let batchNewest = -1;
  for (const point of batch) {
    batchOldest = Math.min(batchOldest, point.atMs);
    batchNewest = Math.max(batchNewest, point.atMs);
  }
  if (previousNewest !== undefined && previousNewest - batchNewest > delayMs) {
    buffer = emptyWaveBuffer();
  }
  const replace = overlap === "replace";
  const startsOffGrid = replace && batchOldest % gapFillStepMs !== 0;
  const offGrid = replace
    ? batch
        .filter((point) => point.atMs % gapFillStepMs !== 0)
        .sort((a, b) => a.atMs - b.atMs)
    : [];
  const lastOffGrid = offGrid.at(-1);
  // An aligned endpoint within this window must also be measured.
  const endsMeasured =
    lastOffGrid && batchNewest - lastOffGrid.atMs <= gapFillCoverageMs;
  const measuredGridTimes = replace ? new Set<number>() : undefined;
  const pointsByTime = new Map<number, OverlayWavePoint>();
  for (const point of buffer.points) {
    const measured = buffer.measuredGridTimes?.has(point.atMs);
    // A late SDK point also supersedes provisional fill outside the batch.
    const staleEdgeFill =
      !measured &&
      point.atMs % gapFillStepMs === 0 &&
      ((startsOffGrid &&
        point.atMs < batchOldest &&
        batchOldest - point.atMs <= gapFillCoverageMs) ||
        (endsMeasured &&
          point.atMs > batchNewest &&
          point.atMs - batchNewest <= gapFillCoverageMs));
    const covered =
      replace && point.atMs >= batchOldest && point.atMs <= batchNewest;
    if (covered || staleEdgeFill) continue;
    pointsByTime.set(point.atMs, point);
    if (measured) measuredGridTimes?.add(point.atMs);
  }
  for (const point of batch) {
    pointsByTime.set(point.atMs, { v: point.v, atMs: point.atMs });
    if (measuredGridTimes && point.atMs % gapFillStepMs === 0) {
      // Fill cannot occur within 125 ms of a measured point in this batch.
      const left = point.atMs - gapFillCoverageMs;
      const nearby = offGrid[pointIndex(offGrid, left, false)];
      if (nearby && nearby.atMs <= point.atMs + gapFillCoverageMs)
        measuredGridTimes.add(point.atMs);
    }
  }
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
  const points = sorted
    .filter((point) => point.atMs >= newest.atMs - historyMs)
    .slice(-maxPoints);
  const oldest = points[0]?.atMs ?? Infinity;
  if (measuredGridTimes) {
    for (const atMs of measuredGridTimes) {
      if (atMs < oldest) measuredGridTimes.delete(atMs);
    }
  }
  return {
    points,
    ...(measuredGridTimes?.size ? { measuredGridTimes } : {}),
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

function pointIndex(points: OverlayWave, atMs: number, after: boolean): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const point = points[mid];
    if (point && (point.atMs < atMs || (after && point.atMs === atMs)))
      lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Report only confirmed peaks, including the end of a flat-topped peak. */
export function visitBeatPeaks(
  points: OverlayWave,
  afterMs: number,
  throughMs: number,
  visit: (atMs: number) => void,
): void {
  const start = Math.max(1, pointIndex(points, afterMs, true));
  for (let i = start; i < points.length - 1; i += 1) {
    const peak = points[i];
    const following = points[i + 1];
    if (!peak || !following || peak.atMs > throughMs) break;
    if (peak.v <= following.v || following.atMs - peak.atMs > maxBeatGapMs)
      continue;
    let edge = peak;
    for (let j = i - 1; j >= 0; j -= 1) {
      const preceding = points[j];
      if (!preceding || edge.atMs - preceding.atMs > maxBeatGapMs) break;
      if (preceding.v !== peak.v) {
        if (preceding.v < peak.v) visit(peak.atMs);
        break;
      }
      edge = preceding;
    }
  }
}

/** A range into the retained samples so drawing the trace needs no point copy. */
export interface WaveSpan {
  readonly points: OverlayWave;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly cursorAtMs: number;
  readonly durationMs: number;
}

/** Use only supplied samples, including at the ends of the scrolling window. */
export function pulseTraceSpan(buffer: WaveBuffer): WaveSpan | null {
  const cursor = buffer.cursorAtMs;
  if (cursor === null) return null;
  const fromIndex = pointIndex(buffer.points, cursor - pulseTraceMs, false);
  const toIndex = pointIndex(buffer.points, cursor, true);
  return toIndex - fromIndex > 1
    ? {
        points: buffer.points,
        fromIndex,
        toIndex,
        cursorAtMs: cursor,
        durationMs: pulseTraceMs,
      }
    : null;
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

/** Absorb ordinary jitter gently and catch up before accelerated replay drops history. */
export function playWave(
  buffer: WaveBuffer,
  nowMs: number,
  replayThroughMs?: number,
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
  const replay = replayThroughMs !== undefined;
  // A slow replay stretches the gaps between batches. Prefer the recording's
  // observed progress and still fade if both waves stop arriving altogether.
  const signalAge = replay
    ? Math.max(replayThroughMs - newest.atMs, age * minReplaySpeed)
    : age;
  // Wall time predicts the live stream. Replay can run at any rate, so
  // advance only as far as the delayed data allows, holding between batches.
  const target = newest.atMs - delayMs + (replay ? 0 : age);
  const next = buffer.cursorAtMs + elapsed;
  const lag = target - next;
  const normalCorrection = elapsed * 0.15;
  const catchUp = (lag - delayMs) * Math.min(1, elapsed / catchUpMs);
  const correction = Math.max(
    replay ? -elapsed : -normalCorrection,
    Math.min(Math.max(normalCorrection, catchUp), lag),
  );
  const cursorAtMs = lag > maxPlaybackLagMs ? target : next + correction;
  return {
    buffer: { ...buffer, cursorAtMs, playedAtMs: nowMs },
    value: interpolateWave(buffer.points, cursorAtMs),
    opacity: 1 - smoothStep((signalAge - 3_000) / restMs),
  };
}

/** A trailing six-second segment, clipped to the delayed playback cursor. */
export function waveTrail(buffer: WaveBuffer): OverlayWave {
  const cursor = buffer.cursorAtMs;
  if (cursor === null || buffer.points.length === 0) return [];
  const start = Math.max(buffer.points[0]?.atMs ?? 0, cursor - breathTrailMs);
  if (start > cursor) return [];
  const points: OverlayWavePoint[] = [
    { atMs: start, v: interpolateWave(buffer.points, start) },
  ];
  for (
    let i = pointIndex(buffer.points, start, true);
    i < buffer.points.length;
    i += 1
  ) {
    const point = buffer.points[i];
    if (!point || point.atMs >= cursor) break;
    points.push(point);
  }
  if (cursor > start)
    points.push({ atMs: cursor, v: interpolateWave(buffer.points, cursor) });
  return points;
}

export function breathTrailSpan(buffer: WaveBuffer): WaveSpan | null {
  if (buffer.cursorAtMs === null) return null;
  const points = waveTrail(buffer);
  return points.length > 1
    ? {
        points,
        fromIndex: 0,
        toIndex: points.length,
        cursorAtMs: buffer.cursorAtMs,
        durationMs: breathTrailMs,
      }
    : null;
}
