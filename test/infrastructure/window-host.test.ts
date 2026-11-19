import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserWindowConstructorOptions,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContents,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSession } from "../../src/application/use-cases/stream-session";
import { createWindowHost } from "../../src/infrastructure/electron/window-host";
import { IpcSignalSource } from "../../src/infrastructure/ipc/ipc-signal-source";
import { decodeJsonlSession } from "../../src/infrastructure/replay/jsonl-session";
import { JsonlSessionRecorder } from "../../src/infrastructure/replay/jsonl-session-recorder";
import type { CameraAccessStatus } from "../../src/shared/ipc-contract";
import { pulse, fixture as sessionPorts } from "../application/fakes";

const electron = vi.hoisted(() => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle:
      vi.fn<
        (
          channel: string,
          handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
        ) => void
      >(),
    on: vi.fn<
      (channel: string, handler: (event: IpcMainEvent) => void) => void
    >(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  powerSaveBlocker: { start: vi.fn(() => 5), stop: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: vi.fn<(mediaType: "camera") => CameraAccessStatus>(),
  },
}));
vi.mock("electron", () => electron);

const appUrl = "file:///app/dist/presentation/panel/index.html?replay=0";

class FakeContents extends EventEmitter {
  readonly mainFrame = { url: appUrl };
  readonly session = {
    setPermissionRequestHandler:
      vi.fn<Session["setPermissionRequestHandler"]>(),
    setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
  };
  readonly setWindowOpenHandler = vi.fn<WebContents["setWindowOpenHandler"]>();
  readonly send = vi.fn();
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents();
  readonly loadFile = vi.fn(async () => {});
  private destroyed = false;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    const event = { preventDefault: vi.fn() };
    this.emit("close", event);
    if (!event.preventDefault.mock.calls.length) this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

const platform = process.platform;
let windows: FakeWindow[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  windows = [];
  electron.BrowserWindow.mockImplementation(function FakeWindowConstructor(
    options: BrowserWindowConstructorOptions,
  ) {
    const window = new FakeWindow(options);
    windows.push(window);
    return window;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const window of windows) window.destroy();
  vi.useRealTimers();
});

function fixture(
  replay = false,
  createMeasurementSession?: Parameters<
    typeof createWindowHost
  >[0]["createMeasurementSession"],
) {
  const bindSdk = vi.fn();
  const measurement = {
    captureGeneration: 1,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setPrivacyMode: vi.fn(async () => {}),
    setPaused: vi.fn(async (_paused: boolean) => {}),
    copyOverlayUrl: vi.fn(async () => ({
      ok: true as const,
      message: "Copied",
    })),
    exportChapters: vi.fn(async () => ({
      ok: true as const,
      message: "Saved",
    })),
    saveHighlightList: vi.fn(async () => ({
      ok: true as const,
      message: "Saved",
    })),
    deleteAllData: vi.fn(async () => ({
      ok: true as const,
      message: "Deleted",
    })),
  };
  const firstHandler = electron.ipcMain.handle.mock.calls.length;
  const firstListener = electron.ipcMain.on.mock.calls.length;
  createWindowHost({
    distRoot: "/app/dist",
    replay,
    configuration: {
      apiKey: replay ? null : "test-credential",
      public: {
        canStart: true,
        message: replay ? "REPLAY" : "Ready",
        recordByDefault: false,
      },
    },
    bindSdk,
    createMeasurementSession: createMeasurementSession ?? (() => measurement),
  });
  const window = windows.at(-1);
  if (!window) throw new Error("Missing fake window.");
  const contents = window.webContents;
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
  } as unknown as IpcMainInvokeEvent;
  function invoke(
    channel: string,
    request = event,
    selection: unknown = { metricConfig: "a", recordSession: false },
    ...args: unknown[]
  ): unknown {
    const handler = electron.ipcMain.handle.mock.calls
      .slice(firstHandler)
      .find(([name]) => name === channel)?.[1];
    if (!handler) throw new Error(`Missing handler for ${channel}`);
    return handler(request, selection, ...args);
  }
  function confirmClose() {
    const handler = electron.ipcMain.on.mock.calls.find(
      ([name]) => name === "app:close-ready",
    )?.[1];
    if (!handler) throw new Error("Missing close handler.");
    handler(event as unknown as IpcMainEvent);
  }
  function noticeEnd(request = event) {
    const handler = electron.ipcMain.on.mock.calls
      .slice(firstListener)
      .find(([name]) => name === "measurement:end-notice")?.[1];
    if (!handler) throw new Error("Missing End notice handler.");
    return handler(request as unknown as IpcMainEvent);
  }
  function requestVideo() {
    const request =
      contents.session.setPermissionRequestHandler.mock.lastCall?.[0];
    if (!request) throw new Error("Missing permission request handler.");
    const callback = vi.fn();
    request(contents as unknown as WebContents, "media", callback, {
      isMainFrame: true,
      requestingUrl: appUrl,
      mediaTypes: ["video"],
    });
    return callback.mock.lastCall?.[0];
  }
  function checkVideo() {
    const check = contents.session.setPermissionCheckHandler.mock.lastCall?.[0];
    if (!check) throw new Error("Missing permission check handler.");
    return check(contents as unknown as WebContents, "media", "file://", {
      isMainFrame: true,
      requestingUrl: appUrl,
      mediaType: "video",
    });
  }
  return {
    window,
    contents,
    event,
    bindSdk,
    measurement,
    invoke,
    confirmClose,
    noticeEnd,
    requestVideo,
    checkVideo,
  };
}

