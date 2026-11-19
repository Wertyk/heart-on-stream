import type { Highlight } from "../../domain/session/index";

const fields = new Set([
  "t",
  "sessionStartedAt",
  "sessionOffsetUs",
  "recordingOffsetMs",
  "label",
  "deltaBpm",
  "talkingRecent",
]);

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validate and copy the receipt allowlist so no extra data can reach disk. */
export function parseHighlight(value: unknown): Highlight {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a highlight object");
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key))
      throw new Error(`Unexpected highlight field '${key}'`);
  }
  if (
    !("t" in value && isTime(value.t)) ||
    !("sessionStartedAt" in value && isTime(value.sessionStartedAt)) ||
    !("sessionOffsetUs" in value && isTime(value.sessionOffsetUs)) ||
    !(
      "recordingOffsetMs" in value &&
      (value.recordingOffsetMs === null ||
        isNonnegativeNumber(value.recordingOffsetMs))
    ) ||
    !(
      "label" in value &&
      typeof value.label === "string" &&
      value.label.trim().length > 0
    ) ||
    !("deltaBpm" in value && isNonnegativeNumber(value.deltaBpm)) ||
    !("talkingRecent" in value && typeof value.talkingRecent === "boolean")
  ) {
    throw new Error("Invalid highlight fields");
  }
  return {
    t: value.t,
    sessionStartedAt: value.sessionStartedAt,
    sessionOffsetUs: value.sessionOffsetUs,
    recordingOffsetMs: value.recordingOffsetMs,
    label: value.label,
    deltaBpm: value.deltaBpm,
    talkingRecent: value.talkingRecent,
  };
}

/** Corrupt receipts must fail visibly rather than being discarded on append. */
export function decodeHighlights(text: string): Highlight[] {
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values))
    throw new Error("Expected an array of highlights");
  return values.map(parseHighlight);
}
