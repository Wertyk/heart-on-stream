import type { OverlayState, OverlayWave } from "../../domain/privacy/index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWave(value: unknown): OverlayWave | null {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const point of value) {
    if (
      !isRecord(point) ||
      !isFiniteNumber(point.v) ||
      point.v < 0 ||
      point.v > 1 ||
      !isFiniteNumber(point.atMs) ||
      point.atMs < 0
    )
      return null;
    result.push({ v: point.v, atMs: point.atMs });
  }
  return result;
}

/** Validate the wire boundary and copy only allowed fields, including in Vibe. */
export function parseOverlayMessage(data: unknown): OverlayState | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.replay !== "boolean") return null;
  const { mode, replay } = value;
  if (mode === "off" || mode === "highlightsOnly") return { mode, replay };
  if (mode !== "vibe" && mode !== "numbers") return null;
  const { status, intensity } = value;
  if (status !== "live" && status !== "paused" && status !== "calibrating")
    return null;
  if (intensity !== "calm" && intensity !== "elevated" && intensity !== "spike")
    return null;
  const beatWave = parseWave(value.beatWave);
  const breathWave = parseWave(value.breathWave);
  if (!beatWave || !breathWave) return null;
  const waves = { replay, status, intensity, beatWave, breathWave } as const;
  if (mode === "vibe") return { mode, ...waves };
  const { pulseBpm, breathingRate } = value;
  if (
    pulseBpm !== null &&
    pulseBpm !== "out_of_range" &&
    !(isFiniteNumber(pulseBpm) && pulseBpm >= 40 && pulseBpm <= 110)
  )
    return null;
  if (
    breathingRate !== null &&
    !(isFiniteNumber(breathingRate) && breathingRate >= 0)
  )
    return null;
  return { mode, ...waves, pulseBpm, breathingRate };
}
