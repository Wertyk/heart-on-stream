import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { analyzeRecording } from "../scripts/tune-report";
import { StreamSession } from "../src/application/use-cases/stream-session";
import { IpcSignalSource } from "../src/infrastructure/ipc/ipc-signal-source";
import { JsonlReplaySource } from "../src/infrastructure/replay/jsonl-replay-source";
import {
  decodeJsonlSession,
  encodeJsonlSession,
} from "../src/infrastructure/replay/jsonl-session";
import { JsonlSessionRecorder } from "../src/infrastructure/replay/jsonl-session-recorder";
import { mapProcessingEvent } from "../src/infrastructure/smartspectra/metrics-mapper";
import { at, fixture, pulse, pulses, quickPolicy } from "./application/fakes";

const cli = fileURLToPath(new URL("../scripts/tune.mjs", import.meta.url));
const synthetic = fileURLToPath(
  new URL("fixtures/replay/synthetic-spike.jsonl", import.meta.url),
);
const sample = (name: string) =>
  fileURLToPath(new URL(`../samples/${name}.jsonl`, import.meta.url));

function tune(...args: string[]): string {
  return execFileSync(process.execPath, [cli, "--", ...args], {
    encoding: "utf8",
  });
}

function analyzeSample(name: string) {
  const recording = decodeJsonlSession(readFileSync(sample(name), "utf8"));
  return analyzeRecording(recording.frames);
}

