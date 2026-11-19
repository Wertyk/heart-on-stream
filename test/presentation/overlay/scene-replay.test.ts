import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { StreamSession } from "../../../src/application/use-cases/stream-session";
import { JsonlReplaySource } from "../../../src/infrastructure/replay/jsonl-replay-source";
import {
  advanceScene,
  emptyScene,
  receiveSnapshot,
} from "../../../src/presentation/overlay/scene";
import { fixture } from "../../application/fakes";

const sample = fileURLToPath(
  new URL("../../../samples/live-b-calm.jsonl", import.meta.url),
);
const maxSafetyMarginMs = 125;
const auditCursorMs = 41_350;
const auditBufferedEdges = [42_850, 42_826.4];

function replayScheduler() {
  let nowMs = 0;
  // The replay source schedules records in deadline order on Start and Resume.
  const tasks = new Set<{ atMs: number; run: () => void }>();
  return {
    nowMs: () => nowMs,
    schedule(run: () => void, delayMs: number) {
      const task = { atMs: nowMs + delayMs, run };
      tasks.add(task);
      return () => {
        tasks.delete(task);
      };
    },
    get pending() {
      return tasks.size > 0;
    },
    async advanceTo(atMs: number, whenIdle: () => Promise<void>) {
      for (const task of tasks) {
        if (task.atMs > atMs) break;
        nowMs = task.atMs;
        tasks.delete(task);
        task.run();
        await whenIdle();
      }
      nowMs = atMs;
    },
  };
}

const startInVibe = { consentRecorded: true, privacyMode: "vibe" } as const;

function calmReplay(speed: number) {
  const scheduler = replayScheduler();
  const ports = fixture();
  const source = new JsonlReplaySource(sample, { speed, scheduler });
  const session = new StreamSession({ ...ports, source }, { replay: true });
  let scene = emptyScene();
  let frame = 0;
  ports.publisher.connect((state) => {
    scene = receiveSnapshot(scene, state, scheduler.nowMs());
  });

  return {
    session,
    nowMs: scheduler.nowMs,
    publisher: ports.publisher,
    get scene() {
      return scene;
    },
    async drawThrough(
      endMs: number,
      visit?: (frame: ReturnType<typeof advanceScene>, nowMs: number) => void,
    ) {
      while ((frame * 1_000) / 60 <= endMs) {
        const nowMs = (frame++ * 1_000) / 60;
        await scheduler.advanceTo(nowMs, () => session.whenIdle());
        const next = advanceScene(scene, nowMs);
        scene = next.scene;
        visit?.(next, nowMs);
      }
    },
  };
}

async function measureRecovery(
  replay: ReturnType<typeof calmReplay>,
  resumedAtMs: number,
  speed: number,
) {
  let firstTraceFrame = Infinity;
  let previousCursor: number | undefined;
  let missingTraceFrames = 0;
  let stalledFrames = 0;
  let firstTraceStep: number | undefined;
  await replay.drawThrough(resumedAtMs + 4_000 / speed, (frame, nowMs) => {
    const trace = frame.animation.pulseTrace;
    if (!trace) {
      if (previousCursor !== undefined) missingTraceFrames++;
      return;
    }
    if (firstTraceFrame === Infinity)
      firstTraceFrame = Math.round(((nowMs - resumedAtMs) * 60) / 1_000);
    const newest = trace.points.at(-1)?.atMs ?? 0;
    if (previousCursor !== undefined) {
      const step = trace.cursorAtMs - previousCursor;
      firstTraceStep ??= step;
      if (step <= 0 && newest - trace.cursorAtMs >= maxSafetyMarginMs)
        stalledFrames++;
    }
    previousCursor = trace.cursorAtMs;
  });
  return { firstTraceFrame, missingTraceFrames, stalledFrames, firstTraceStep };
}

// First drawable 60 Hz frame after Resume before the clock retained its rate.
it.each([
  [0.25, 116],
  [0.5, 100],
])(
  "keeps the calm replay trace moving after a 30 s manual pause at %s×",
  async (speed, baselineFirstTraceFrame) => {
    const replay = calmReplay(speed);
    await replay.session.startSession(startInVibe);
    const pausedAtMs = 112_000 / speed;
    const resumedAtMs = pausedAtMs + 30_000;
    await replay.drawThrough(pausedAtMs);
    expect(replay.scene.state).toMatchObject({ mode: "vibe", status: "live" });
    await replay.session.setPaused(true);
    await replay.drawThrough(resumedAtMs);
    expect(replay.scene.state).toMatchObject({
      mode: "vibe",
      status: "paused",
    });
    expect(replay.scene.beat.points).toHaveLength(0);
    await replay.session.setPaused(false);

    const recovery = await measureRecovery(replay, resumedAtMs, speed);
    await replay.session.stopSession();

    expect
      .soft(recovery.firstTraceFrame)
      .toBeLessThanOrEqual(baselineFirstTraceFrame);
    expect.soft(recovery.missingTraceFrames).toBe(0);
    expect.soft(recovery.stalledFrames).toBe(0);
    expect(recovery.firstTraceStep).toBeCloseTo((speed * 1_000) / 60, 0);
  },
);

