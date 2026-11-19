import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimSingleInstance } from "../../src/main/single-instance";

const fakes = vi.hoisted(() => {
  const order: string[] = [];
  const handlers = new Map<string, () => void>();
  const app = {
    requestSingleInstanceLock: vi.fn(() => {
      order.push("lock");
      return true;
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
    on: vi.fn((event: string, listener: () => void) => {
      handlers.set(event, listener);
    }),
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
  return { app, window, order, handlers, openWindow, compose, getAllWindows };
});

vi.mock("electron", () => ({
  app: fakes.app,
  BrowserWindow: { getAllWindows: fakes.getAllWindows },
}));
vi.mock("../../src/main/composition-root", () => ({
  composeApplication: fakes.compose,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  fakes.order.length = 0;
  fakes.handlers.clear();
});

describe("single instance startup", () => {
  it("quits immediately on a lost lock without readiness, composition or userData access", async () => {
    fakes.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    await import("../../src/main/main");
    expect(fakes.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(fakes.app.quit).toHaveBeenCalledOnce();
    expect(fakes.app.whenReady).not.toHaveBeenCalled();
    expect(fakes.compose).not.toHaveBeenCalled();
    expect(fakes.app.getPath).not.toHaveBeenCalled();
    expect(fakes.app.on).not.toHaveBeenCalled();
  });

  it("acquires the lock before composition and userData, and restores/focuses the existing window", async () => {
    await import("../../src/main/main");
    expect(fakes.order).toEqual(["lock", "ready", "compose", "userData"]);
    expect(fakes.openWindow).toHaveBeenCalledOnce();
    fakes.handlers.get("second-instance")?.();
    expect(fakes.window.restore).toHaveBeenCalledOnce();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    expect(fakes.openWindow).toHaveBeenCalledOnce();
    expect(fakes.app.quit).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"])(
    "quits when the last window closes on %s",
    async (platform) => {
      const previousPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: platform });
      try {
        await import("../../src/main/main");
        expect(fakes.app.quit).not.toHaveBeenCalled();
        fakes.handlers.get("window-all-closed")?.();
        expect(fakes.app.quit).toHaveBeenCalledOnce();
        expect(fakes.openWindow).toHaveBeenCalledOnce();
      } finally {
        Object.defineProperty(process, "platform", { value: previousPlatform });
      }
    },
  );

  it("focuses an unminimized window and tolerates a missing or destroyed window", () => {
    const currentWindow = vi.fn(
      () => fakes.window as typeof fakes.window | undefined,
    );
    expect(claimSingleInstance(fakes.app, currentWindow)).toBe(true);
    fakes.window.isMinimized.mockReturnValueOnce(false);
    fakes.handlers.get("second-instance")?.();
    expect(fakes.window.restore).not.toHaveBeenCalled();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
    currentWindow.mockReturnValueOnce(undefined);
    fakes.handlers.get("second-instance")?.();
    fakes.window.isDestroyed.mockReturnValueOnce(true);
    fakes.handlers.get("second-instance")?.();
    expect(fakes.window.focus).toHaveBeenCalledOnce();
  });
});
