import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLaunchOptions } from "../../src/main/launch-options";
import { claimSingleInstance } from "../../src/main/single-instance";

const fakes = vi.hoisted(() => {
  const order: string[] = [];
  type SecondInstanceHandler = (
    event: unknown,
    argv: string[],
    workingDirectory: string,
    additionalData: unknown,
  ) => void;
  type LifecycleHandlers = {
    "second-instance": SecondInstanceHandler;
    "window-all-closed": () => void;
  };
  const handlers: Partial<LifecycleHandlers> = {};
  const emitSecondInstance = (additionalData: unknown) => {
    handlers["second-instance"]?.(
      {},
      ["electron", "app", "--a-chromium-flag"],
      process.cwd(),
      structuredClone(additionalData),
    );
  };
  const app = {
    requestSingleInstanceLock: vi.fn((additionalData?: unknown) => {
      order.push("lock");
      if (!handlers["second-instance"]) return true;
      emitSecondInstance(additionalData);
      return false;
    }),
    quit: vi.fn(() => {
      order.push("quit");
    }),
    exit: vi.fn(),
    getPath: vi.fn(() => {
      order.push("userData");
      return "/local";
    }),
    whenReady: vi.fn(async () => {
      order.push("ready");
    }),
    on: vi.fn(
      <Name extends keyof LifecycleHandlers>(
        event: Name,
        listener: LifecycleHandlers[Name],
      ) => {
        handlers[event] = listener;
      },
    ),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    focus: vi.fn(),
  };
  const openWindow = vi.fn(() => window);
  const compose = vi.fn(() => {
    order.push("compose");
    app.getPath();
    return { openWindow };
  });
  const getAllWindows = vi.fn(() => [window]);
  const showMessageBox = vi.fn(async () => ({
    response: 0,
    checkboxChecked: false,
  }));
  return {
    app,
    window,
    order,
    handlers,
    emitSecondInstance,
    openWindow,
    compose,
    getAllWindows,
    showMessageBox,
  };
});

vi.mock("electron", () => ({
  app: fakes.app,
  BrowserWindow: { getAllWindows: fakes.getAllWindows },
  dialog: { showMessageBox: fakes.showMessageBox },
}));
vi.mock("../../src/main/composition-root", () => ({
  composeApplication: fakes.compose,
}));

const originalArgv = process.argv;

function setLaunchArguments(args: readonly string[]): void {
  process.argv = ["electron", "app", ...args];
}

