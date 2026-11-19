import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CapturePauseReason } from "../../src/application/dto/index";
import type { OverlayState, PrivacyMode } from "../../src/domain/privacy/index";
import {
  pauseShortcut,
  privacyShortcut,
  registerSessionShortcuts,
} from "../../src/infrastructure/electron/session-shortcuts";
import {
  at,
  deferred,
  pulse,
  fixture as streamFixture,
} from "../application/fakes";

function fixture(fail = "", throws = false) {
  const callbacks = new Map<string, () => void>();
  const registry = {
    register: vi.fn((key: string, callback: () => void) => {
      if (key === fail) {
        if (throws) throw new Error("unavailable");
        return false;
      }
      callbacks.set(key, callback);
      return true;
    }),
    unregister: vi.fn(),
  };
  const lifecycle = new EventEmitter();
  const state: {
    active: boolean;
    privacyMode: PrivacyMode;
    pauseReason: CapturePauseReason | null;
  } = {
    active: false,
    privacyMode: "vibe",
    pauseReason: null,
  };
  const setPaused = vi.fn(async (paused: boolean) => {
    state.pauseReason = paused ? "manual" : null;
  });
  const setPrivacyMode = vi.fn(async (mode: PrivacyMode) => {
    state.privacyMode = mode;
  });
  const report = vi.fn();
  const dispose = registerSessionShortcuts({
    registry,
    lifecycle,
    state: () => state,
    setPaused,
    setPrivacyMode,
    report,
  });
  return {
    callbacks,
    registry,
    lifecycle,
    state,
    setPaused,
    setPrivacyMode,
    report,
    dispose,
  };
}

async function recordedShortcutSession() {
  const f = streamFixture();
  f.clock.value = at(0);
  await f.session.startSession({
    consentRecorded: true,
    privacyMode: "vibe",
    recordingEnabled: true,
  });
  const callbacks = new Map<string, () => void>();
  const dispose = registerSessionShortcuts({
    registry: {
      register: (key, callback) => Boolean(callbacks.set(key, callback)),
      unregister: (key) => callbacks.delete(key),
    },
    lifecycle: new EventEmitter(),
    state: () => f.session.panelState,
    setPaused: (paused) => f.session.setPaused(paused),
    setPrivacyMode: (mode) => f.session.setPrivacyMode(mode),
    report: vi.fn(),
  });
  return {
    ...f,
    dispose,
    pressPause: () => callbacks.get(pauseShortcut)?.(),
    captureStates: () =>
      f.recorder.files[0]
        ?.filter((frame) => frame.kind === "capture")
        .map((frame) => frame.state),
  };
}

const settle = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};

