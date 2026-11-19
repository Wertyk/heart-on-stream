import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSession } from "../../src/application/use-cases/stream-session";
import type { OverlayState } from "../../src/domain/privacy/index";
import type { SessionRecord } from "../../src/domain/session/index";
import type { SignalFrame } from "../../src/domain/signal/index";
import { JsonlReplaySource } from "../../src/infrastructure/replay/jsonl-replay-source";
import { encodeJsonlSession } from "../../src/infrastructure/replay/jsonl-session";
import {
  at,
  deferred,
  fixture,
  type MemoryHighlights,
  pulse,
  quickPolicy,
  wave,
} from "../application/fakes";
import { generateSyntheticSession } from "../fixtures/replay/generate-synthetic-session";

const frames: SignalFrame[] = [
  { kind: "processing", status: "running", t: 1_000_000 },
  {
    kind: "pulseRate",
    reading: { t: 2_000_000, value: 70, stable: true, confidence: 95 },
  },
  { kind: "pulseWave", samples: [{ t: 3_000_000, value: 0.3, stable: true }] },
];
const encoded = () =>
  encodeJsonlSession({
    header: {
      format: "heart-on-stream",
      version: 1,
      appVersion: "test",
      metricConfig: "synthetic",
      startTimeUs: 1_000_000,
    },
    frames,
  });
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hos-replay-"));
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
async function file(input = encoded()): Promise<string> {
  const path = join(directory, "session.jsonl");
  await writeFile(path, input);
  return path;
}

function v2(records: readonly SessionRecord[]): string {
  return encodeJsonlSession({
    header: {
      format: "heart-on-stream",
      version: 2,
      appVersion: "test",
      metricConfig: "synthetic",
      startTimeUs: 0,
    },
    frames: records,
  });
}