describe("tune CLI", () => {
  it("prints reproducible phases, baseline, spike, pauses and counts for multiple files", () => {
    const placeholder = sample("live-b-virtual-camera-placeholder");
    const output = tune(synthetic, placeholder);
    expect(tune(synthetic, placeholder)).toBe(output);
    expect(output).toContain(
      "  Phases\n    0.000s warming\n    12.000s baselining\n    37.000s live",
    );
    expect(output).toContain("12.000s 70.00 BPM");
    expect(output).toContain(
      "90.000s delta +18.00 BPM, baseline 70.00 BPM, short 88.00 BPM (threshold 15.00 BPM)",
    );
    expect(output).toContain("  Pauses\n    none");
    expect(output).toContain("121 valid, 0 invalid");
    expect(output).toContain("2.734s to 439.433s (end of recording) tooDark");
    expect(output).toContain("0 valid, 0 invalid");
  });

  it("applies a delta override to both the domain detector and policy output", () => {
    const output = tune("--spike-delta=19", synthetic);
    expect(output).toContain("--spike-delta=19");
    expect(output).toContain("  Spikes\n    none");
    expect(output).toContain("peak delta minus applicable threshold -1.00 BPM");
  });

  it("reports invalid flags and exits with an error", () => {
    const result = spawnSync(
      process.execPath,
      [cli, "--spike-delta=", synthetic],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid policy flag --spike-delta=");
  });
});

it.each(["startup", "shutdown"] as const)(
  "treats SDK processing status 0 at %s like an ordinary processing status",
  async (when) => {
    const run = async (status: number) => {
      const { session } = fixture({ policy: quickPolicy });
      await session.startSession({
        consentRecorded: true,
        privacyMode: "vibe",
      });
      if (when === "startup") {
        await session.ingestFrame(mapProcessingEvent(status, at(0)));
        await session.ingestFrame(mapProcessingEvent(3, at(1)));
      }
      await session.ingestFrame(pulse(1));
      await session.ingestFrame(pulse(2, 82));
      if (when === "shutdown")
        await session.ingestFrame(mapProcessingEvent(status, at(3)));
      await session.ingestFrame(pulse(3, 82));
      return {
        start: session.sessionStartedAt,
        phase: session.panelState.phase,
        highlights: session.currentHighlights,
      };
    };
    const expected = await run(1);
    expect(expected.highlights).toHaveLength(1);
    expect(await run(0)).toEqual(expected);
  },
);

it("replays v1 uninitialized processing as an ordinary status", async () => {
  const frames = [
    mapProcessingEvent(0, at(0)),
    pulse(0),
    pulse(1, 82),
    mapProcessingEvent(0, at(2)),
    pulse(2, 82),
  ];
  const jsonl = encodeJsonlSession({
    header: {
      format: "heart-on-stream",
      version: 1,
      appVersion: "test",
      metricConfig: "a",
      startTimeUs: at(0),
    },
    frames,
  });
  const directory = mkdtempSync(join(tmpdir(), "heart-v1-processing-"));
  try {
    const path = join(directory, "session.jsonl");
    writeFileSync(path, jsonl);
    vi.useFakeTimers();
    const ports = fixture();
    const source = new JsonlReplaySource(path, { speed: 20 });
    const replay = new StreamSession(
      { ...ports, source },
      { replay: true, policy: quickPolicy },
    );
    await replay.startSession({ consentRecorded: true, privacyMode: "vibe" });
    await vi.runAllTimersAsync();
    await replay.stopSession();
    expect(replay.sessionDurationMs).toBe(2_000);
    expect(replay.currentHighlights).toMatchObject([
      { t: at(2), sessionOffsetUs: 2_000_000 },
    ]);
    const decoded = decodeJsonlSession(jsonl);
    expect(decoded.frames).toEqual(frames);
    const report = analyzeRecording(decoded.frames, quickPolicy);
    expect(report.pauses).toEqual([]);
    expect(report.spikes.map(({ spike }) => spike.t)).toEqual([at(2)]);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps live highlights across a recorded 43–200 s capture gap in replay and tune", async () => {
  const mode = { consentRecorded: true, privacyMode: "vibe" } as const;
  const live = fixture();
  await live.session.startSession({ ...mode, recordingEnabled: true });
  await pulses(live.session, 0, 43);
  live.clock.value = at(43);
  await live.session.setPaused(true);
  live.clock.value = at(200);
  await live.session.setPaused(false);
  await pulses(live.session, 200, 218, 90);
  await live.session.stopSession();
  expect(live.highlights.items).toHaveLength(1);
  const frames = live.recorder.files[0] ?? [];
  expect(frames.filter(({ kind }) => kind === "capture")).toEqual([
    { kind: "capture", state: "paused", t: at(43) },
    { kind: "capture", state: "resumed", t: at(200) },
  ]);
  const jsonl = encodeJsonlSession({
    header: {
      format: "heart-on-stream",
      version: 2,
      appVersion: "test",
      metricConfig: "a",
      startTimeUs: at(0),
    },
    frames,
  });
  const directory = mkdtempSync(join(tmpdir(), "heart-capture-gap-"));
  try {
    const path = join(directory, "session.jsonl");
    writeFileSync(path, jsonl);
    vi.useFakeTimers();
    const ports = fixture();
    const source = new JsonlReplaySource(path, { speed: 20 });
    const replay = new StreamSession({ ...ports, source }, { replay: true });
    await replay.startSession(mode);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(replay.panelState).toMatchObject({
      phase: "paused",
      baselineBpm: 70,
    });
    await vi.runAllTimersAsync();
    await replay.stopSession();
    expect(ports.highlights.items).toEqual(live.highlights.items);
    const report = analyzeRecording(decodeJsonlSession(jsonl).frames);
    expect(report.pauses).toMatchObject([{ start: 43, end: 200 }]);
    expect(report.spikes.map(({ spike }) => spike.t)).toEqual(
      live.highlights.items.map(({ t }) => t),
    );
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("ends the recording at Off before shutdown frames can reach replay or tune", async () => {
  const mode = { consentRecorded: true, privacyMode: "numbers" } as const;
  const directory = mkdtempSync(join(tmpdir(), "heart-off-"));
  const recorder = new JsonlSessionRecorder(directory, {
    appVersion: "test",
    metricConfig: "a",
    startTimeUs: at(0),
  });
  const live = fixture();
  const session = new StreamSession({ ...live, recorder });
  try {
    await session.startSession({ ...mode, recordingEnabled: true });
    await pulses(session, 0, 45);
    await pulses(session, 46, 49, 86);
    const path = recorder.filePath;
    if (path === null) throw new Error("Missing recording");
    const beforeOff = decodeJsonlSession(readFileSync(path, "utf8"));
    live.clock.value = at(50);
    const off = session.withdrawSharing();
    expect(live.publisher.states.at(-1)).toEqual({
      mode: "off",
      replay: false,
    });
    live.clock.value = at(51);
    const shutdown = [mapProcessingEvent(0, at(51)), pulse(51, 90)];
    for (const frame of shutdown) live.source.emit(frame);
    await off;
    await session.whenIdle();
    const boundary = { kind: "end", durationUs: 50_000_000 };
    const atOff = decodeJsonlSession(readFileSync(path, "utf8"));
    expect.soft(atOff.frames.at(-1)).toEqual(boundary);

    await session.stopSession();
    expect(live.highlights.items).toEqual([]);
    expect(live.marker.labels).toEqual([]);
    const { frames } = decodeJsonlSession(readFileSync(path, "utf8"));
    expect
      .soft(frames.filter(({ kind }) => kind === "end"))
      .toEqual([boundary]);
    for (const frame of shutdown) expect.soft(frames).not.toContainEqual(frame);
    // A control without the boundary confirms that the shutdown pulse completes the spike.
    expect(
      analyzeRecording([...beforeOff.frames, ...shutdown]).spikes.map(
        ({ spike }) => spike.t,
      ),
    ).toEqual([at(51)]);
    expect.soft(tune(path)).toContain("  Spikes\n    none");

    vi.useFakeTimers();
    const ports = fixture();
    const source = new JsonlReplaySource(path, { speed: 20 });
    const replay = new StreamSession({ ...ports, source }, { replay: true });
    await replay.startSession(mode);
    await vi.runAllTimersAsync();
    await replay.stopSession();
    expect.soft(ports.highlights.items).toEqual([]);
    expect(ports.publisher.states).not.toContainEqual(
      expect.objectContaining({ mode: "numbers", pulseBpm: 90 }),
    );
  } finally {
    vi.useRealTimers();
    await session.stopSession();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps the strong sample's confirming pulse recorder-only after live End and in replay and tune", async () => {
  const mode = { consentRecorded: true, privacyMode: "numbers" } as const;
  const { header, frames } = decodeJsonlSession(
    readFileSync(sample("live-b-exertion-strong"), "utf8"),
  );
  const [confirmation] = analyzeRecording(frames).spikes;
  expect(confirmation?.seconds).toBeCloseTo(207.878, 3);
  const index = frames.findIndex(
    (frame) =>
      frame.kind === "pulseRate" && frame.reading.t === confirmation?.spike.t,
  );
  const confirmingPulse = frames[index];
  if (confirmingPulse?.kind !== "pulseRate")
    throw new Error("Missing confirming pulse in the reference recording");
  const finalTime = confirmingPulse.reading.t + 2_000_000;
  const tailPulse = pulse(0, 109, { t: finalTime });
  const directory = mkdtempSync(join(tmpdir(), "heart-end-drain-"));
  const recorder = new JsonlSessionRecorder(directory, header);
  const live = fixture();
  const ipc = new EventEmitter();
  const session = new StreamSession({
    ...live,
    source: new IpcSignalSource(ipc, () => true),
    recorder,
  });
  const push = (frame: (typeof frames)[number]) =>
    ipc.emit("frame:push", null, {
      frame,
      captureGeneration: session.captureGeneration,
    });
  try {
    live.clock.value = header.startTimeUs;
    await session.startSession({ ...mode, recordingEnabled: true });
    for (const frame of frames.slice(0, index)) push(frame);
    await session.whenIdle();
    expect(session.panelState.phase).toBe("live");

    live.clock.value = confirmingPulse.reading.t - 1;
    const endNotice = session.withdrawSharing("drain");
    push(confirmingPulse);
    await session.withdrawSharing("drain");
    push(tailPulse);
    await endNotice;
    await session.stopSession();

    expect(session.currentHighlights).toEqual([]);
    expect(live.marker.labels).toEqual([]);
    expect(live.publisher.states.at(-1)).toEqual({
      mode: "off",
      replay: false,
    });
    const path = recorder.filePath;
    if (path === null) throw new Error("Missing recording");
    const recording = decodeJsonlSession(readFileSync(path, "utf8"));
    const startedAt = session.sessionStartedAt;
    if (startedAt === null) throw new Error("Missing live measurement origin");
    const durationUs = finalTime - startedAt;
    expect(session.sessionDurationMs).toBe(durationUs / 1_000);
    expect
      .soft(recording.frames.slice(index))
      .toEqual([
        { kind: "drain" },
        confirmingPulse,
        tailPulse,
        { kind: "end", durationUs },
      ]);
    const report = analyzeRecording(recording.frames);
    expect.soft(report.spikes).toEqual([]);
    expect(report).toEqual({
      ...analyzeRecording(frames.slice(0, index)),
      lastSeconds: durationUs / 1_000_000,
    });
    expect.soft(tune(path)).toContain("  Spikes\n    none");

    const tasks: { run: () => void; delay: number }[] = [];
    const source = new JsonlReplaySource(path, {
      scheduler: {
        nowMs: () => 0,
        schedule(run, delay) {
          tasks.push({ run, delay });
          return () => {};
        },
      },
      onEnd: () => void replay.stopSession(),
    });
    const ports = fixture();
    const replay = new StreamSession({ ...ports, source }, { replay: true });
    await replay.startSession(mode);
    const completion = tasks.at(-1);
    expect(completion?.delay).toBe(durationUs / 1_000);
    for (const task of tasks.slice(0, -2)) task.run();
    await replay.whenIdle();
    expect(replay.panelState.active).toBe(true);
    for (const task of tasks.slice(-2)) task.run();
    await replay.whenIdle();
    expect(replay.panelState.active).toBe(false);
    expect(replay.sessionDurationMs).toBe(session.sessionDurationMs);
    expect.soft(replay.currentHighlights).toEqual([]);
    expect.soft(ports.marker.labels).toEqual([]);
    expect(
      ports.publisher.states.some(
        (state) => state.mode === "numbers" && state.pulseBpm === 109,
      ),
    ).toBe(false);
  } finally {
    await session.stopSession();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

it("matches live duration and chapter export when replay ends without a frame after Resume", async () => {
  const mode = { consentRecorded: true, privacyMode: "vibe" } as const;
  const unavailable = {
    status: "unavailable",
    reason: "disconnected",
  } as const;
  const directory = mkdtempSync(join(tmpdir(), "heart-final-gap-"));
  const recorder = new JsonlSessionRecorder(directory, {
    appVersion: "test",
    metricConfig: "a",
    startTimeUs: at(0),
  });
  try {
    const live = fixture();
    live.marker.results.push(unavailable, unavailable);
    const session = new StreamSession(
      { ...live, recorder },
      { policy: quickPolicy },
    );
    await session.startSession({ ...mode, recordingEnabled: true });
    await pulses(session, 0, 18);
    await pulses(session, 19, 20, 82);
    await pulses(session, 21, 58);
    await pulses(session, 59, 60, 82);
    live.clock.value = at(60);
    await session.setPaused(true);
    live.clock.value = at(80);
    await session.setPaused(false);
    live.clock.value = at(81);
    await session.stopSession();
    expect(session.sessionDurationMs).toBe(81_000);
    const chapters = await session.exportChapters();
    expect(chapters).toEqual({
      ok: true,
      text: "00:00 Intro\n00:20 spike +12 vs baseline\n01:00 spike +12 vs baseline",
    });
    if (recorder.filePath === null) throw new Error("Missing recording");

    vi.useFakeTimers();
    const ports = fixture();
    ports.marker.results.push(unavailable, unavailable);
    const source = new JsonlReplaySource(recorder.filePath, {
      speed: 20,
      onEnd: () => {
        void replay.stopSession();
      },
    });
    const replay = new StreamSession(
      { ...ports, source },
      { replay: true, policy: quickPolicy },
    );
    await replay.startSession(mode);
    await vi.advanceTimersByTimeAsync(4_049);
    expect(replay.panelState.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await replay.whenIdle();
    expect(replay.panelState.active).toBe(false);
    expect(replay.currentHighlights).toEqual(session.currentHighlights);
    expect(replay.sessionDurationMs).toBe(session.sessionDurationMs);
    expect(await replay.exportChapters()).toEqual(chapters);
    expect(replay.panelState.t).toBe(at(60));
    const recording = decodeJsonlSession(
      readFileSync(recorder.filePath, "utf8"),
    );
    expect(recording.frames.at(-1)).toEqual({
      kind: "end",
      durationUs: 81_000_000,
    });
    expect(analyzeRecording(recording.frames, quickPolicy).lastSeconds).toBe(
      81,
    );
  } finally {
    vi.useRealTimers();
    await recorder.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("calibrated policy on reference recordings", () => {
  it.each([
    "live-a-framing-talking",
    "live-b-calm",
    "live-b-calm-obs-shared-camera",
  ])("reaches live detection without a spike in %s", (name) => {
    const report = analyzeSample(name);
    expect(report.phases.map(({ phase }) => phase)).toContain("live");
    expect(report.maxCandidateSeconds).toBeLessThan(3);
    expect(report.spikes).toEqual([]);
  });

  it("pauses for motion and emits zero spikes through seated recovery and talking", () => {
    const report = analyzeSample("live-b-exertion-talking");
    expect(
      report.phases.find(({ phase }) => phase === "live")?.seconds,
    ).toBeLessThan(127);
    expect(report.pauses).toContainEqual({
      start: expect.closeTo(129.738, 3),
      end: expect.closeTo(150.08, 3),
      reasons: new Set(["excessiveMotion"]),
    });
    expect(report.spikes).toEqual([]);
  });

  it("detects one spike in the seated recovery after strong exertion", () => {
    const report = analyzeSample("live-b-exertion-strong");
    expect(report.pauses).toContainEqual({
      start: expect.closeTo(79.498, 3),
      end: expect.closeTo(112.204, 3),
      reasons: new Set(["excessiveMotion", "chestNotVisible"]),
    });
    expect(report.spikes).toMatchObject([
      {
        seconds: expect.closeTo(207.878, 3),
        spike: { deltaBpm: expect.closeTo(22.2, 2) },
        comparison: { baselineBpm: expect.closeTo(83.28, 2) },
      },
    ]);
  });

  it.each([
    [1_795_019_696_954_400, 1_795_019_700_624_400],
    [1_795_019_705_457_000, 1_795_019_707_524_200],
  ])(
    "has no recorded biometrics within the audited interval starting at %s",
    (from, until) => {
      const { header, frames } = decodeJsonlSession(
        readFileSync(sample("live-b-exertion-recovery"), "utf8"),
      );
      const inInterval = (t: number) => t >= from && t < until;
      expect(header.version).toBe(2);
      expect(
        frames.filter((frame) => {
          switch (frame.kind) {
            case "pulseRate":
            case "breathingRate":
              return inInterval(frame.reading.t);
            case "talking":
              return inInterval(frame.t);
            case "pulseWave":
            case "breathingWave":
              return frame.samples.some(({ t }) => inInterval(t));
            default:
              return false;
          }
        }),
      ).toHaveLength(0);
    },
  );

  it("replays capture boundaries and second-face pauses and detects one spike in the still recovery", () => {
    const { header, frames } = decodeJsonlSession(
      readFileSync(sample("live-b-exertion-recovery"), "utf8"),
    );
    expect(frames).toHaveLength(74_573);
    expect(
      frames.flatMap((frame) =>
        frame.kind === "capture"
          ? [[frame.state, (frame.t - header.startTimeUs) / 1_000_000]]
          : [],
      ),
    ).toEqual([
      ["paused", 58.3683],
      ["resumed", 59.714],
      ["paused", 194.7465],
      ["resumed", 285.905],
      ["paused", 296.868],
      ["resumed", 298.1],
      ["paused", 324.3356],
      ["resumed", 325.567],
      ["paused", 343.5505],
      ["resumed", 344.658],
      ["paused", 374.6262],
      ["resumed", 375.385],
    ]);

    const report = analyzeRecording(frames);
    expect(report.lastSeconds).toBe(951.739);
    expect(report.pauses).toContainEqual({
      start: 191.4585,
      end: 282.617,
      reasons: new Set(["chestNotVisible"]),
    });
    expect(
      report.pauses.filter(({ reasons }) => reasons.has("multipleFacesFound")),
    ).toEqual([
      {
        start: 465.1524,
        end: 468.8224,
        reasons: new Set(["multipleFacesFound"]),
      },
      {
        start: 473.655,
        end: 475.7222,
        reasons: new Set(["multipleFacesFound"]),
      },
    ]);
    expect(report.spikes).toMatchObject([
      {
        seconds: expect.closeTo(745.814, 3),
        spike: { deltaBpm: expect.closeTo(26.89, 2) },
        comparison: { baselineBpm: expect.closeTo(74.82, 2) },
      },
    ]);
  });

  it("stays paused for tooDark when the virtual camera has no readings", () => {
    const report = analyzeSample("live-b-virtual-camera-placeholder");
    expect(report.pauses).toEqual([
      {
        start: expect.closeTo(2.734, 3),
        end: null,
        reasons: new Set(["tooDark"]),
      },
    ]);
    expect(report.phases.at(-1)?.phase).toBe("paused");
    expect(report.valid + report.invalid).toBe(0);
    expect(report.spikes).toEqual([]);
  });
});
