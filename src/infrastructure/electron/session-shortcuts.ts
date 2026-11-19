import type { CapturePauseReason } from "../../application/dto/index";
import type { PrivacyMode } from "../../domain/privacy/index";

export const pauseShortcut = "CommandOrControl+Shift+P";
export const privacyShortcut = "CommandOrControl+Shift+M";

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface PauseRequest {
  readonly observedReason: CapturePauseReason | null;
  readonly paused: boolean;
  pauseApplied?: Promise<void>;
}

/** Global registration survives blur and captures pause intent at key press. */
export function registerSessionShortcuts(options: {
  registry: ShortcutRegistry;
  lifecycle: {
    on(event: "will-quit", callback: () => void): unknown;
    removeListener(event: "will-quit", callback: () => void): unknown;
  };
  state(): {
    readonly active: boolean;
    readonly privacyMode: PrivacyMode;
    readonly pauseReason: CapturePauseReason | null;
  };
  setPaused(paused: boolean): Promise<void>;
  setPrivacyMode(mode: PrivacyMode): Promise<void>;
  report(message: string): void;
}): () => void {
  const registered: string[] = [];
  const failures: string[] = [];
  let disposed = false;
  let pendingPrivacy: { from: PrivacyMode; to: PrivacyMode } | null = null;
  let pendingPause: PauseRequest | null = null;

  async function togglePause(
    current: CapturePauseReason | null,
  ): Promise<void> {
    const previous = pendingPause;
    const sawAutoPause =
      current === "unusableInput" && previous?.observedReason !== current;
    const wasPaused = sawAutoPause || (previous?.paused ?? current !== null);
    const request: PauseRequest = {
      observedReason: current,
      paused: !wasPaused,
    };
    pendingPause = request;
    try {
      if (request.paused) {
        request.pauseApplied = options.setPaused(true);
        await request.pauseApplied;
        return;
      }
      if (previous?.pauseApplied && !sawAutoPause) {
        // The timeout may own the pause by the time the queued command runs.
        await previous.pauseApplied.catch(() => undefined);
        if (pendingPause !== request || disposed) return;
        const state = options.state();
        if (
          !state.active ||
          state.privacyMode === "off" ||
          state.pauseReason !== "manual"
        )
          return;
      }
      await options.setPaused(false);
    } finally {
      if (pendingPause === request) pendingPause = null;
    }
  }

  async function cyclePrivacy(current: PrivacyMode): Promise<void> {
    // Rapid presses step through a mode even while its upgrade is queued.
    const mode = pendingPrivacy?.from === current ? pendingPrivacy.to : current;
    const to =
      mode === "vibe"
        ? "numbers"
        : mode === "numbers"
          ? "highlightsOnly"
          : "vibe";
    const request = { from: current, to } as const;
    pendingPrivacy = request;
    try {
      await options.setPrivacyMode(request.to);
    } finally {
      if (pendingPrivacy === request) pendingPrivacy = null;
    }
  }
  async function runShortcut(accelerator: string): Promise<void> {
    const { active, pauseReason, privacyMode } = options.state();
    if (disposed || !active || privacyMode === "off") return;
    try {
      // Commands latch restrictions immediately and order transitions in the session queue.
      if (accelerator === pauseShortcut) await togglePause(pauseReason);
      else await cyclePrivacy(privacyMode);
    } catch {
      options.report(
        "The session shortcut could not complete. Use the panel controls.",
      );
    }
  }
  for (const accelerator of [pauseShortcut, privacyShortcut]) {
    try {
      if (
        options.registry.register(accelerator, () => {
          void runShortcut(accelerator);
        })
      )
        registered.push(accelerator);
      else failures.push(accelerator);
    } catch {
      failures.push(accelerator);
    }
  }
  options.report(
    failures.length
      ? `Shortcut unavailable: ${failures.join(", ")}. Another app may own it. Use the panel controls.`
      : "",
  );
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const accelerator of registered)
      options.registry.unregister(accelerator);
    options.lifecycle.removeListener("will-quit", dispose);
  }
  options.lifecycle.on("will-quit", dispose);
  return dispose;
}