describe("global session shortcuts", () => {
  it.each(["pause", "lower sharing"] as const)(
    "applies %s at keypress while a Numbers upgrade is held",
    async (intent) => {
      const f = streamFixture();
      await f.session.startSession({
        consentRecorded: true,
        privacyMode: "vibe",
        recordingEnabled: true,
      });
      await f.session.ingestFrame(pulse(0, 82));
      const callbacks = new Map<string, () => void>();
      const dispose = registerSessionShortcuts({
        registry: {
          register: (key, callback) => Boolean(callbacks.set(key, callback)),
          unregister: (key) => callbacks.delete(key),
        },
        lifecycle: new EventEmitter(),
        state: () => f.session.panelState,
        setPaused: (paused) => f.session.setPaused(paused),
        setPrivacyMode: (mode) => f.session.setPrivacyMode(mode),
        report: vi.fn(),
      });

      const writing = deferred<void>();
      const release = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      f.recorder.append = async (frame) => {
        writing.resolve();
        await release.promise;
        await append(frame);
      };
      const heldFrame = pulse(1, 82);
      f.source.emit(heldFrame);
      await writing.promise;
      callbacks.get(privacyShortcut)?.();
      await settle();
      f.clock.value = at(2);
      callbacks.get(intent === "pause" ? pauseShortcut : privacyShortcut)?.();
      const viewer: OverlayState[] = [];
      f.publisher.connect((state) => viewer.push(state));
      release.resolve();
      await settle();
      await f.session.whenIdle();
      dispose();

      expect(viewer.length).toBeGreaterThan(0);
      for (const state of viewer) {
        if (intent === "pause") {
          expect.soft(state).toMatchObject({ status: "paused", beatWave: [] });
          if (state.mode === "numbers") expect.soft(state.pulseBpm).toBeNull();
        } else {
          expect.soft(state).toEqual({ mode: "highlightsOnly", replay: false });
        }
      }
      if (intent === "pause") {
        expect(f.recorder.files[0]?.slice(1)).toEqual([
          heldFrame,
          { kind: "capture", state: "paused", t: at(2) },
        ]);
      } else {
        expect(f.session.panelState.privacyMode).toBe("highlightsOnly");
      }
    },
  );

  it.each([
    { presses: 2, reason: "manual", states: ["paused", "resumed", "paused"] },
    {
      presses: 3,
      reason: null,
      states: ["paused", "resumed", "paused", "resumed"],
    },
  ])(
    "applies $presses toggles while the manual pause append is held",
    async ({ presses, reason, states }) => {
      const f = await recordedShortcutSession();
      const writing = deferred<void>();
      const release = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      vi.spyOn(f.recorder, "append").mockImplementationOnce(async (frame) => {
        writing.resolve();
        await release.promise;
        await append(frame);
      });

      const pause = f.session.setPaused(true);
      await writing.promise;
      expect(f.session.panelState.pauseReason).toBe("manual");
      for (let index = 0; index < presses; index++) f.pressPause();
      release.resolve();
      await pause;
      await f.session.whenIdle();
      await settle();
      await f.session.whenIdle();
      f.dispose();

      expect(f.session.panelState.pauseReason).toBe(reason);
      expect(f.captureStates()).toEqual(states);
    },
  );

  it.each(["unseen", "seen between presses"] as const)(
    "respects a timeout that wins over a requested pause (%s)",
    async (observation) => {
      const f = await recordedShortcutSession();
      await f.session.ingestFrame({
        kind: "validation",
        t: at(0),
        code: "tooDark",
        hint: "More light",
      });
      const frameWriting = deferred<void>();
      const releaseFrame = deferred<void>();
      const pauseWriting = deferred<void>();
      const releasePause = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      vi.spyOn(f.recorder, "append")
        .mockImplementationOnce(async (frame) => {
          frameWriting.resolve();
          await releaseFrame.promise;
          await append(frame);
        })
        .mockImplementationOnce(async (frame) => {
          pauseWriting.resolve();
          await releasePause.promise;
          await append(frame);
        });
      f.source.emit(pulse(1));
      await frameWriting.promise;
      f.clock.value = at(60);
      const timeout = f.session.checkValidationTimeout();
      f.pressPause();
      if (observation === "unseen") f.pressPause();
      expect(f.session.panelState.pauseReason).toBeNull();
      releaseFrame.resolve();
      await pauseWriting.promise;
      expect(f.session.panelState.pauseReason).toBe("unusableInput");
      if (observation === "seen between presses") {
        f.pressPause(); // Explicit Resume from the automatic pause.
        f.pressPause(); // Pause again while the panel still shows the timeout.
      }
      releasePause.resolve();
      await timeout;
      await f.session.whenIdle();
      await settle();
      await f.session.whenIdle();
      f.dispose();

      if (observation === "unseen") {
        expect(f.session.panelState.pauseReason).toBe("unusableInput");
        expect(f.captureStates()).toEqual(["paused"]);
      } else {
        expect(f.session.panelState.pauseReason).toBe("manual");
        expect(f.captureStates()).toEqual(["paused", "resumed", "paused"]);
      }
    },
  );

  it("registers globally, gates inactive sessions and reads the latest mode on every callback", async () => {
    const f = fixture();
    expect(f.registry.register.mock.calls.map(([key]) => key)).toEqual([
      pauseShortcut,
      privacyShortcut,
    ]);
    f.callbacks.get(pauseShortcut)?.();
    f.callbacks.get(privacyShortcut)?.();
    expect(f.setPaused).not.toHaveBeenCalled();
    expect(f.setPrivacyMode).not.toHaveBeenCalled();
    f.state.active = true;
    f.callbacks.get(pauseShortcut)?.();
    for (let index = 0; index < 3; index++)
      f.callbacks.get(privacyShortcut)?.();
    await settle();
    expect(f.setPaused).toHaveBeenCalledOnce();
    expect(f.setPrivacyMode.mock.calls).toEqual([
      ["numbers"],
      ["highlightsOnly"],
      ["vibe"],
    ]);
    f.state.active = false;
    f.callbacks.get(pauseShortcut)?.();
    await settle();
    expect(f.setPaused).toHaveBeenCalledOnce();
    await settle();
    expect(f.report).toHaveBeenCalledExactlyOnceWith("");
  });

  it("resolves each pause shortcut from main state at key press", async () => {
    const f = fixture();
    f.state.active = true;
    f.callbacks.get(pauseShortcut)?.();
    f.state.pauseReason = "unusableInput";
    f.callbacks.get(pauseShortcut)?.();
    await settle();
    expect(f.setPaused.mock.calls).toEqual([[true], [false]]);
  });

  it.each([false, true])(
    "reports failed or thrown registration without disabling the other shortcut: %s",
    (throws) => {
      const f = fixture(privacyShortcut, throws);
      expect(f.report).toHaveBeenCalledWith(
        expect.stringContaining("Another app may own it"),
      );
      expect(f.report).toHaveBeenCalledWith(
        expect.stringContaining(privacyShortcut),
      );
      f.lifecycle.emit("will-quit");
      expect(f.registry.unregister).toHaveBeenCalledExactlyOnceWith(
        pauseShortcut,
      );
    },
  );

  it("unregisters on quit and disposal, and ignores late callbacks", async () => {
    const f = fixture();
    f.state.active = true;
    f.lifecycle.emit("blur");
    f.callbacks.get(pauseShortcut)?.();
    await settle();
    expect(f.setPaused).toHaveBeenCalledOnce();
    f.lifecycle.emit("will-quit");
    f.dispose();
    expect(f.registry.unregister.mock.calls).toEqual([
      [pauseShortcut],
      [privacyShortcut],
    ]);
    expect(f.lifecycle.listenerCount("will-quit")).toBe(0);
    f.callbacks.get(pauseShortcut)?.();
    await settle();
    expect(f.setPaused).toHaveBeenCalledOnce();
  });

  it("contains command rejection and reports it to the panel", async () => {
    const f = fixture();
    f.state.active = true;
    f.setPaused.mockRejectedValueOnce(new Error("failed"));
    f.callbacks.get(pauseShortcut)?.();
    await settle();
    expect(f.report).toHaveBeenLastCalledWith(
      expect.stringContaining("could not complete"),
    );
  });
});
