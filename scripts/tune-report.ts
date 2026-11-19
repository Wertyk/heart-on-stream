import { readFileSync } from "node:fs";
import {
  createSpikePolicy,
  DEFAULT_SPIKE_POLICY,
  type PulseComparison,
  SessionMachine,
  type SessionPhase,
  type SessionRecord,
  type SpikeEvent,
  type SpikePolicy,
} from "../src/domain/session/index";
import type { ValidationCode } from "../src/domain/signal/index";
import { decodeJsonlSession } from "../src/infrastructure/replay/jsonl-session";
import { playbackTimeline } from "../src/infrastructure/replay/playback-timeline";

interface Pause {
  readonly start: number;
  end: number | null;
  readonly reasons: Set<ValidationCode>;
}

/** Run the recorded delivery order through the same session engine as live input. */
export function analyzeRecording(
  frames: readonly SessionRecord[],
  overrides: Partial<SpikePolicy> = {},
) {
  const machine = new SessionMachine(overrides);
  const phases: { seconds: number; phase: SessionPhase }[] = [];
  const baselines: { seconds: number; bpm: number | null }[] = [];
  const pauses: Pause[] = [];
  const spikes: {
    seconds: number;
    spike: SpikeEvent;
    comparison: PulseComparison;
  }[] = [];
  let valid = 0;
  let invalid = 0;
  let maxDeltaBpm: number | null = null;
  let maxThresholdMarginBpm: number | null = null;
  let maxCandidateSeconds = 0;
  let pause: Pause | undefined;
  let previous = machine.snapshot;
  let origin: number | null = null;
  let finalDurationUs: number | null = null;
  const secondsAt = (t: number | null) =>
    t === null || origin === null ? 0 : (t - origin) / 1_000_000;

  for (const frame of playbackTimeline(frames).frames) {
    if (frame.kind === "drain") continue;
    if (frame.kind === "end") {
      finalDurationUs = frame.durationUs;
      break;
    }
    const { acceptedPulse, events, snapshot } = machine.step(frame);
    if (origin === null && snapshot.startedAt !== null) {
      origin = snapshot.startedAt;
      phases.push({ seconds: 0, phase: previous.phase });
      baselines.push({ seconds: 0, bpm: previous.baselineBpm });
    }
    if (snapshot.baselineBpm !== previous.baselineBpm) {
      baselines.push({
        seconds: secondsAt(snapshot.t),
        bpm: snapshot.baselineBpm,
      });
    }
    if (frame.kind === "pulseRate") {
      if (acceptedPulse === undefined) invalid++;
      else valid++;
    }
    if (acceptedPulse !== undefined && acceptedPulse !== "calibrating") {
      const delta = acceptedPulse.shortBpm - acceptedPulse.baselineBpm;
      maxDeltaBpm = Math.max(maxDeltaBpm ?? delta, delta);
      const margin = delta - acceptedPulse.thresholdBpm;
      maxThresholdMarginBpm = Math.max(maxThresholdMarginBpm ?? margin, margin);
      maxCandidateSeconds = Math.max(
        maxCandidateSeconds,
        acceptedPulse.candidateSeconds,
      );
    }
    for (const event of events) {
      if (event.kind === "spike") {
        if (acceptedPulse !== undefined && acceptedPulse !== "calibrating") {
          spikes.push({
            seconds: secondsAt(event.t),
            spike: event,
            comparison: acceptedPulse,
          });
        }
        continue;
      }
      const seconds = secondsAt(event.t);
      phases.push({ seconds, phase: event.to });
      if (event.to === "paused") {
        pause = { start: seconds, end: null, reasons: new Set() };
        // Recovery can report both a timeout and a resumption in the same step.
        const reason = (
          snapshot.phase === "paused"
            ? snapshot.validation
            : previous.validation
        )?.code;
        if (reason && reason !== "ok") pause.reasons.add(reason);
        pauses.push(pause);
      } else if (event.from === "paused" && pause) {
        pause.end = seconds;
        pause = undefined;
      }
    }
    const reason = snapshot.validation?.code;
    if (pause && reason && reason !== "ok") pause.reasons.add(reason);
    previous = snapshot;
  }
  return {
    phases,
    baselines,
    pauses,
    spikes,
    valid,
    invalid,
    maxDeltaBpm,
    maxThresholdMarginBpm,
    maxCandidateSeconds,
    lastSeconds:
      finalDurationUs === null
        ? secondsAt(previous.t)
        : finalDurationUs / 1_000_000,
  };
}

