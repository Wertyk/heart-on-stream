import type { SessionRecord } from "../../domain/session/index";
import type {
  ProcessingStatus,
  Reading,
  SignalFrame,
  ValidationCode,
  WaveSample,
} from "../../domain/signal/index";

/** Metadata is supplied by the caller when recording is explicitly enabled. */
export interface SessionMetadata {
  readonly appVersion: string;
  readonly metricConfig: string;
  readonly startTimeUs: number;
}

/** Identifies the numeric/status-only session wire format independently of app versions. */
export interface SessionHeader extends SessionMetadata {
  readonly format: "heart-on-stream";
  readonly version: 1 | 2;
}

/** A decoded recording retains delivery order, including waveform batch boundaries. */
export interface JsonlSession {
  readonly header: SessionHeader;
  readonly frames: readonly SessionRecord[];
}

const currentVersion = 2;

const validationCodes = [
  "ok",
  "noFaceFound",
  "multipleFacesFound",
  "faceNotCentered",
  "faceSizeOutOfRange",
  "tooDark",
  "tooBright",
  "chestNotVisible",
  "cameraTuning",
  "frameRateTooLow",
  "excessiveMotion",
  "faceTooClose",
  "faceTooFar",
  "faceTooHigh",
  "faceTooLow",
  "faceNotForward",
] as const satisfies readonly ValidationCode[];

const processingStatuses = [
  "uninitialized",
  "idle",
  "starting",
  "running",
  "stopping",
  "error",
] as const satisfies readonly ProcessingStatus[];

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("expected an object");
  }
  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) fail(`missing field '${field}'`);
  }
  for (const field of Object.keys(value)) {
    if (!expected.includes(field)) fail(`unexpected field '${field}'`);
  }
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`'${field}' must be a finite number`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result))
    fail(`'${field}' must be safe integer microseconds`);
  return result;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`'${field}' must be a string`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`'${field}' must be a boolean`);
  return value;
}

function member<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  const result = values.find((candidate) => candidate === value);
  if (result === undefined) fail(`unknown '${field}'`);
  return result;
}

function parseHeader(value: unknown): SessionHeader {
  const header = object(value);
  fields(header, [
    "format",
    "version",
    "appVersion",
    "metricConfig",
    "startTimeUs",
  ]);
  if (header.format !== "heart-on-stream") fail("unknown session format");
  if (header.version !== 1 && header.version !== currentVersion)
    fail("unsupported session version (expected 1 or 2)");
  return {
    format: "heart-on-stream",
    version: header.version,
    appVersion: string(header.appVersion, "appVersion"),
    metricConfig: string(header.metricConfig, "metricConfig"),
    startTimeUs: timestamp(header.startTimeUs, "startTimeUs"),
  };
}

function parseSample(value: unknown): WaveSample {
  const sample = object(value);
  fields(sample, ["value", "stable", "t"]);
  return {
    value: number(sample.value, "value"),
    stable: boolean(sample.stable, "stable"),
    t: timestamp(sample.t, "t"),
  };
}

function parseReading(value: unknown): Reading {
  const reading = object(value);
  fields(reading, ["value", "confidence", "stable", "t"]);
  return {
    value: number(reading.value, "value"),
    confidence: number(reading.confidence, "confidence"),
    stable: boolean(reading.stable, "stable"),
    t: timestamp(reading.t, "t"),
  };
}

/** Validates SDK frames at the live IPC boundary and in recordings. */
export function parseSignalFrame(value: unknown): SignalFrame {
  const frame = object(value);
  switch (frame.kind) {
    case "pulseRate":
    case "breathingRate":
      fields(frame, ["kind", "reading"]);
      return { kind: frame.kind, reading: parseReading(frame.reading) };
    case "pulseWave":
    case "breathingWave": {
      fields(frame, ["kind", "samples"]);
      if (!Array.isArray(frame.samples)) fail("'samples' must be an array");
      return { kind: frame.kind, samples: frame.samples.map(parseSample) };
    }
    case "talking":
      fields(frame, ["kind", "t", "detected", "stable"]);
      return {
        kind: "talking",
        t: timestamp(frame.t, "t"),
        detected: boolean(frame.detected, "detected"),
        stable: boolean(frame.stable, "stable"),
      };
    case "validation":
      fields(frame, ["kind", "t", "code", "hint"]);
      return {
        kind: "validation",
        t: timestamp(frame.t, "t"),
        code: member(frame.code, validationCodes, "code"),
        hint: string(frame.hint, "hint"),
      };
    case "processing":
      fields(frame, ["kind", "t", "status"]);
      return {
        kind: "processing",
        t: timestamp(frame.t, "t"),
        status: member(frame.status, processingStatuses, "status"),
      };
    default:
      return fail("unknown frame kind");
  }
}