describe("Electron window host with a fake window", () => {
  it("gates video permission and Start on agreement for the lifetime of each window", async () => {
    const f = fixture();
    expect.soft(f.requestVideo()).toBe(false);
    expect.soft(f.checkVideo()).toBe(false);
    expect.soft(await f.invoke("measurement:begin")).toBeNull();
    expect.soft(f.bindSdk).not.toHaveBeenCalled();
    expect.soft(f.measurement.start).not.toHaveBeenCalled();

    await f.invoke("panel:accept-consent");
    expect(f.bindSdk).not.toHaveBeenCalled();
    expect(f.measurement.start).not.toHaveBeenCalled();
    expect(f.requestVideo()).toBe(true);
    expect(f.checkVideo()).toBe(true);
    expect(await f.invoke("measurement:begin")).toEqual({
      apiKey: "test-credential",
      captureGeneration: 1,
    });
    expect(f.bindSdk).toHaveBeenCalledOnce();
    expect(f.measurement.start).toHaveBeenCalledOnce();

    await f.invoke("measurement:end");
    expect(f.requestVideo()).toBe(true);
    expect(f.checkVideo()).toBe(true);
    expect(await f.invoke("measurement:begin")).toEqual({
      apiKey: "test-credential",
      captureGeneration: 1,
    });
    f.window.destroy();

    const next = fixture();
    expect(next.requestVideo()).toBe(false);
    expect(next.checkVideo()).toBe(false);
    expect(await next.invoke("measurement:begin")).toBeNull();
    expect(next.bindSdk).not.toHaveBeenCalled();
  });

  it("rejects agreement from other windows, subframes, and pages", async () => {
    const f = fixture();
    for (const event of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url: appUrl } },
      { ...f.event, senderFrame: null },
    ]) {
      expect(() =>
        f.invoke("panel:accept-consent", event as IpcMainInvokeEvent),
      ).toThrow("Untrusted");
    }
    f.contents.mainFrame.url = "file:///other/index.html";
    expect(() => f.invoke("panel:accept-consent")).toThrow("Untrusted");
    f.contents.mainFrame.url = appUrl;
    expect(f.requestVideo()).toBe(false);
    expect(f.checkVideo()).toBe(false);
    expect(await f.invoke("measurement:begin")).toBeNull();
    expect(f.bindSdk).not.toHaveBeenCalled();
  });

  it.each<CameraAccessStatus>([
    "not-determined",
    "granted",
    "denied",
    "restricted",
    "unknown",
  ])(
    "returns the macOS camera status %s without starting measurement",
    (status) => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      electron.systemPreferences.getMediaAccessStatus.mockReturnValue(status);
      const f = fixture();

      expect(f.invoke("camera:access-status")).toBe(status);
      expect(
        electron.systemPreferences.getMediaAccessStatus,
      ).toHaveBeenCalledExactlyOnceWith("camera");
      expect(f.bindSdk).not.toHaveBeenCalled();
      expect(f.measurement.start).not.toHaveBeenCalled();
      f.window.destroy();
      expect(electron.ipcMain.removeHandler).toHaveBeenCalledWith(
        "camera:access-status",
      );
    },
  );

  it("rejects camera status requests from outside the trusted app main frame", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const f = fixture();
    for (const event of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url: appUrl } },
      { ...f.event, senderFrame: null },
    ]) {
      expect(() =>
        f.invoke("camera:access-status", event as IpcMainInvokeEvent),
      ).toThrow("Untrusted");
    }
    f.contents.mainFrame.url = "file:///other/index.html";
    expect(() => f.invoke("camera:access-status")).toThrow("Untrusted");
    expect(
      electron.systemPreferences.getMediaAccessStatus,
    ).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"])(
    "returns unknown on %s without querying system preferences",
    (os) => {
      Object.defineProperty(process, "platform", { value: os });
      const f = fixture();

      expect(f.invoke("camera:access-status")).toBe("unknown");
      expect(
        electron.systemPreferences.getMediaAccessStatus,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["Stop", "End notice", "close", "timeout", "crash"])(
    "finishes a complete numeric recording on %s before releasing the window",
    async (action) => {
      const directory = await mkdtemp(
        join(tmpdir(), "heart-on-stream-window-"),
      );
      const ipc = new EventEmitter();
      const f = fixture(false, (_window, isTrusted) => {
        const ports = sessionPorts();
        const session = new StreamSession({
          ...ports,
          source: new IpcSignalSource<IpcMainEvent>(ipc, isTrusted),
          recorder: new JsonlSessionRecorder(join(directory, "recordings"), {
            appVersion: "0.1.0",
            metricConfig: "b",
            startTimeUs: 1_794_873_600_000_000,
          }),
        });
        return {
          get captureGeneration() {
            return session.captureGeneration;
          },
          start: (selection) =>
            session.startSession({
              consentRecorded: true,
              privacyMode: selection.privacyMode ?? "vibe",
              recordingEnabled: selection.recordSession,
            }),
          stop: () => session.stopSession(),
          setPrivacyMode: (_mode, shutdown) =>
            session.withdrawSharing(shutdown),
        };
      });
      try {
        await f.invoke("panel:accept-consent");
        await f.invoke("measurement:begin", f.event, {
          metricConfig: "b",
          recordSession: true,
        });
        const frames = Array.from(
          { length: 100 },
          (_, t) => ({ kind: "processing", status: "running", t }) as const,
        );
        const framePayload = (frame: (typeof frames)[number] | undefined) => ({
          captureGeneration: 1,
          frame,
        });
        ipc.emit(
          "frame:push",
          { ...f.event, sender: {} },
          framePayload(frames[0]),
        );
        ipc.emit(
          "frame:push",
          { ...f.event, senderFrame: { url: appUrl } },
          framePayload(frames[0]),
        );
        for (const frame of frames) {
          if (action === "End notice" && frame.t === 98) f.noticeEnd();
          ipc.emit("frame:push", f.event, framePayload(frame));
        }
        f.contents.mainFrame.url = "file:///other/index.html";
        ipc.emit("frame:push", f.event, framePayload(frames[0]));
        f.contents.mainFrame.url = appUrl;
        if (action === "Stop" || action === "End notice") {
          await f.invoke("measurement:end");
        } else if (action === "crash") {
          f.contents.emit("render-process-gone");
          await f.invoke("measurement:end");
        } else {
          if (action === "timeout") vi.useFakeTimers();
          const closed = new Promise<void>((resolve) =>
            f.window.once("closed", resolve),
          );
          f.window.close();
          if (action === "close") f.confirmClose();
          else await vi.advanceTimersByTimeAsync(3000);
          await closed;
        }
        const filenames = await readdir(join(directory, "recordings"));
        expect(filenames).toHaveLength(1);
        const contents = await readFile(
          join(directory, "recordings", filenames[0] ?? ""),
          "utf8",
        );
        expect(contents.endsWith("\n")).toBe(true);
        // Native close and its timeout also start the End drain, after every delivered frame.
        const expectedFrames =
          action === "End notice"
            ? [...frames.slice(0, 98), { kind: "drain" }, ...frames.slice(98)]
            : action === "close" || action === "timeout"
              ? [...frames, { kind: "drain" }]
              : frames;
        expect(decodeJsonlSession(contents).frames).toEqual([
          ...expectedFrames,
          { kind: "end", durationUs: 99 },
        ]);
        expect(decodeJsonlSession(contents).header.metricConfig).toBe("b");
        expect(ipc.listenerCount("frame:push")).toBe(0);
      } finally {
        if (!f.window.isDestroyed()) {
          await f.invoke("measurement:end");
          f.window.destroy();
        }
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["session:pause", "setPaused"],
    ["session:resume", "setPaused"],
    ["panel:copy-overlay", "copyOverlayUrl"],
    ["session:export", "exportChapters"],
    ["session:delete", "deleteAllData"],
    ["session:save-highlights", "saveHighlightList"],
  ] as const)(
    "routes %s only for the trusted main frame",
    async (channel, method) => {
      const f = fixture();
      for (const event of [
        { ...f.event, sender: {} },
        { ...f.event, senderFrame: { url: appUrl } },
        { ...f.event, senderFrame: null },
      ]) {
        expect(() => f.invoke(channel, event as IpcMainInvokeEvent)).toThrow(
          "Untrusted",
        );
      }
      expect(f.measurement[method]).not.toHaveBeenCalled();
      const result = await f.invoke(channel);
      expect(f.measurement[method]).toHaveBeenCalledOnce();
      if (method === "setPaused") {
        expect(f.measurement.setPaused).toHaveBeenCalledWith(
          channel === "session:pause",
        );
      } else {
        expect(result).toMatchObject({ ok: true });
      }
      f.contents.mainFrame.url = "file:///other/index.html";
      expect(() => f.invoke(channel)).toThrow("Untrusted");
      f.contents.mainFrame.url = appUrl;
      f.window.close();
      expect(() => f.invoke(channel)).toThrow("closing");
      f.confirmClose();
    },
  );

  it("validates recording options before starting any resources", () => {
    const f = fixture();
    f.invoke("panel:accept-consent");
    for (const selection of [
      null,
      {},
      [],
      { metricConfig: "c", recordSession: true },
      { metricConfig: "a", recordSession: "yes" },
    ]) {
      expect(() => f.invoke("measurement:begin", f.event, selection)).toThrow(
        "Invalid measurement options",
      );
    }
    expect(f.measurement.start).not.toHaveBeenCalled();
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("does not block suspension or return credentials after Stop overtakes an in-flight Start", async () => {
    let ready!: () => void;
    const pending = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const f = fixture(false, () => ({
      start: () => pending,
      stop: async () => {},
    }));
    await f.invoke("panel:accept-consent");
    const starting = f.invoke("measurement:begin");
    await f.invoke("measurement:end");
    ready();
    expect(await starting).toBeNull();
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("binds the SDK only at Start and keeps the window sandboxed without background throttling", async () => {
    const f = fixture();
    expect(f.bindSdk).not.toHaveBeenCalled();
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    await f.invoke("measurement:begin");
    expect(f.bindSdk).toHaveBeenCalledExactlyOnceWith(f.window);
    expect(f.window.options.acceptFirstMouse).toBe(true);
    expect(f.window.options.webPreferences).toMatchObject({
      preload: "/app/dist/preload/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    });
    const open = f.contents.setWindowOpenHandler.mock.lastCall?.[0];
    expect(open?.({} as Electron.HandlerDetails)).toEqual({ action: "deny" });
    for (const name of [
      "will-navigate",
      "will-redirect",
      "will-attach-webview",
    ]) {
      const preventDefault = vi.fn();
      f.contents.emit(name, { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("grants video checks and requests consistently and denies microphone and subframe access", () => {
    const f = fixture();
    f.invoke("panel:accept-consent");
    const request =
      f.contents.session.setPermissionRequestHandler.mock.lastCall?.[0];
    const check =
      f.contents.session.setPermissionCheckHandler.mock.lastCall?.[0];
    if (!request || !check) throw new Error("Missing permission handlers.");
    const sender = f.contents as unknown as WebContents;
    const callback = vi.fn();
    const details = {
      isMainFrame: true,
      requestingUrl: appUrl,
      mediaTypes: ["video"] as "video"[],
    };
    request(sender, "media", callback, details);
    expect(callback).toHaveBeenLastCalledWith(true);
    expect(
      check(sender, "media", "file://", {
        isMainFrame: true,
        requestingUrl: appUrl,
        mediaType: "video",
      }),
    ).toBe(true);
    request(sender, "media", callback, {
      ...details,
      mediaTypes: ["video", "audio"],
    });
    expect(callback).toHaveBeenLastCalledWith(false);
    request(sender, "media", callback, { ...details, isMainFrame: false });
    expect(callback).toHaveBeenLastCalledWith(false);
    expect(
      check(sender, "media", "file://", {
        isMainFrame: true,
        requestingUrl: appUrl,
        mediaType: "audio",
      }),
    ).toBe(false);
    expect(
      check(null, "media", "file://", {
        isMainFrame: true,
        requestingUrl: appUrl,
        mediaType: "video",
      }),
    ).toBe(false);
  });

  it("returns no key at startup, provides it only on Start, and balances power across sessions", async () => {
    const f = fixture();
    expect(f.invoke("app:configuration")).toEqual({
      canStart: true,
      message: "Ready",
      recordByDefault: false,
    });
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
    await f.invoke("panel:accept-consent");
    expect(await f.invoke("measurement:begin")).toEqual({
      apiKey: "test-credential",
      captureGeneration: 1,
    });
    await f.invoke("measurement:begin");
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledExactlyOnceWith(
      "prevent-app-suspension",
    );
    await f.invoke("measurement:end");
    await f.invoke("measurement:end");
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("denies configuration and credentials to other windows, subframes, and pages", () => {
    const f = fixture();
    for (const request of [
      { ...f.event, sender: {} },
      { ...f.event, senderFrame: { url: appUrl } },
      { ...f.event, senderFrame: null },
    ]) {
      expect(() =>
        f.invoke("measurement:begin", request as IpcMainInvokeEvent),
      ).toThrow("Untrusted");
    }
    f.contents.mainFrame.url = "file:///other/index.html";
    expect(() => f.invoke("app:configuration")).toThrow("Untrusted");
    expect(electron.powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("waits for renderer teardown on close, then releases power and IPC handlers", async () => {
    const f = fixture();
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    f.window.close();
    expect(f.window.isDestroyed()).toBe(false);
    expect(f.contents.send).toHaveBeenCalledWith("app:before-close");
    expect(f.invoke("measurement:begin")).toBeNull();
    const closed = new Promise<void>((resolve) =>
      f.window.once("closed", resolve),
    );
    f.confirmClose();
    await closed;
    expect(f.window.isDestroyed()).toBe(true);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(5);
    expect(
      electron.ipcMain.removeHandler.mock.calls.map(([name]) => name),
    ).toEqual([
      "app:configuration",
      "panel:accept-consent",
      "camera:access-status",
      "measurement:begin",
      "measurement:end",
      "session:privacy",
      "session:pause",
      "session:resume",
      "panel:copy-overlay",
      "session:export",
      "session:save-highlights",
      "session:delete",
    ]);
    expect(electron.ipcMain.removeListener.mock.calls).toEqual([
      ["app:close-ready", expect.any(Function)],
      ["measurement:end-notice", expect.any(Function)],
    ]);
  });

  it("destroys an unresponsive renderer after the close deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    f.window.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.window.isDestroyed()).toBe(true);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("releases power if the renderer crashes", async () => {
    const f = fixture();
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    f.contents.emit("render-process-gone");
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("allows replay without a credential, SDK binding, or media access", async () => {
    const f = fixture(true);
    expect(() => f.invoke("panel:accept-consent")).toThrow(
      "only available in live mode",
    );
    expect(await f.invoke("measurement:begin")).toBeNull();
    expect(f.measurement.start).toHaveBeenCalledOnce();
    expect(f.bindSdk).not.toHaveBeenCalled();
    expect(f.requestVideo()).toBe(false);
    expect(f.checkVideo()).toBe(false);
  });

  it("validates and authenticates every privacy change, including Off", async () => {
    const f = fixture();
    for (const mode of ["vibe", "numbers", "highlightsOnly", "off"]) {
      await f.invoke("session:privacy", f.event, mode);
      expect(f.measurement.setPrivacyMode).toHaveBeenLastCalledWith(mode);
    }
    for (const mode of [null, {}, "unknown", 1])
      expect(() => f.invoke("session:privacy", f.event, mode)).toThrow(
        "Invalid privacy mode",
      );
    for (const channel of [
      "app:configuration",
      "measurement:begin",
      "measurement:end",
      "session:privacy",
    ])
      expect(() =>
        f.invoke(
          channel,
          { ...f.event, sender: {} } as IpcMainInvokeEvent,
          "off",
        ),
      ).toThrow("Untrusted");
  });

  it("allows the trusted live End to withdraw while capture drains", async () => {
    const f = fixture();
    await f.invoke("session:privacy", f.event, "off", "drain");
    expect(f.measurement.setPrivacyMode).toHaveBeenCalledExactlyOnceWith(
      "off",
      "drain",
    );
    expect(f.measurement.stop).not.toHaveBeenCalled();
    expect(() => f.invoke("session:privacy", f.event, "vibe", "drain")).toThrow(
      "Invalid privacy shutdown request",
    );
    expect(() => f.invoke("session:privacy", f.event, "off", true)).toThrow(
      "Invalid privacy shutdown request",
    );
    expect(() =>
      f.invoke(
        "session:privacy",
        { ...f.event, sender: {} } as IpcMainInvokeEvent,
        "off",
        "drain",
      ),
    ).toThrow("Untrusted");
    const replay = fixture(true);
    expect(() =>
      replay.invoke("session:privacy", replay.event, "off", "drain"),
    ).toThrow("Invalid privacy shutdown request");
  });

  it("latches a trusted live End notice synchronously and idempotently", async () => {
    const main = sessionPorts();
    const f = fixture(false, () => ({
      captureGeneration: 1,
      start: () =>
        main.session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
          recordingEnabled: true,
        }),
      stop: () => main.session.stopSession(),
      setPrivacyMode: (_mode, shutdown) =>
        main.session.withdrawSharing(shutdown),
    }));
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    main.source.emit(pulse(0, 82));
    await main.session.whenIdle();

    f.noticeEnd({ ...f.event, sender: {} } as IpcMainInvokeEvent);
    f.noticeEnd({
      ...f.event,
      senderFrame: { url: appUrl },
    } as IpcMainInvokeEvent);
    f.contents.mainFrame.url = "file:///other/index.html";
    f.noticeEnd();
    f.contents.mainFrame.url = appUrl;
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    expect(f.noticeEnd()).toBeUndefined();
    const viewer = vi.fn();
    main.publisher.connect(viewer);
    f.noticeEnd();
    main.source.emit(pulse(2, 85));
    await main.session.whenIdle();
    expect(viewer).toHaveBeenCalledExactlyOnceWith({
      mode: "off",
      replay: false,
    });
    expect(main.session.panelState.pulse?.value).toBe(82);
    expect(main.recorder.stops).toBe(0);
    await f.invoke("measurement:end");
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "drain" },
      pulse(2, 85),
      { kind: "end", durationUs: 2_000_000 },
    ]);
  });

  it("latches Off on a privacy request while the window is closing", async () => {
    const main = sessionPorts();
    const f = fixture(false, () => ({
      start: () =>
        main.session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
          recordingEnabled: true,
        }),
      stop: () => main.session.stopSession(),
      setPrivacyMode: (mode, shutdown) =>
        mode === "off"
          ? main.session.withdrawSharing(shutdown)
          : main.session.setPrivacyMode(mode),
    }));
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    main.source.emit(pulse(0, 82));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    f.window.close();
    const withdrawal = f.invoke("session:privacy", f.event, "off", "drain");
    const viewer = vi.fn();
    main.publisher.connect(viewer);
    expect(viewer).toHaveBeenCalledExactlyOnceWith({
      mode: "off",
      replay: false,
    });
    await withdrawal;
    expect(f.window.isDestroyed()).toBe(false);
    expect(main.session.panelState.active).toBe(true);
    main.source.emit(pulse(2, 85));
    await main.session.whenIdle();
    expect(viewer.mock.calls.every(([state]) => state.mode === "off")).toBe(
      true,
    );

    const closed = new Promise<void>((resolve) =>
      f.window.once("closed", resolve),
    );
    f.confirmClose();
    await closed;
    expect(main.recorder.files[0]).toEqual([
      pulse(0, 82),
      { kind: "drain" },
      pulse(2, 85),
      { kind: "end", durationUs: 2_000_000 },
    ]);
  });

  it("keeps a new viewer Off while native close waits for the renderer", async () => {
    const main = sessionPorts();
    const f = fixture(false, () => ({
      start: () =>
        main.session.startSession({
          consentRecorded: true,
          privacyMode: "numbers",
          recordingEnabled: true,
        }),
      stop: () => main.session.stopSession(),
      setPrivacyMode: (_mode, shutdown) =>
        main.session.withdrawSharing(shutdown),
    }));
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    main.source.emit(pulse(0, 82));
    await main.session.whenIdle();
    expect(main.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

    const viewer = vi.fn();
    f.contents.send.mockImplementation((channel) => {
      if (channel === "app:before-close") main.publisher.connect(viewer);
    });
    const closed = new Promise<void>((resolve) =>
      f.window.once("closed", resolve),
    );
    f.window.close();
    try {
      // Hold delivery of app:before-close while another frame reaches main.
      expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(
        "app:before-close",
      );
      expect(f.window.isDestroyed()).toBe(false);
      main.source.emit(pulse(2, 85));
      await main.session.whenIdle();
      expect(viewer).toHaveBeenCalledExactlyOnceWith({
        mode: "off",
        replay: false,
      });
      expect(main.session.panelState.pulse?.value).toBe(82);
      expect(main.recorder.stops).toBe(0);
    } finally {
      f.confirmClose();
      await closed;
    }
    expect(main.recorder.files[0]).toContainEqual(pulse(2, 85));
    expect(main.recorder.files[0]?.at(-1)).toEqual({
      kind: "end",
      durationUs: 2_000_000,
    });
    expect(viewer).toHaveBeenCalledOnce();
  });

  it("starts stopping replay before contacting the renderer on native close", async () => {
    const f = fixture(true);
    await f.invoke("measurement:begin");
    f.window.close();
    expect(f.measurement.stop).toHaveBeenCalledBefore(f.contents.send);
    expect(f.measurement.setPrivacyMode).not.toHaveBeenCalled();
  });

  it("releases the power blocker when composition reports a stopped replay/session", async () => {
    let onStopped!: (active: boolean) => void;
    const f = fixture(false, (_window, _trusted, stopped) => {
      onStopped = stopped;
      return { start: async () => {}, stop: async () => {} };
    });
    await f.invoke("panel:accept-consent");
    await f.invoke("measurement:begin");
    onStopped(false);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("blocks suspension again when looped replay starts its next session", async () => {
    let activity!: (active: boolean) => void;
    const f = fixture(true, (_window, _trusted, changed) => {
      activity = changed;
      return { start: async () => {}, stop: async () => {} };
    });
    await f.invoke("measurement:begin");
    activity(false);
    activity(true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    await f.invoke("measurement:end");
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledTimes(2);
  });
});