it.each([0.25, 0.5])(
  "keeps the calm replay trace moving from Highlights only back to Vibe at %s×",
  async (speed) => {
    const replay = calmReplay(speed);
    await replay.session.startSession(startInVibe);
    const returnedAtMs = 112_000 / speed;
    await replay.drawThrough(returnedAtMs - 1_000);
    expect(replay.scene.state).toMatchObject({ mode: "vibe", status: "live" });
    await replay.session.setPrivacyMode("highlightsOnly");
    await replay.drawThrough(returnedAtMs);
    expect(replay.scene.state).toMatchObject({ mode: "highlightsOnly" });
    expect(replay.scene.beat.points).toHaveLength(0);
    await replay.session.setPrivacyMode("vibe");

    const recovery = await measureRecovery(replay, returnedAtMs, speed);
    await replay.session.stopSession();

    expect.soft(recovery.missingTraceFrames).toBe(0);
    expect.soft(recovery.stalledFrames).toBe(0);
    expect(recovery.firstTraceStep).toBeCloseTo((speed * 1_000) / 60, 0);
  },
);

it("starts a second calm replay with the same cursor as a fresh overlay", async () => {
  const speed = 0.25;
  const replay = calmReplay(speed);
  await replay.session.startSession(startInVibe);
  const endedAtMs = 112_000 / speed;
  await replay.drawThrough(endedAtMs);
  await replay.session.stopSession();
  expect(replay.scene.state).toEqual({ mode: "off", replay: true });

  let fresh = emptyScene();
  replay.publisher.connect((state) => {
    fresh = receiveSnapshot(fresh, state, replay.nowMs());
  });
  await replay.session.startSession(startInVibe);
  let advancingFrames = 0;
  await replay.drawThrough(endedAtMs + 60_000, ({ scene }, frameMs) => {
    const previousCursor = fresh.beat.cursorAtMs;
    fresh = advanceScene(fresh, frameMs).scene;
    expect(scene.beat.cursorAtMs).toBe(fresh.beat.cursorAtMs);
    if (previousCursor !== null && fresh.beat.cursorAtMs !== previousCursor)
      advancingFrames++;
  });
  await replay.session.stopSession();
  expect(advancingFrames).toBeGreaterThan(100);
});

it.each([0.25, 0.5, 1, 2, 8, 20])(
  "advances the calm replay and draws its Vibe pulse trace on every live frame at %s×",
  async (speed) => {
    const scheduler = replayScheduler();
    const ports = fixture();
    const source = new JsonlReplaySource(sample, { speed, scheduler });
    const session = new StreamSession({ ...ports, source }, { replay: true });
    let scene = emptyScene();
    ports.publisher.connect((state) => {
      scene = receiveSnapshot(scene, state, scheduler.nowMs());
    });
    await session.startSession({ consentRecorded: true, privacyMode: "vibe" });

    let liveFrames = 0;
    let missingLiveFrames = 0;
    let stalledFrames = 0;
    let overshotFrames = 0;
    let auditMaxBacklog = 0;
    let auditStalledFrames = 0;
    for (let frame = 0; scheduler.pending; frame += 1) {
      const nowMs = (frame * 1_000) / 60;
      const previousFrameMs = scene.beat.playedAtMs;
      await scheduler.advanceTo(nowMs, () => session.whenIdle());
      const previousCursor = scene.beat.cursorAtMs;
      // A new buffer anchors its clock on its first animation frame.
      const continuing = scene.beat.playedAtMs === previousFrameMs;
      const next = advanceScene(scene, nowMs);
      scene = next.scene;
      if (scene.state?.mode === "vibe" && scene.state.status === "live") {
        liveFrames += 1;
        const trace = next.animation.pulseTrace;
        if (!trace || trace.toIndex - trace.fromIndex < 2)
          missingLiveFrames += 1;
      }

      const newest = scene.beat.points.at(-1)?.atMs;
      const cursor = scene.beat.cursorAtMs;
      if (newest === undefined || cursor === null) continue;
      if (cursor > newest) overshotFrames += 1;
      if (
        continuing &&
        previousCursor !== null &&
        cursor <= previousCursor &&
        newest - cursor > maxSafetyMarginMs
      )
        stalledFrames += 1;

      // The audit observed a 45-point backlog at this particular batch edge.
      if (auditBufferedEdges.includes(newest)) {
        const ahead = scene.beat.points.filter(
          ({ atMs }) => atMs > auditCursorMs,
        );
        auditMaxBacklog = Math.max(auditMaxBacklog, ahead.length);
        if (continuing && cursor === auditCursorMs && cursor === previousCursor)
          auditStalledFrames += 1;
      }
    }
    await session.stopSession();

    expect(liveFrames).toBeGreaterThan(100);
    expect(missingLiveFrames).toBe(0);
    if (speed <= 1) {
      expect(auditMaxBacklog).toBe(45);
      expect.soft(auditStalledFrames).toBe(0);
    }
    expect(overshotFrames).toBe(0);
    expect(stalledFrames).toBe(0);
  },
);