function parseSessionRecord(
  value: unknown,
  version: SessionHeader["version"],
  isLast: boolean,
): SessionRecord {
  const frame = object(value);
  if (version === 2 && frame.kind === "capture") {
    fields(frame, ["kind", "t", "state"]);
    return {
      kind: "capture",
      t: timestamp(frame.t, "t"),
      state: member(frame.state, ["paused", "resumed"], "state"),
    };
  }
  if (version === 2 && frame.kind === "drain") {
    fields(frame, ["kind"]);
    return { kind: "drain" };
  }
  if (version === 2 && frame.kind === "end") {
    if (!isLast) fail("end record must be last");
    fields(frame, ["kind", "durationUs"]);
    const durationUs = timestamp(frame.durationUs, "durationUs");
    if (durationUs < 0) fail("'durationUs' must be nonnegative");
    return { kind: "end", durationUs };
  }
  return parseSignalFrame(frame);
}

/** Only SDK frames and the end record can follow the drain boundary. */
export function validateDrainPlacement(
  kind: SessionRecord["kind"],
  afterDrain: boolean,
): void {
  if (!afterDrain) return;
  if (kind === "drain") fail("duplicate drain boundary");
  if (kind === "capture") fail("capture record after drain boundary");
}

function atLine<T>(line: number, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new Error(
      `JSONL line ${line}: ${error instanceof Error ? error.message : "invalid record"}`,
    );
  }
}

/** Each encoded record ends in LF so an interrupted final write is detectable. */
export function encodeSessionHeader(metadata: SessionMetadata): string {
  return atLine(
    1,
    () =>
      `${JSON.stringify(parseHeader({ ...metadata, format: "heart-on-stream", version: currentVersion }))}\n`,
  );
}

function parseSessionRecords<T>(
  values: readonly T[],
  version: SessionHeader["version"],
  read: (value: T) => unknown,
): SessionRecord[] {
  let afterDrain = false;
  return values.map((value, index) =>
    atLine(index + 2, () => {
      const record = parseSessionRecord(
        read(value),
        version,
        index === values.length - 1,
      );
      validateDrainPlacement(record.kind, afterDrain);
      afterDrain ||= record.kind === "drain";
      return record;
    }),
  );
}

/** Validates one record for the current streaming format before writing it. */
export function encodeSignalFrame(record: SessionRecord, line = 2): string {
  return atLine(
    line,
    () =>
      `${JSON.stringify(parseSessionRecord(record, currentVersion, true))}\n`,
  );
}

/** Pure whole-session encoder, shared by fixtures and non-streaming callers. */
export function encodeJsonlSession(session: JsonlSession): string {
  const header = atLine(1, () => parseHeader(session.header));
  const frames = parseSessionRecords(session.frames, header.version, (x) => x);
  return `${JSON.stringify(header)}\n${frames
    .map((frame) => `${JSON.stringify(frame)}\n`)
    .join("")}`;
}

/**
 * Strict v1 and v2 reader with one-based line errors. Accepts LF and CRLF.
 * Requires a final newline, including for header-only sessions.
 */
export function decodeJsonlSession(input: string): JsonlSession {
  if (input.length === 0) fail("JSONL line 1: missing session header");
  const lines = input.split("\n");
  if (lines.pop() !== "")
    fail(`JSONL line ${lines.length + 1}: truncated record (missing newline)`);
  const header = atLine(1, () => parseHeader(JSON.parse(lines[0] ?? "")));
  const frames = parseSessionRecords(
    lines.slice(1),
    header.version,
    JSON.parse,
  );
  return { header, frames };
}
