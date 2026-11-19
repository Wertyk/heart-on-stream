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
  "keeps the calm replay's Vibe pulse trace on every live frame at %s×",
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
    for (let frame = 0; scheduler.pending; frame += 1) {
      const nowMs = (frame * 1_000) / 60;
      await scheduler.advanceTo(nowMs, () => session.whenIdle());
      const next = advanceScene(scene, nowMs);
      scene = next.scene;
      if (scene.state?.mode !== "vibe" || scene.state.status !== "live")
        continue;
      liveFrames += 1;
      const trace = next.animation.pulseTrace;
      if (!trace || trace.toIndex - trace.fromIndex < 2) missingLiveFrames += 1;
    }
    await session.stopSession();

    expect(liveFrames).toBeGreaterThan(100);
    expect(missingLiveFrames).toBe(0);
  },
);