describe("JSONL replay", () => {
  it.each([0.25, 1, 2, 20])(
    "preserves timestamps and relative timing at speed %s",
    async (speed) => {
      const onEnd = vi.fn();
      const source = new JsonlReplaySource(await file(), { speed, onEnd });
      const received = vi.fn();
      source.subscribe(received);
      await source.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(received.mock.calls).toEqual([[frames[0]]]);
      await vi.advanceTimersByTimeAsync(1000 / speed - 1);
      expect(received).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(received.mock.calls).toEqual([[frames[0]], [frames[1]]]);
      expect(onEnd).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000 / speed);
      expect(received.mock.calls).toEqual(frames.map((frame) => [frame]));
      expect(onEnd).toHaveBeenCalledOnce();
      await source.stop();
      await vi.runAllTimersAsync();
      expect(onEnd).toHaveBeenCalledOnce();
    },
  );

  it("ends at 120 s when playback starts 60 s before the measurement origin", async () => {
    const records: SessionRecord[] = [
      { kind: "capture", state: "paused", t: 0 },
      { kind: "capture", state: "resumed", t: 60_000_000 },
      {
        kind: "pulseRate",
        reading: { t: 60_000_000, value: 70, stable: true, confidence: 95 },
      },
      { kind: "capture", state: "paused", t: 70_000_000 },
      { kind: "end", durationUs: 60_000_000 },
    ];
    const onEnd = vi.fn();
    const received = vi.fn();
    const source = new JsonlReplaySource(await file(v2(records)), { onEnd });
    source.subscribe(received);
    await source.start();
    await vi.advanceTimersByTimeAsync(70_000);
    expect
      .soft(received.mock.calls)
      .toEqual(records.slice(0, -1).map((frame) => [frame]));
    expect.soft(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(received.mock.calls).toEqual(records.map((frame) => [frame]));
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("subtracts the first wave batch span when scheduling the footer", async () => {
    const records: SessionRecord[] = [
      {
        kind: "pulseWave",
        samples: [
          { t: 1_000_000, value: 0.3, stable: true },
          { t: 3_000_000, value: 0.4, stable: true },
        ],
      },
      { kind: "end", durationUs: 5_000_000 },
    ];
    const onEnd = vi.fn();
    const source = new JsonlReplaySource(await file(v2(records)), { onEnd });
    await source.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("withdraws sharing at recorded End so a viewer joining during the drain sees only Off", async () => {
    const mode = { consentRecorded: true, privacyMode: "numbers" } as const;
    const lastReading = pulse(0, 82);
    const drainedReading = pulse(3, 85);
    const boundary = { kind: "drain" } as const;
    const footer = { kind: "end", durationUs: 3_000_000 } as const;
    const live = fixture();
    await live.session.startSession({ ...mode, recordingEnabled: true });
    await live.session.ingestFrame(lastReading);
    await live.session.withdrawSharing("drain");
    await live.session.ingestFrame(drainedReading);
    await live.session.stopSession();
    const recording = live.recorder.files[0] ?? [];
    expect(recording).toEqual([lastReading, boundary, drainedReading, footer]);
    expect(live.publisher.states).toMatchObject([
      { mode: "numbers" },
      { mode: "numbers", pulseBpm: 82 },
      { mode: "off" },
    ]);

    const ports = fixture();
    const source = new JsonlReplaySource(await file(v2(recording)), {
      onEnd: () => void replay.whenIdle().then(() => replay.stopSession()),
    });
    const replay = new StreamSession({ ...ports, source }, { replay: true });
    const received = vi.fn();
    source.subscribe(received);
    await replay.startSession(mode);
    // Let ingestion run between the reading and drain timers at the same time.
    await vi.advanceTimersByTimeAsync(0);
    await replay.whenIdle();
    expect.soft(ports.publisher.states.at(-1)).toEqual({
      mode: "off",
      replay: true,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const viewer: OverlayState[] = [];
    ports.publisher.connect((state) => viewer.push(state));
    expect.soft(viewer).toEqual([{ mode: "off", replay: true }]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(replay.panelState.active).toBe(true);
    expect.soft(received.mock.calls).toEqual([[lastReading], [boundary]]);
    expect(replay.sessionDurationMs).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await replay.whenIdle();
    expect(replay.panelState.active).toBe(false);
    expect(replay.sessionDurationMs).toBe(3_000);
    expect
      .soft(received.mock.calls)
      .toEqual([[lastReading], [boundary], [footer]]);
    expect.soft(viewer).toEqual([{ mode: "off", replay: true }]);
    expect(ports.publisher.states).toEqual(
      live.publisher.states.map((state) => ({ ...state, replay: true })),
    );
  });

  it("matches live End at delivery while a highlight write holds the replay queue", async () => {
    const mode = { consentRecorded: true, privacyMode: "numbers" } as const;
    const readings = [pulse(0), pulse(59, 88), pulse(60, 88), pulse(61, 89)];
    const boundary = { kind: "drain" } as const;
    const tail = pulse(64, 95);
    const footer = { kind: "end", durationUs: 64_000_000 } as const;
    const holdHighlight = (highlights: MemoryHighlights) => {
      const started = deferred<void>();
      const release = deferred<void>();
      const append = highlights.append.bind(highlights);
      vi.spyOn(highlights, "append").mockImplementationOnce(async (item) => {
        started.resolve();
        await release.promise;
        await append(item);
      });
      return { started, release };
    };
    const live = fixture({ policy: quickPolicy });
    await live.session.startSession({ ...mode, recordingEnabled: true });
    for (const reading of readings.slice(0, 2))
      await live.session.ingestFrame(reading);
    expect(live.publisher.states.at(-1)).toMatchObject({ pulseBpm: 88 });
    const liveWrite = holdHighlight(live.highlights);
    for (const reading of readings.slice(2)) live.source.emit(reading);
    await liveWrite.started.promise;
    const end = live.session.withdrawSharing("drain");
    const liveViewer: OverlayState[] = [];
    live.publisher.connect((state) => liveViewer.push(state));
    expect.soft(liveViewer).toEqual([{ mode: "off", replay: false }]);
    live.source.emit(tail);
    liveWrite.release.resolve();
    await end;
    await live.session.stopSession();
    await live.session.settleChapters();
    expect(liveViewer).toEqual([{ mode: "off", replay: false }]);
    const recording = live.recorder.files[0] ?? [];
    expect(recording).toEqual([...readings, boundary, tail, footer]);

    const ports = fixture();
    const replayWrite = holdHighlight(ports.highlights);
    const source = new JsonlReplaySource(await file(v2(recording)), {
      onEnd: () => void replay.whenIdle().then(() => replay.stopSession()),
    });
    const replay = new StreamSession(
      { ...ports, source },
      {
        replay: true,
        policy: quickPolicy,
      },
    );
    const received = vi.fn();
    source.subscribe(received);
    await replay.startSession(mode);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ports.publisher.states.at(-1)).toMatchObject({ pulseBpm: 88 });
    await vi.advanceTimersByTimeAsync(1_000);
    await replayWrite.started.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const viewer: OverlayState[] = [];
    try {
      expect.soft(received.mock.calls.at(-1)).toEqual([boundary]);
      expect.soft(ports.publisher.states.at(-1)).toEqual({
        mode: "off",
        replay: true,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      ports.publisher.connect((state) => viewer.push(state));
      expect.soft(viewer).toEqual([{ mode: "off", replay: true }]);
      expect(ports.highlights.items).toEqual([]);
      expect(replay.sessionDurationMs).toBe(60_000);
    } finally {
      replayWrite.release.resolve();
      await replay.whenIdle();
    }

    expect(replay.panelState.pulse?.value).toBe(89);
    expect(replay.sessionDurationMs).toBe(61_000);
    expect(replay.panelState.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    await replay.whenIdle();
    await replay.settleChapters();
    expect(replay.panelState.active).toBe(false);
    expect(replay.sessionDurationMs).toBe(64_000);
    expect(ports.highlights.items).toEqual(live.highlights.items);
    expect(ports.highlights.items).toMatchObject([{ t: at(60) }]);
    expect(viewer).toEqual(
      liveViewer.map((state) => ({ ...state, replay: true })),
    );
    expect(ports.publisher.states).toEqual(
      live.publisher.states.map((state) => ({ ...state, replay: true })),
    );
  });

  it.each([
    {
      name: "multiple faces",
      restriction: {
        kind: "validation",
        t: at(60.02),
        code: "multipleFacesFound",
        hint: "One person only",
      },
      status: "paused",
    },
    {
      name: "too dark",
      restriction: {
        kind: "validation",
        t: at(60.02),
        code: "tooDark",
        hint: "Find more light",
      },
      status: "live",
    },
    {
      name: "Pause",
      restriction: { kind: "capture", t: at(60.02), state: "paused" },
      status: "paused",
    },
    {
      name: "Off footer",
      restriction: { kind: "end", durationUs: 60_020_000 },
      status: null,
    },
  ] as const)(
    "restricts the cached overlay at delivery of $name while a highlight write is held",
    async ({ restriction, status }) => {
      const ports = fixture();
      const started = deferred<void>();
      const release = deferred<void>();
      const append = ports.highlights.append.bind(ports.highlights);
      vi.spyOn(ports.highlights, "append").mockImplementationOnce(
        async (item) => {
          started.resolve();
          await release.promise;
          await append(item);
        },
      );
      const olderOk = {
        kind: "validation",
        t: at(60.01),
        code: "ok",
        hint: "Ready",
      } as const;
      const records = [
        pulse(0),
        pulse(59, 88),
        pulse(60, 88),
        olderOk,
        pulse(60.015, 89),
        restriction,
        ...(restriction.kind === "end" ? [] : [pulse(62.021, 89)]),
        ...(restriction.kind === "validation"
          ? [{ ...olderOk, t: at(63) }, pulse(75.01, 84)]
          : []),
      ];
      const source = new JsonlReplaySource(await file(v2(records)), {
        onEnd: () => {
          if (restriction.kind === "end")
            void replay.whenIdle().then(() => replay.stopSession());
        },
      });
      const received = vi.fn();
      source.subscribe(received);
      const replay = new StreamSession(
        { ...ports, source },
        { replay: true, policy: quickPolicy },
      );
      await replay.startSession({
        consentRecorded: true,
        privacyMode: "numbers",
      });
      let stateAtDelivery: OverlayState | undefined;
      source.subscribe((record) => {
        if (
          record.kind === restriction.kind &&
          (record.kind !== "validation" || record.code !== "ok")
        )
          stateAtDelivery = ports.publisher.states.at(-1);
      });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(ports.publisher.states.at(-1)).toMatchObject({ pulseBpm: 88 });

      const viewer: OverlayState[] = [];
      const hidden =
        status === null
          ? { mode: "off", replay: true }
          : {
              mode: "numbers",
              pulseBpm: null,
              breathingRate: null,
              beatWave: [],
              breathWave: [],
              replay: true,
            };
      try {
        await vi.advanceTimersByTimeAsync(1_000);
        await started.promise;
        await vi.advanceTimersByTimeAsync(20);
        expect(received.mock.calls.at(-1)).toEqual([restriction]);
        expect
          .soft(stateAtDelivery)
          .toMatchObject(status === null ? hidden : { ...hidden, status });
        await vi.advanceTimersByTimeAsync(30);
        ports.publisher.connect((state) => viewer.push(state));
        expect
          .soft(viewer[0])
          .toMatchObject(status === null ? hidden : { ...hidden, status });
        expect(ports.highlights.items).toEqual([]);
      } finally {
        release.resolve();
        await replay.whenIdle();
      }

      expect(ports.highlights.items).toMatchObject([{ t: at(60) }]);
      for (const state of viewer) expect.soft(state).toMatchObject(hidden);
      expect
        .soft(viewer.at(-1))
        .toMatchObject(status === null ? hidden : { ...hidden, status });
      if (restriction.kind === "validation" && restriction.code === "tooDark") {
        await vi.advanceTimersByTimeAsync(1_971);
        await replay.whenIdle();
        expect(viewer.at(-1)).toMatchObject({ ...hidden, status: "paused" });
      }
      if (restriction.kind === "validation") {
        await vi.advanceTimersByTimeAsync(
          restriction.code === "tooDark" ? 12_989 : 14_960,
        );
        await replay.whenIdle();
        expect(viewer.at(-1)).toMatchObject({ status: "live", pulseBpm: 84 });
      }
    },
  );

  it("matches live Pause and Resume through a fresh OK and the next eligible reading", async () => {
    const mode = { consentRecorded: true, privacyMode: "numbers" } as const;
    const ok = (second: number) =>
      ({
        kind: "validation",
        t: at(second),
        code: "ok",
        hint: "Ready",
      }) as const;
    const breath = (second: number): SignalFrame => ({
      kind: "breathingRate",
      reading: { t: at(second), value: 16, stable: true, confidence: 90 },
    });
    const stages = [
      { second: 1, frames: [ok(0), pulse(1, 82)] },
      { second: 2, paused: true },
      { second: 3, paused: false },
      { second: 4, frames: [pulse(4, 85)] },
      {
        second: 5,
        frames: [
          ok(2), // A delayed validation from before Resume.
          pulse(5, 85),
          breath(5),
          wave("pulseWave", [
            [4.91, 0.6],
            [5, 0.7],
          ]),
          wave("breathingWave", [[5, 0.7]]),
        ],
      },
      { second: 6, frames: [ok(6)] },
      { second: 7, frames: [pulse(7, 85, { stable: false })] },
      { second: 8, frames: [pulse(8, 86)] },
      {
        second: 9,
        frames: [
          breath(9),
          wave("pulseWave", [
            [8.91, 0.8],
            [9, 0.9],
          ]),
          wave("breathingWave", [[9, 0.9]]),
        ],
      },
    ] as const;
    const live = fixture({ policy: quickPolicy });
    await live.session.startSession({ ...mode, recordingEnabled: true });
    const expected: (OverlayState | undefined)[] = [];
    for (const stage of stages) {
      if ("paused" in stage) {
        live.clock.value = at(stage.second);
        await live.session.setPaused(stage.paused);
      } else {
        for (const frame of stage.frames) await live.session.ingestFrame(frame);
      }
      expected.push(live.publisher.states.at(-1));
    }
    // Keep the last Resume assertion before the footer that turns sharing Off.
    await live.session.ingestFrame({
      kind: "processing",
      status: "running",
      t: at(10),
    });
    await live.session.stopSession();

    const ports = fixture();
    const source = new JsonlReplaySource(
      await file(v2(live.recorder.files[0] ?? [])),
    );
    const replay = new StreamSession(
      { ...ports, source },
      {
        replay: true,
        policy: quickPolicy,
      },
    );
    const hidden = {
      pulseBpm: null,
      breathingRate: null,
      beatWave: [],
      breathWave: [],
    };
    await replay.startSession(mode);
    const viewer: OverlayState[] = [];
    for (const [index, stage] of stages.entries()) {
      const previousSecond = stages[index - 1]?.second ?? 0;
      await vi.advanceTimersByTimeAsync(
        (stage.second - previousSecond) * 1_000,
      );
      await replay.whenIdle();
      expect
        .soft(ports.publisher.states.at(-1), `at ${stage.second} s`)
        .toEqual({
          ...expected[index],
          replay: true,
        });
      if (stage.second === 4) {
        ports.publisher.connect((state) => viewer.push(state));
        expect(replay.panelState.pulse?.value).toBe(85);
        expect.soft(viewer[0]).toMatchObject(hidden);
      } else if (stage.second === 7) {
        for (const state of viewer) expect.soft(state).toMatchObject(hidden);
      }
    }
    expect(ports.publisher.states.at(-1)).toMatchObject({
      pulseBpm: 86,
      breathingRate: 16,
      breathWave: [expect.objectContaining({ atMs: 9_000 })],
    });
    expect(viewer).toContainEqual(
      expect.objectContaining({
        beatWave: expect.arrayContaining([
          expect.objectContaining({ atMs: 8_910 }),
        ]),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await replay.whenIdle();
    expect(viewer.at(-1)).toEqual({ mode: "off", replay: true });
  });

  it("uses the first drained sample as the footer origin when capture never started measuring", async () => {
    const pause = { kind: "capture", state: "paused", t: 1_000_000 } as const;
    const resume = { kind: "capture", state: "resumed", t: 1_500_000 } as const;
    const boundary = { kind: "drain" } as const;
    const end = { kind: "end", durationUs: 5_000_000 } as const;
    const records: SessionRecord[] = [
      pause,
      resume,
      boundary,
      {
        kind: "pulseWave",
        samples: [
          { t: 2_000_000, value: 0.3, stable: true },
          { t: 3_000_000, value: 0.4, stable: true },
        ],
      },
      end,
    ];
    const onEnd = vi.fn();
    const source = new JsonlReplaySource(await file(v2(records)), { onEnd });
    const received = vi.fn();
    source.subscribe(received);
    await source.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(received.mock.calls).toEqual([[pause]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received.mock.calls).toEqual([[pause], [resume], [boundary]]);
    await vi.advanceTimersByTimeAsync(5_499);
    expect(received.mock.calls).toEqual([[pause], [resume], [boundary]]);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(received.mock.calls).toEqual([[pause], [resume], [boundary], [end]]);
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it.each(["complete", "stop"] as const)(
    "uses cancellable timer chunks for a multi-day trailing pause at 0.25x (%s)",
    async (action) => {
      const timerLimitMs = 2 ** 31 - 1;
      const dayUs = 86_400_000_000;
      const records: SessionRecord[] = [
        ...frames,
        { kind: "capture", state: "paused", t: 1_000_000 + 7 * dayUs },
        { kind: "end", durationUs: 15 * dayUs },
      ];
      const delivered: (SessionRecord | "completed")[] = [];
      const source = new JsonlReplaySource(await file(v2(records)), {
        speed: 0.25,
        onEnd: () => delivered.push("completed"),
      });
      source.subscribe((record) => delivered.push(record));
      const timeout = vi.spyOn(globalThis, "setTimeout");
      try {
        await source.start();
        expect
          .soft(
            timeout.mock.calls.every(
              ([, delay]) => Number(delay) <= timerLimitMs,
            ),
          )
          .toBe(true);
        await vi.advanceTimersByTimeAsync((7 * dayUs) / 250);
        expect(delivered).toEqual(records.slice(0, -1));
        if (action === "stop") {
          await source.stop();
          expect(vi.getTimerCount()).toBe(0);
          await vi.runAllTimersAsync();
          expect(delivered).toEqual(records.slice(0, -1));
        } else {
          await vi.advanceTimersByTimeAsync((8 * dayUs) / 250 - 1);
          expect(delivered).toEqual(records.slice(0, -1));
          await vi.advanceTimersByTimeAsync(1);
          expect(delivered).toEqual([...records, "completed"]);
        }
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("cancels pending frames/end, tolerates repeated Stop, restarts at the beginning, and unsubscribes", async () => {
    const onEnd = vi.fn();
    const source = new JsonlReplaySource(await file(), { onEnd });
    const received = vi.fn();
    const unsubscribe = source.subscribe(received);
    await source.stop();
    await source.start();
    await source.start();
    await vi.advanceTimersByTimeAsync(0);
    await source.stop();
    await source.stop();
    await vi.runAllTimersAsync();
    expect(received.mock.calls).toEqual([[frames[0]]]);
    expect(onEnd).not.toHaveBeenCalled();
    await source.start();
    await vi.runAllTimersAsync();
    expect(received.mock.calls).toEqual([
      [frames[0]],
      ...frames.map((frame) => [frame]),
    ]);
    expect(onEnd).toHaveBeenCalledOnce();
    unsubscribe();
    await source.start();
    await vi.runAllTimersAsync();
    expect(received).toHaveBeenCalledTimes(4);
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("uses the injected scheduler, preserves file order for late/empty batches, and ends after delivery", async () => {
    const input =
      encoded() +
      '{"kind":"pulseWave","samples":[]}\n' +
      '{"kind":"processing","status":"running","t":1500000}\n';
    const tasks: {
      delay: number;
      run: () => void;
      cancel: ReturnType<typeof vi.fn>;
    }[] = [];
    const received: string[] = [];
    const source = new JsonlReplaySource(await file(input), {
      scheduler: {
        schedule(run, delay) {
          const cancel = vi.fn();
          tasks.push({ delay, run, cancel });
          return cancel;
        },
      },
      onEnd: () => received.push("end"),
    });
    source.subscribe((frame) => received.push(frame.kind));
    await source.start();
    expect(tasks.map((task) => task.delay)).toEqual([
      0, 1000, 2000, 2000, 2000, 2000,
    ]);
    for (const task of tasks) task.run();
    expect(received).toEqual([
      "processing",
      "pulseRate",
      "pulseWave",
      "pulseWave",
      "processing",
      "end",
    ]);
    await source.start();
    await source.stop();
    for (const task of tasks.slice(6)) {
      expect(task.cancel).toHaveBeenCalledOnce();
      task.run();
    }
    expect(received).toHaveLength(6);
  });

  it("reports end for an empty recording and isolates subscribers", async () => {
    const onEnd = vi.fn();
    const empty = `${encoded().split("\n")[0]}\n`;
    const source = new JsonlReplaySource(await file(empty), { onEnd });
    await source.start();
    await vi.runAllTimersAsync();
    expect(onEnd).toHaveBeenCalledOnce();
    const full = new JsonlReplaySource(await file());
    full.subscribe(() => {
      throw new Error("consumer");
    });
    const received = vi.fn();
    full.subscribe(received);
    await full.start();
    await vi.runAllTimersAsync();
    expect(received).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["", "line 1"],
    ["{}\n", "line 1"],
    [encoded().slice(0, -1), "line 4: truncated"],
    [`${encoded()}{broken}\n`, "line 5"],
    [`${encoded()}{"kind":"unknown"}\n`, "line 5: unknown frame kind"],
  ])(
    "rejects malformed/truncated input with line information",
    async (input, message) => {
      const path = await file(input);
      expect(() => new JsonlReplaySource(path)).toThrow(message);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("reports unreadable files and refuses invalid speed without scheduling", () => {
    expect(() => new JsonlReplaySource(join(directory, "missing"))).toThrow(
      "Unable to read replay file",
    );
    for (const speed of [0, -1, 0.24, 21, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => new JsonlReplaySource("unused", { speed })).toThrow(
        "Replay speed",
      );
  });

  it("committed synthetic development fixture exactly matches its generator and stays under 300 KB", async () => {
    const fixture = await readFile(
      new URL("../fixtures/replay/synthetic-spike.jsonl", import.meta.url),
      "utf8",
    );
    expect(fixture).toBe(generateSyntheticSession());
    expect(Buffer.byteLength(fixture)).toBeLessThan(300_000);
    expect(fixture.split("\n")[0]).toContain("synthetic (development only)");
  });
});