const flags = Object.keys(DEFAULT_SPIKE_POLICY).map((key) => ({
  key: key as keyof SpikePolicy,
  flag: key
    .replace(/(Bpm|Seconds)$/, "")
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
}));

function formatReport(
  path: string,
  report: ReturnType<typeof analyzeRecording>,
): string {
  const bpm = (value: number | null) =>
    value === null ? "unavailable" : `${value.toFixed(2)} BPM`;
  const seconds = (value: number) => `${value.toFixed(3)}s`;
  return [
    path,
    "  Phases",
    ...(report.phases.length
      ? report.phases.map(
          (phase) => `    ${seconds(phase.seconds)} ${phase.phase}`,
        )
      : ["    none"]),
    "  Baseline changes",
    ...(report.baselines.length
      ? report.baselines.map(
          (point) => `    ${seconds(point.seconds)} ${bpm(point.bpm)}`,
        )
      : ["    none"]),
    "  Spikes",
    ...(report.spikes.length
      ? report.spikes.map(
          ({ seconds: t, spike, comparison }) =>
            `    ${seconds(t)} delta +${bpm(spike.deltaBpm)}, baseline ${bpm(comparison.baselineBpm)}, short ${bpm(comparison.shortBpm)} (threshold ${bpm(comparison.thresholdBpm)})`,
        )
      : ["    none"]),
    "  Pauses",
    ...(report.pauses.length
      ? report.pauses.map(
          ({ start, end, reasons }) =>
            `    ${seconds(start)} to ${seconds(end ?? report.lastSeconds)}${end === null ? " (end of recording)" : ""} ${[...reasons].join(", ")}`,
        )
      : ["    none"]),
    `  Pulse readings: ${report.valid} valid, ${report.invalid} invalid`,
    `  Live evidence: peak delta ${bpm(report.maxDeltaBpm)}, peak delta minus applicable threshold ${bpm(report.maxThresholdMarginBpm)}, longest candidate ${seconds(report.maxCandidateSeconds)}`,
  ].join("\n");
}

export function runTune(args: readonly string[]): number {
  if (args.includes("--help")) {
    console.log("Usage: pnpm tune -- [--policy-flag=value ...] <files...>");
    console.log(
      flags
        .map(({ key, flag }) => `  --${flag}=${DEFAULT_SPIKE_POLICY[key]}`)
        .join("\n"),
    );
    return 0;
  }
  try {
    const overrides: { -readonly [Key in keyof SpikePolicy]?: number } = {};
    const paths: string[] = [];
    for (const arg of args) {
      if (arg === "--") continue;
      if (!arg.startsWith("--")) {
        paths.push(arg);
        continue;
      }
      const [name, value] = arg.slice(2).split("=", 2);
      const setting = flags.find(({ flag }) => flag === name);
      if (
        !setting ||
        !value?.trim() ||
        arg.indexOf("=") !== arg.lastIndexOf("=")
      ) {
        throw new Error(`Invalid policy flag ${arg}. Use --help for options.`);
      }
      overrides[setting.key] = Number(value);
    }
    if (paths.length === 0)
      throw new Error(
        "Pass at least one JSONL recording. Use --help for usage.",
      );
    const policy = createSpikePolicy(overrides);
    console.log(
      `Policy ${flags.map(({ key, flag }) => `--${flag}=${policy[key]}`).join(" ")}`,
    );
    let exitCode = 0;
    for (const path of paths) {
      try {
        const { frames } = decodeJsonlSession(readFileSync(path, "utf8"));
        console.log(formatReport(path, analyzeRecording(frames, policy)));
      } catch (error) {
        console.error(
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        exitCode = 1;
      }
    }
    return exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
