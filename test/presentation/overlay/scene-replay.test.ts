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
  // This uninterrupted replay schedules all records in deadline order.
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
