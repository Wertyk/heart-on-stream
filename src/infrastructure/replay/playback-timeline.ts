import type { SessionRecord } from "../../domain/session/index";
import type { SessionFrame } from "../../domain/signal/index";

function firstFrameTime(frame: SessionFrame): number | null {
  if (frame.kind === "pulseWave" || frame.kind === "breathingWave")
    return frame.samples.find(({ t }) => t >= 0)?.t ?? null;
  const t =
    frame.kind === "pulseRate" || frame.kind === "breathingRate"
      ? frame.reading.t
      : frame.t;
  return t >= 0 ? t : null;
}

/** Keep the drain boundary. Tail frames only supply a fallback footer origin. */
export function playbackTimeline(records: readonly SessionRecord[]): {
  readonly frames: readonly SessionRecord[];
  readonly drainOrigin: number | null;
} {
  const frames: SessionRecord[] = [];
  let draining = false;
  let drainOrigin: number | null = null;
  for (const record of records) {
    if (record.kind === "drain") {
      draining = true;
      frames.push(record);
    } else if (draining && record.kind !== "end") {
      drainOrigin ??= firstFrameTime(record);
    } else {
      frames.push(record);
    }
  }
  return { frames, drainOrigin };
}