async function launchAgain(args: readonly string[]): Promise<void> {
  vi.resetModules();
  setLaunchArguments(args);
  await import("../../src/main/main");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  fakes.order.length = 0;
  delete fakes.handlers["second-instance"];
  delete fakes.handlers["window-all-closed"];
  setLaunchArguments([]);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("single instance startup", () => {
  const replayArgs = ["--replay", "samples/session.jsonl"];
  const invalidReplayArgs = [...replayArgs, "--speed=0"];
  const speedError =
    "Replay speed must be a number between 0.25 and 20 (--speed=2).";

  it("quits immediately on a lost lock without readiness, composition or userData access", async () => {
    setLaunchArguments([
      "--replay",
      "samples/session.jsonl",
      "--speed=2",
      "--loop",
    ]);
    fakes.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import("../../src/main/main");
    expect(fakes.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(fakes.app.requestSingleInstanceLock).toHaveBeenCalledWith({
      replay: true,
      record: false,
      file: "samples/session.jsonl",
      speed: 2,
      loop: true,
      error: "",
    });
    expect(fakes.app.quit).toHaveBeenCalledOnce();
    expect(fakes.app.whenReady).not.toHaveBeenCalled();
    expect(fakes.compose).not.toHaveBeenCalled();
    expect(fakes.app.getPath).not.toHaveBeenCalled();
    expect(fakes.app.on).not.toHaveBeenCalled();
  });

  it("acquires the lock before composition and userData, and restores/focuses the existing window for equivalent live options without a dialog", async () => {
    await import("../../src/main/main");
    expect(fakes.order).toEqual(["lock", "ready", "compose", "userData"]);
    expect(fakes.openWindow).toHaveBeenCalledOnce();
    expect(fakes.app.quit).not.toHaveBeenCalled();
    await launchAgain(["--"]);
    expect(fakes.window.restore).toHaveBeenCalledOnce();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    expect(fakes.showMessageBox).not.toHaveBeenCalled();
    expect(fakes.compose).toHaveBeenCalledOnce();
    expect(fakes.openWindow).toHaveBeenCalledOnce();
    expect(fakes.app.quit).toHaveBeenCalledOnce();
  });

  it("focuses an equivalent replay with explicit defaults and a normalized file path without a dialog", async () => {
    setLaunchArguments(["--replay", "samples/session.jsonl"]);
    await import("../../src/main/main");
    await launchAgain([
      "--replay",
      "./samples/session.jsonl",
      "--speed=1.0",
      "--record",
    ]);
    expect(fakes.window.restore).toHaveBeenCalledOnce();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    expect(fakes.showMessageBox).not.toHaveBeenCalled();
    expect(fakes.openWindow).toHaveBeenCalledOnce();
  });

  it.each([
    {
      difference: "mode",
      running: replayArgs,
      requested: [],
      message: "Heart on Stream is running a replay of session.jsonl.",
    },
    {
      difference: "file",
      running: replayArgs,
      requested: ["--replay", "other/session.jsonl"],
      message: "Heart on Stream is running a replay of session.jsonl.",
    },
    {
      difference: "speed",
      running: replayArgs,
      requested: [...replayArgs, "--speed=2"],
      message: "Heart on Stream is running a replay of session.jsonl.",
    },
    {
      difference: "loop",
      running: replayArgs,
      requested: [...replayArgs, "--loop"],
      message: "Heart on Stream is running a replay of session.jsonl.",
    },
    {
      difference: "record flag",
      running: [],
      requested: ["--record"],
      message: "Heart on Stream is running in live mode.",
    },
  ])(
    "focuses the window and explains how to switch when $difference differs",
    async ({ running, requested, message }) => {
      setLaunchArguments(running);
      await import("../../src/main/main");
      await launchAgain(requested);
      expect(fakes.window.restore).toHaveBeenCalledExactlyOnceWith();
      expect(fakes.window.focus).toHaveBeenCalledExactlyOnceWith();
      expect(fakes.window.restore).toHaveBeenCalledBefore(fakes.window.focus);
      expect(fakes.window.focus).toHaveBeenCalledBefore(fakes.showMessageBox);
      expect(fakes.showMessageBox).toHaveBeenCalledExactlyOnceWith(
        fakes.window,
        expect.objectContaining({
          message: `${message}\n\nClose this window, then run the command again.`,
        }),
      );
      expect(fakes.compose).toHaveBeenCalledOnce();
      expect(fakes.openWindow).toHaveBeenCalledOnce();
      expect(fakes.app.quit).toHaveBeenCalledOnce();
      expect(fakes.app.exit).not.toHaveBeenCalled();
    },
  );

  it("opens the panel with the parse error when an invalid replay launch gets the lock", async () => {
    setLaunchArguments(invalidReplayArgs);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../src/main/main");
    const options = expect.objectContaining({
      replay: true,
      file: "samples/session.jsonl",
      error: speedError,
    });
    expect(fakes.order).toEqual(["lock", "ready", "compose", "userData"]);
    expect(fakes.app.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith(
      options,
    );
    expect(fakes.compose).toHaveBeenCalledExactlyOnceWith(options);
    expect(fakes.openWindow).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    expect(fakes.app.exit).not.toHaveBeenCalled();
    expect(fakes.app.quit).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "live",
      running: [],
      message: "Heart on Stream is running in live mode.",
    },
    {
      mode: "replay",
      running: replayArgs,
      message: "Heart on Stream is running a replay of session.jsonl.",
    },
    {
      mode: "replay with no file",
      running: ["--replay"],
      message: "Heart on Stream is running in replay mode.",
    },
  ])(
    "prints the invalid relaunch error before quitting and shows it in the open $mode window",
    async ({ running, message }) => {
      setLaunchArguments(running);
      await import("../../src/main/main");
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      await launchAgain(invalidReplayArgs);
      expect(fakes.app.requestSingleInstanceLock).toHaveBeenCalledTimes(2);
      expect(fakes.app.requestSingleInstanceLock).toHaveBeenLastCalledWith(
        expect.objectContaining({ error: speedError }),
      );
      expect(stderr).toHaveBeenCalledExactlyOnceWith(speedError);
      expect(fakes.app.quit).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledBefore(fakes.app.quit);
      expect(fakes.window.restore).toHaveBeenCalledOnce();
      expect(fakes.window.focus).toHaveBeenCalledOnce();
      expect(fakes.window.restore).toHaveBeenCalledBefore(fakes.window.focus);
      expect(fakes.window.focus).toHaveBeenCalledBefore(fakes.showMessageBox);
      expect(fakes.showMessageBox).toHaveBeenCalledExactlyOnceWith(
        fakes.window,
        expect.objectContaining({
          message: `The new command has invalid arguments.\n${speedError}\n\n${message}`,
        }),
      );
      expect(fakes.compose).toHaveBeenCalledOnce();
      expect(fakes.openWindow).toHaveBeenCalledOnce();
    },
  );

  it("explains how to switch when a new command corrects the running replay's parse error", async () => {
    setLaunchArguments(invalidReplayArgs);
    await import("../../src/main/main");
    await launchAgain(replayArgs);
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    expect(fakes.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      fakes.window,
      expect.objectContaining({
        message:
          "Heart on Stream is running a replay of session.jsonl.\n\nClose this window, then run the command again.",
      }),
    );
    expect(fakes.openWindow).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "linux", "win32"])(
    "quits when the last window closes on %s",
    async (platform) => {
      const previousPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        await import("../../src/main/main");
        expect(fakes.app.quit).not.toHaveBeenCalled();
        fakes.handlers["window-all-closed"]?.();
        expect(fakes.app.quit).toHaveBeenCalledOnce();
        expect(fakes.openWindow).toHaveBeenCalledOnce();
      } finally {
        Object.defineProperty(process, "platform", { value: previousPlatform });
      }
    },
  );

  it("focuses an unminimized window without lock data and tolerates a missing or destroyed window", () => {
    const currentWindow = vi.fn(
      () => fakes.window as typeof fakes.window | undefined,
    );
    const showSwitchMessage = vi.fn();
    expect(
      claimSingleInstance(
        fakes.app,
        currentWindow,
        parseLaunchOptions([]),
        showSwitchMessage,
      ),
    ).toBe(true);
    fakes.window.isMinimized.mockReturnValueOnce(false);
    fakes.emitSecondInstance(undefined);
    expect(fakes.window.restore).not.toHaveBeenCalled();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    currentWindow.mockReturnValueOnce(undefined);
    fakes.emitSecondInstance(parseLaunchOptions(["--record"]));
    fakes.window.isDestroyed.mockReturnValueOnce(true);
    fakes.emitSecondInstance(parseLaunchOptions(["--record"]));
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    expect(showSwitchMessage).not.toHaveBeenCalled();
  });
});
