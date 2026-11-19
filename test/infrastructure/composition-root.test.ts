import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, IpcMainEvent } from "electron";
import OBSWebSocket, { OBSWebSocketError } from "obs-websocket-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import type { OverlayState } from "../../src/domain/privacy/index";
import type { Highlight, SessionRecord } from "../../src/domain/session/index";
import type {
  createWindowHost,
  MeasurementSession,
} from "../../src/infrastructure/electron/window-host";
import { OverlayServerStartError } from "../../src/infrastructure/overlay/overlay-server";
import { encodeJsonlSession } from "../../src/infrastructure/replay/jsonl-session";
import { composeApplication } from "../../src/main/composition-root";
import { parseLaunchOptions } from "../../src/main/launch-options";
import { multipleFacesMessage } from "../../src/presentation/panel/screen-flow";
import type { PanelStatePayload } from "../../src/shared/ipc-contract";
import { at, deferred, pulse } from "../application/fakes";

const adapters = vi.hoisted(() => ({
  loadConfiguration: vi.fn(
    (_: unknown, replay: boolean, recordByDefault: boolean) => ({
      apiKey: replay ? null : "test-credential",
      public: { canStart: true, message: "Ready", recordByDefault },
    }),
  ),
  createWindowHost: vi.fn<typeof createWindowHost>(),
  bindSmartSpectraIpc: vi.fn(),
  loadSmartSpectra: vi.fn(),
  app: {
    getPath: vi.fn(() => "/fake/userData"),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  globalShortcut: {
    register: vi.fn<(key: string, callback: () => void) => boolean>(() => true),
    unregister: vi.fn(),
  },
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  recorder: {
    filePath: "/project/recordings/session.jsonl",
    start: vi.fn(async () => {}),
    append: vi.fn(async (_frame: SessionRecord) => {}),
    stop: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => {}),
  },
  publisher: {
    start: vi.fn(async () => ({})),
    publish: vi.fn(async (_state: OverlayState) => {}),
    stop: vi.fn(async () => {}),
  },
  marker: {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    subscribeStatus: vi.fn(),
    captureRecording: vi.fn(() => null),
    createChapter: vi.fn(async () => ({
      status: "unavailable",
      reason: "disconnected",
    })),
  },
  highlights: {
    list: vi.fn(async (): Promise<Highlight[]> => []),
    append: vi.fn(async (_highlight: Highlight) => {}),
    updateRecordingOffset: vi.fn(
      async (_highlight: Highlight, _offset: number) => {},
    ),
    deleteAll: vi.fn(async () => {}),
  },
  JsonlSessionRecorder: vi.fn(),
  OverlayServer: vi.fn(),
  ObsWebsocketMarker: vi.fn(),
  FsHighlightRepository: vi.fn(),
}));
vi.mock("../../src/infrastructure/electron/configuration", () => adapters);
vi.mock("../../src/infrastructure/electron/window-host", () => adapters);
vi.mock("node:module", async (original) => ({
  ...(await original<typeof import("node:module")>()),
  createRequire: () => adapters.loadSmartSpectra,
}));
vi.mock("@smartspectra/node-sdk/main", () => {
  adapters.loadSmartSpectra();
  return adapters;
});
vi.mock("electron", () => adapters);
vi.mock(
  "../../src/infrastructure/replay/jsonl-session-recorder",
  () => adapters,
);
vi.mock(
  "../../src/infrastructure/overlay/overlay-server",
  async (original) => ({
    ...(await original<object>()),
    OverlayServer: adapters.OverlayServer,
  }),
);
vi.mock("../../src/infrastructure/obs/obs-websocket-marker", () => adapters);
vi.mock(
  "../../src/infrastructure/storage/fs-highlight-repository",
  () => adapters,
);

const sdkLoadedBeforeComposition = adapters.loadSmartSpectra.mock.calls.length;
const sessions: MeasurementSession[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  adapters.loadSmartSpectra.mockReturnValue(adapters);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  for (const [adapterConstructor, instance] of [
    [adapters.JsonlSessionRecorder, adapters.recorder],
    [adapters.OverlayServer, adapters.publisher],
    [adapters.ObsWebsocketMarker, adapters.marker],
    [adapters.FsHighlightRepository, adapters.highlights],
  ] as const)
    adapterConstructor.mockImplementation(function FakeAdapter() {
      return instance;
    });
  adapters.marker.subscribeStatus.mockImplementation((listener) => {
    listener({ message: "OBS is disconnected." });
    return () => {};
  });
});
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.stop();
    await session.dispose?.();
  }
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function fixture(args: string[] = [], hasRecordedConsent = () => true) {
  const application = composeApplication(parseLaunchOptions(args));
  application.openWindow();
  const options = adapters.createWindowHost.mock.lastCall?.[0];
  if (!options) throw new Error("Missing window composition");
  const send = vi.fn();
  const events = new Map<string, () => void>();
  const window = {
    isDestroyed: () => false,
    webContents: {
      send,
      on: (name: string, callback: () => void) => events.set(name, callback),
      removeListener: vi.fn(),
    },
  } as unknown as BrowserWindow;
  const trusted = {};
  const onStopped = vi.fn();
  const session = options.createMeasurementSession(
    window,
    (event) => event === trusted,
    onStopped,
    hasRecordedConsent,
  );
  sessions.push(session);
  events.get("did-finish-load")?.();
  const panels = () =>
    send.mock.calls
      .filter(([channel]) => channel === "panel:state")
      .map(([, state]) => state as PanelStatePayload);
  function pushFrame(
    frame: unknown,
    captureGeneration = panels().at(-1)?.runtime?.captureGeneration,
  ): void {
    const receive = adapters.ipcMain.on.mock.calls.find(
      ([channel]) => channel === "frame:push",
    )?.[1] as (event: IpcMainEvent, payload: unknown) => void;
    receive(trusted as IpcMainEvent, { frame, captureGeneration });
  }
  return {
    application,
    options,
    window,
    session,
    trusted,
    onStopped,
    panels,
    send,
    pushFrame,
  };
}

const selection = {
  metricConfig: "b",
  recordSession: false,
  privacyMode: "vibe",
} as const;
const replayFixture = fileURLToPath(
  new URL("../fixtures/replay/synthetic-spike.jsonl", import.meta.url),
);

const obsConnection = {
  obsWebSocketVersion: "5.5.0",
  rpcVersion: 1,
  negotiatedRpcVersion: 1,
};

async function useRealObsMarker() {
  const { ObsWebsocketMarker } = await vi.importActual<
    typeof import("../../src/infrastructure/obs/obs-websocket-marker")
  >("../../src/infrastructure/obs/obs-websocket-marker");
  adapters.ObsWebsocketMarker.mockImplementationOnce(function RealMarker(
    options: ConstructorParameters<typeof ObsWebsocketMarker>[0],
  ) {
    return new ObsWebsocketMarker(options);
  });
  return vi
    .spyOn(OBSWebSocket.prototype, "connect")
    .mockResolvedValue(obsConnection);
}

describe("main-process composition", () => {
  it("opens and starts replay without loading the SmartSpectra main module", async () => {
    const f = fixture(["--replay", replayFixture]);
    await f.session.start(selection);
    expect(f.panels().at(-1)).toMatchObject({ active: true, replay: true });
    expect(sdkLoadedBeforeComposition).toBe(0);
    expect(adapters.loadSmartSpectra).not.toHaveBeenCalled();
  });

  it("passes the window's current consent state to the live session", async () => {
    let agreed = false;
    const f = fixture([], () => agreed);
    await expect(
      f.session.start({ ...selection, recordSession: true }),
    ).rejects.toThrow("Recorded consent is required");
    expect(adapters.ipcMain.on).not.toHaveBeenCalled();
    expect(adapters.JsonlSessionRecorder).not.toHaveBeenCalled();
    expect(f.panels().at(-1)?.active).toBe(false);

    agreed = true;
    await f.session.start(selection);
    expect(f.panels().at(-1)?.active).toBe(true);
  });

  it("retains SDK startup from the current IPC capture through End and ignores a prior session's frames", async () => {
    const f = fixture();
    await f.session.start(selection);
    const generation = f.session.captureGeneration;
    f.pushFrame({ kind: "processing", status: "idle", t: at(0) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.panels().at(-1)).toMatchObject({
      active: true,
      sdkStarted: false,
      runtime: { sessionStartedAt: at(0) },
    });

    await f.session.setPrivacyMode?.("off", "drain");
    f.pushFrame({ kind: "processing", status: "starting", t: at(1) });
    await f.session.stop();
    expect(f.panels().at(-1)).toMatchObject({
      active: false,
      processing: "idle",
      sdkStarted: true,
    });

    await f.session.start(selection);
    f.pushFrame(
      { kind: "processing", status: "running", t: at(2) },
      generation,
    );
    await f.session.stop();
    expect(f.panels().at(-1)).toMatchObject({
      active: false,
      sdkStarted: false,
    });
  });

  it("wires all ports and opt-in recording, forwards ordered IPC frames and panel snapshots", async () => {
    vi.stubEnv("OBS_WS_URL", "ws://127.0.0.1:4455");
    vi.stubEnv("OBS_WS_PASSWORD", "fake-password");
    vi.stubEnv("OVERLAY_PORT", "7788");
    const f = fixture(["--record"]);
    expect(adapters.JsonlSessionRecorder).not.toHaveBeenCalled();
    expect(adapters.OverlayServer).toHaveBeenCalledWith(
      join(f.options.distRoot, "presentation/overlay"),
      { port: 7788 },
    );
    expect(adapters.ObsWebsocketMarker).toHaveBeenCalledWith({
      client: expect.anything(),
      url: "ws://127.0.0.1:4455",
      password: "fake-password",
    });
    expect(process.env.OBS_WS_PASSWORD).toBeUndefined();
    expect(adapters.FsHighlightRepository).toHaveBeenCalledWith(
      "/fake/userData",
    );
    await f.session.start(selection);
    expect(adapters.JsonlSessionRecorder).toHaveBeenCalledWith(
      join(process.cwd(), "recordings"),
      {
        appVersion: packageJson.version,
        metricConfig: "(b) Config (a) + chest breathing, breathing rate",
        startTimeUs: Date.now() * 1000,
      },
    );
    expect(f.send).toHaveBeenCalledWith("recording:state", {
      active: true,
      filePath: adapters.recorder.filePath,
      error: "",
    });
    const frames = [
      { kind: "processing", t: 1, status: "running" },
      { kind: "validation", t: 2, code: "ok", hint: "Ready" },
    ];
    for (const frame of frames) f.pushFrame(frame);
    await f.session.stop();
    expect(adapters.recorder.append.mock.calls).toEqual([
      ...frames.map((frame) => [frame]),
      [{ kind: "end", durationUs: 1 }],
    ]);
    expect(adapters.recorder.stop).toHaveBeenCalledOnce();
    expect(f.panels().at(-1)).toMatchObject({
      active: false,
      replay: false,
      runtime: {
        overlayUrl: "http://127.0.0.1:7788/overlay",
        obsMessage: "OBS is disconnected.",
      },
    });
  });

  it.each(["wss://example.com:4455", "ws://192.168.1.20:4455"])(
    "reports invalid OBS_WS_URL %j in the startup panel without contacting OBS",
    async (url) => {
      vi.stubEnv("OBS_WS_URL", url);
      vi.stubEnv("OBS_WS_PASSWORD", "fake-password");
      const { ObsWebsocketMarker } = await vi.importActual<
        typeof import("../../src/infrastructure/obs/obs-websocket-marker")
      >("../../src/infrastructure/obs/obs-websocket-marker");
      adapters.ObsWebsocketMarker.mockImplementationOnce(function RealMarker(
        options: ConstructorParameters<typeof ObsWebsocketMarker>[0],
      ) {
        return new ObsWebsocketMarker(options);
      });
      const connect = vi.spyOn(OBSWebSocket.prototype, "connect");
      const warn = vi.spyOn(console, "warn");
      connect.mockRejectedValue(new Error("Unexpected OBS connection"));
      try {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(connect).not.toHaveBeenCalled();
        expect(f.panels().at(-1)?.runtime?.obsMessage).toContain(
          "Set OBS_WS_URL to a ws:// URL",
        );
        expect(JSON.stringify(f.send.mock.calls)).not.toContain(
          "fake-password",
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it("treats an empty OBS_WS_URL as the loopback default", () => {
    vi.stubEnv("OBS_WS_URL", "");
    fixture();
    expect(adapters.ObsWebsocketMarker.mock.lastCall?.[0]).not.toHaveProperty(
      "url",
    );
  });

  it("propagates a second-face frame through IPC to a paused panel and overlay immediately", async () => {
    const f = fixture();
    await f.session.start(selection);
    f.pushFrame({
      kind: "validation",
      t: 1,
      code: "multipleFacesFound",
      hint: "Keep one face in view",
    });
    await f.session.setPrivacyMode?.("vibe");
    const state = f.panels().at(-1);
    expect(state).toMatchObject({
      active: true,
      phase: "paused",
      validation: { code: "multipleFacesFound" },
    });
    if (!state) throw new Error("Missing panel state");
    expect(multipleFacesMessage(state)).toBe(
      "Measurement paused: more than one face in view",
    );
    expect(adapters.publisher.publish.mock.lastCall?.[0]).toMatchObject({
      mode: "vibe",
      status: "paused",
    });
  });

  it("requires OK from the reopened capture even if the old capture reports OK after Resume", async () => {
    const f = fixture();
    const start = Date.now() * 1_000;
    await f.session.start({
      ...selection,
      privacyMode: "numbers",
      recordSession: true,
    });
    const oldGeneration = f.panels().at(-1)?.runtime?.captureGeneration;
    expect(oldGeneration).toEqual(expect.any(Number));
    const ok = (t: number) => ({
      kind: "validation",
      code: "ok",
      hint: "Ready",
      t,
    });
    const reading = (offset: number, bpm: number) =>
      pulse(0, bpm, { t: start + offset });
    f.pushFrame(ok(start));
    f.pushFrame(reading(0, 82));
    await f.session.setPrivacyMode?.("numbers");
    await f.session.setPaused?.(true);
    expect(
      adapters.publisher.publish.mock.calls.some(
        ([state]) => "pulseBpm" in state && state.pulseBpm === 82,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const resumedAt = Date.now() * 1_000;
    await f.session.setPaused?.(false);
    const afterResume = adapters.publisher.publish.mock.calls.length;
    const newGeneration = f.panels().at(-1)?.runtime?.captureGeneration;
    expect(newGeneration).toBe((oldGeneration ?? 0) + 1);
    const staleOk = ok(resumedAt + 5_000);
    const stalePulse = reading(1_006_000, 99);
    f.pushFrame(staleOk, oldGeneration); // The previous SDK is still stopping.
    f.pushFrame(stalePulse, oldGeneration);
    f.pushFrame(reading(1_010_000, 85)); // First pulse from the reopened SDK.
    await f.session.setPrivacyMode?.("numbers");
    expect(
      adapters.publisher.publish.mock.calls
        .slice(afterResume)
        .some(([state]) => "pulseBpm" in state && state.pulseBpm !== null),
    ).toBe(false);
    expect(adapters.recorder.append).not.toHaveBeenCalledWith(staleOk);
    expect(adapters.recorder.append).not.toHaveBeenCalledWith(stalePulse);
    expect(adapters.recorder.append).toHaveBeenCalledWith(
      reading(1_010_000, 85),
    );
    expect(f.panels().at(-1)?.validation?.t).toBe(start);

    f.pushFrame(ok(resumedAt + 15_000));
    f.pushFrame(reading(1_020_000, 86));
    await f.session.setPrivacyMode?.("numbers");
    expect(adapters.publisher.publish.mock.lastCall?.[0]).toMatchObject({
      pulseBpm: 86,
    });
    await f.session.stop();
    await f.session.start(selection);
    expect(f.panels().at(-1)?.runtime?.captureGeneration).toBe(
      (newGeneration ?? 0) + 1,
    );
  });

  it("reflects global pause and privacy changes through panel:state and reports registration failures", async () => {
    const f = fixture();
    const pause = adapters.globalShortcut.register.mock.calls.find(([key]) =>
      key.endsWith("+P"),
    )?.[1];
    const privacy = adapters.globalShortcut.register.mock.calls.find(([key]) =>
      key.endsWith("+M"),
    )?.[1];
    pause?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.panels().at(-1)?.pauseReason).toBeNull();
    await f.session.start(selection);
    pause?.();
    privacy?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.panels().at(-1)).toMatchObject({
      pauseReason: "manual",
      privacyMode: "numbers",
      runtime: { shortcutMessage: "" },
    });
    adapters.globalShortcut.register.mockReturnValueOnce(false);
    const other = fixture();
    expect(other.panels().at(-1)?.runtime?.shortcutMessage).toContain(
      "Shortcut unavailable",
    );
  });

  it("schedules the 60-second pause from a lone validation event and cancels it on End", async () => {
    const f = fixture();
    await f.session.start({ ...selection, recordSession: true });
    const invalid = () =>
      f.pushFrame({
        kind: "validation",
        t: Date.now() * 1000,
        code: "tooDark",
        hint: "More light",
      });
    invalid();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.panels().at(-1)?.pauseReason).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.panels().at(-1)).toMatchObject({
      active: true,
      pauseReason: "unusableInput",
      recording: true,
    });
    expect(adapters.publisher.publish.mock.lastCall?.[0]).toMatchObject({
      mode: "vibe",
      status: "paused",
    });
    await f.session.setPaused?.(false);
    expect(f.panels().at(-1)?.pauseReason).toBeNull();
    invalid();
    await vi.advanceTimersByTimeAsync(0);
    await f.session.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.panels().at(-1)).toMatchObject({
      active: false,
      pauseReason: null,
    });
    expect(adapters.recorder.start).toHaveBeenCalledOnce();
    expect(adapters.recorder.stop).toHaveBeenCalledOnce();
  });

  it.each(["deadline first", "hotkey first"] as const)(
    "keeps capture paused when a Pause hotkey and auto-pause queue up (%s)",
    async (order) => {
      const f = fixture();
      await f.session.start({ ...selection, recordSession: true });
      const pause = adapters.globalShortcut.register.mock.calls.find(([key]) =>
        key.endsWith("+P"),
      )?.[1];
      const privacy = adapters.globalShortcut.register.mock.calls.find(
        ([key]) => key.endsWith("+M"),
      )?.[1];
      f.pushFrame({
        kind: "validation",
        t: Date.now() * 1000,
        code: "tooDark",
        hint: "More light",
      });
      await vi.advanceTimersByTimeAsync(0);

      let release!: () => void;
      const append = new Promise<void>((resolve) => {
        release = resolve;
      });
      adapters.recorder.append.mockReturnValueOnce(append);
      f.pushFrame({
        kind: "processing",
        t: Date.now() * 1000,
        status: "running",
      });
      await vi.advanceTimersByTimeAsync(0);
      const beforeShortcuts = f.panels().length;
      privacy?.();
      try {
        if (order === "hotkey first") pause?.();
        await vi.advanceTimersByTimeAsync(60_000);
        if (order === "deadline first") pause?.();
        expect(f.panels().at(-1)).toMatchObject({
          active: true,
          pauseReason: null,
          privacyMode: "vibe",
        });
      } finally {
        release();
      }
      await vi.advanceTimersByTimeAsync(0);
      const afterShortcuts = f.panels().slice(beforeShortcuts);
      const reason = order === "deadline first" ? "unusableInput" : "manual";
      const latch = afterShortcuts.findIndex(
        (state) => state.pauseReason === reason,
      );
      expect(latch).toBeGreaterThanOrEqual(0);
      expect(afterShortcuts.at(-1)?.privacyMode).toBe("numbers");
      expect(
        afterShortcuts
          .slice(latch)
          .every((state) => state.pauseReason === reason),
      ).toBe(true);
    },
  );

  it("keeps recording off without opt-in and keeps credentials in main across windows", async () => {
    vi.stubEnv("SMARTSPECTRA_API_KEY", "test-credential");
    const f = fixture();
    expect(process.env.SMARTSPECTRA_API_KEY).toBeUndefined();
    await f.session.start(selection);
    await f.session.stop();
    expect(adapters.JsonlSessionRecorder).not.toHaveBeenCalled();
    f.application.openWindow();
    expect(adapters.loadConfiguration).toHaveBeenCalledOnce();
    for (const [options] of adapters.createWindowHost.mock.calls) {
      expect(options.configuration.apiKey).toBe("test-credential");
    }
    expect(sdkLoadedBeforeComposition).toBe(0);
    expect(adapters.loadSmartSpectra).not.toHaveBeenCalled();
    f.options.bindSdk(f.window);
    expect(adapters.loadSmartSpectra).toHaveBeenCalledExactlyOnceWith(
      "@smartspectra/node-sdk/main",
    );
    expect(adapters.bindSmartSpectraIpc).toHaveBeenCalledExactlyOnceWith(
      f.window,
    );
  });

  it("keeps measuring when overlay startup fails and shows the typed message", async () => {
    adapters.publisher.start.mockRejectedValueOnce(
      new OverlayServerStartError(
        7777,
        Object.assign(new Error("busy"), { code: "EADDRINUSE" }),
      ),
    );
    const f = fixture();
    await f.session.start(selection);
    expect(f.panels().at(-1)).toMatchObject({
      active: true,
      runtime: { overlayError: expect.stringContaining("already in use") },
    });
  });

  it("keeps the first Start selection during duplicate requests and drains an overtaking Stop", async () => {
    const f = fixture(["--record"]);
    await Promise.all([
      f.session.start(selection),
      f.session.start({
        metricConfig: "a",
        recordSession: false,
        privacyMode: "numbers",
      }),
      f.session.stop(),
    ]);
    expect(adapters.JsonlSessionRecorder).toHaveBeenCalledOnce();
    expect(adapters.JsonlSessionRecorder.mock.lastCall?.[1]).toMatchObject({
      metricConfig: "(b) Config (a) + chest breathing, breathing rate",
    });
    expect(f.panels().at(-1)?.active).toBe(false);
  });

  it("shows decoder line information for a truncated file without failing window creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hos-composition-"));
    try {
      const path = join(directory, "truncated.jsonl");
      await writeFile(path, '{"format":"heart-on-stream"}');
      const f = fixture(["--replay", path]);
      expect(f.options.configuration.public.canStart).toBe(false);
      expect(f.options.configuration.public.message).toContain(
        "JSONL line 1: truncated record",
      );
      expect(f.panels().at(-1)?.runtime?.replayMessage).toContain(
        "JSONL line 1: truncated record",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drives the synthetic spike end to end through real replay and StreamSession, with privacy projection and local highlight", async () => {
    const f = fixture(
      [
        "--replay",
        "test/fixtures/replay/synthetic-spike.jsonl",
        "--speed=20",
        "--record",
      ],
      () => false,
    );
    await f.session.start({ ...selection, recordSession: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.panels().at(-1)).toMatchObject({
      replay: true,
      active: true,
      phase: "live",
      baselineBpm: expect.closeTo(70),
      runtime: { replayFile: "synthetic-spike.jsonl" },
    });
    expect(f.panels().at(-1)?.runtime).not.toHaveProperty("captureGeneration");
    await f.session.setPrivacyMode?.("numbers");
    await vi.advanceTimersByTimeAsync(50);
    expect(adapters.publisher.publish.mock.lastCall?.[0]).toMatchObject({
      mode: "numbers",
      replay: true,
    });
    await f.session.setPrivacyMode?.("vibe");
    await vi.advanceTimersByTimeAsync(1950);
    expect(adapters.highlights.append).toHaveBeenCalledOnce();
    expect(adapters.highlights.append.mock.lastCall?.[0]).toMatchObject({
      label: expect.stringMatching(/^spike \+18 vs baseline$/u),
      recordingOffsetMs: null,
    });
    expect(adapters.marker.createChapter).toHaveBeenCalledOnce();
    expect(adapters.JsonlSessionRecorder).not.toHaveBeenCalled();
    expect(f.panels().at(-1)).toMatchObject({
      active: false,
      replay: true,
      runtime: { replayMessage: "Replay finished" },
    });
    const states = adapters.publisher.publish.mock.calls.map(
      ([state]) => state,
    );
    expect(states.every((state) => state.replay)).toBe(true);
    for (const state of states.filter((state) => state.mode === "vibe")) {
      expect(Object.keys(state).sort()).toEqual([
        "beatWave",
        "breathWave",
        "intensity",
        "mode",
        "replay",
        "status",
      ]);
    }
  });

  it("counts only highlights produced by this replay run even when earlier runs have identical timestamps", async () => {
    const f = fixture(["--replay", replayFixture, "--speed=20"]);
    const saved: Highlight[] = [];
    await adapters.highlights.list.withImplementation(
      async () => saved.slice(),
      async () => {
        await adapters.highlights.append.withImplementation(
          async (highlight) => {
            saved.push(highlight);
          },
          async () => {
            for (let run = 0; run < 2; run++) {
              await f.session.start(selection);
              await vi.advanceTimersByTimeAsync(6000);
              expect(f.panels().at(-1)?.active).toBe(false);
              expect(f.panels().at(-1)?.highlights).toHaveLength(1);
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: false,
                message: expect.stringContaining("Too few chapters"),
              });
            }
          },
        );
      },
    );
    expect(saved).toHaveLength(2);
    expect(saved[0]?.sessionStartedAt).toBe(saved[1]?.sessionStartedAt);
  });

  it("excludes a prior run with the same origin from chapter export", async () => {
    const f = fixture(["--replay", replayFixture, "--speed=20"]);
    const prior: Highlight = {
      t: 1794873620000000,
      sessionStartedAt: 1794873600000000,
      sessionOffsetUs: 20_000_000,
      recordingOffsetMs: null,
      label: "prior run",
      deltaBpm: 17,
      talkingRecent: false,
    };
    const saved = [prior];
    const dialog = vi.fn(async () => ({ canceled: true }));
    await adapters.dialog.showSaveDialog.withImplementation(
      dialog,
      async () => {
        await adapters.highlights.list.withImplementation(
          async () => saved.slice(),
          async () => {
            await adapters.highlights.append.withImplementation(
              async (highlight) => {
                saved.push(highlight);
              },
              async () => {
                await f.session.start(selection);
                await vi.advanceTimersByTimeAsync(6000);
                expect(f.panels().at(-1)?.highlights).toEqual([saved[1]]);
                expect(await f.session.exportChapters?.()).toMatchObject({
                  ok: false,
                  message: expect.stringContaining("Too few chapters"),
                });
                expect(dialog).not.toHaveBeenCalled();
              },
            );
          },
        );
      },
    );
  });

  it.each([
    { event: "start", drain: true },
    { event: "split", drain: true },
    { event: "start", drain: false },
  ])(
    "exports replay with OBS $event at 142 s (drain $drain)",
    async ({ event, drain }) => {
      const connect = await useRealObsMarker();
      let recordingStartedAtMs: number | null = null;
      const call = vi
        .spyOn(OBSWebSocket.prototype, "call")
        .mockImplementation(async (request) => {
          if (request !== "GetRecordStatus") return undefined;
          return {
            outputActive: recordingStartedAtMs !== null,
            outputPaused: false,
            outputDuration:
              recordingStartedAtMs === null
                ? 0
                : performance.now() - recordingStartedAtMs,
          };
        });
      const directory = await mkdtemp(join(tmpdir(), "hos-replay-overlap-"));
      const replayPath = join(directory, "session.jsonl");
      const exportPath = join(directory, "chapters.txt");
      try {
        const frames: SessionRecord[] = Array.from(
          { length: 142 },
          (_, second) => {
            const elevated =
              (second >= 55 && second <= 60) ||
              (second >= 125 && second <= 130);
            return pulse(second, elevated ? 88 : 70);
          },
        );
        if (drain) frames.push({ kind: "drain" });
        frames.push({ kind: "end", durationUs: 145_000_000 });
        await writeFile(
          replayPath,
          encodeJsonlSession({
            header: {
              format: "heart-on-stream",
              version: 2,
              appVersion: packageJson.version,
              metricConfig: "synthetic",
              startTimeUs: at(0),
            },
            frames,
          }),
        );
        const f = fixture(["--replay", replayPath]);
        const socket = connect.mock.contexts[0] as OBSWebSocket;
        await vi.advanceTimersByTimeAsync(0);
        function startObs(): void {
          recordingStartedAtMs = performance.now();
          socket.emit("RecordStateChanged", {
            outputActive: true,
            outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
            outputPath: "file-a.mp4",
          });
        }
        if (event === "split") startObs();
        await f.session.start(selection);
        await vi.advanceTimersByTimeAsync(142_000);
        expect(f.panels().at(-1)?.highlights).toMatchObject(
          [60, 130].map((second) => ({
            sessionOffsetUs: second * 1_000_000,
            recordingOffsetMs: event === "split" ? second * 1_000 : null,
          })),
        );
        if (event === "split")
          socket.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
        else startObs();
        await vi.advanceTimersByTimeAsync(2_999);
        expect(f.panels().at(-1)?.active).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.panels().at(-1)).toMatchObject({
          active: false,
          runtime: { replayMessage: "Replay finished" },
        });
        await adapters.dialog.showSaveDialog.withImplementation(
          async () => ({ canceled: false, filePath: exportPath }),
          async () => {
            if (drain) {
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: true,
              });
              expect(await readFile(exportPath, "utf8")).toBe(
                "00:00 Intro\n01:00 spike +18 vs baseline\n02:10 spike +18 vs baseline",
              );
            } else {
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: false,
                message: expect.stringContaining("Too few chapters"),
              });
            }
          },
        );
      } finally {
        connect.mockRestore();
        call.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { state: "STOPPING", retryInFlight: false },
    { state: "STOPPED", retryInFlight: true },
  ])(
    "ignores the profile selected after OBS $state",
    async ({ state, retryInFlight }) => {
      const connect = await useRealObsMarker();
      const connection = deferred<typeof obsConnection>();
      connect.mockReturnValueOnce(connection.promise);
      const retryReply = deferred<void>();
      const recording = {
        outputActive: true,
        outputPaused: false,
        outputDuration: 600_000,
      };
      let splitSettingRequests = 0;
      let splittingEnabled = true;
      const call = vi
        .spyOn(OBSWebSocket.prototype, "call")
        .mockImplementation(async (request, data) => {
          if (request === "GetRecordStatus") return { ...recording };
          if (request === "CreateRecordChapter") return undefined;
          if (
            request !== "GetProfileParameter" ||
            !data ||
            !("parameterName" in data)
          )
            throw new Error(`Unexpected OBS request: ${request}`);
          let value = "Advanced";
          if (data.parameterName === "RecSplitFile") {
            splitSettingRequests++;
            if (splitSettingRequests === 1)
              await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
            else await retryReply.promise;
            value = String(splittingEnabled);
          }
          return { parameterValue: value, defaultParameterValue: value };
        });
      const directory = await mkdtemp(join(tmpdir(), "hos-obs-stop-profile-"));
      const exportPath = join(directory, "timestamps.txt");
      try {
        const f = fixture();
        const socket = connect.mock.contexts[0] as OBSWebSocket;
        await f.session.start(selection);
        for (let second = 0; second <= 60; second++) {
          recording.outputDuration = 600_000 + second * 1_000;
          if (second > 0) await vi.advanceTimersByTimeAsync(1_000);
          if (second === 55) connection.resolve(obsConnection);
          f.pushFrame(pulse(second, second >= 55 ? 88 : 70));
        }
        await vi.advanceTimersByTimeAsync(retryInFlight ? 1_000 : 100);
        expect(
          call.mock.calls.filter(
            ([request]) => request === "CreateRecordChapter",
          ),
        ).toHaveLength(1);
        expect(f.panels().at(-1)?.highlights).toMatchObject([
          { sessionOffsetUs: 60_000_000, recordingOffsetMs: null },
        ]);
        const requestsBeforeStop = retryInFlight ? 2 : 1;
        expect(splitSettingRequests).toBe(requestsBeforeStop);
        recording.outputActive = false;
        socket.emit("RecordStateChanged", {
          outputActive: false,
          outputState: `OBS_WEBSOCKET_OUTPUT_${state}`,
          outputPath: "file-b.mp4",
        });
        splittingEnabled = false;
        retryReply.resolve();
        await vi.advanceTimersByTimeAsync(10_000);
        await f.session.stop();
        await adapters.dialog.showSaveDialog.withImplementation(
          async () => ({ canceled: false, filePath: exportPath }),
          async () => {
            expect(await f.session.saveHighlightList?.()).toMatchObject({
              ok: true,
            });
            expect(
              (await readFile(exportPath, "utf8")).split("\n").at(-1),
            ).toBe("01:00 spike +18 vs baseline");
          },
        );
        expect(splitSettingRequests).toBe(requestsBeforeStop);
        expect(
          adapters.highlights.updateRecordingOffset,
        ).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        call.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("offers the plain list when OBS was paused for every spike in a 65-second recording", async () => {
    const { ObsWebsocketMarker } = await vi.importActual<
      typeof import("../../src/infrastructure/obs/obs-websocket-marker")
    >("../../src/infrastructure/obs/obs-websocket-marker");
    adapters.ObsWebsocketMarker.mockImplementationOnce(function RealMarker(
      options: ConstructorParameters<typeof ObsWebsocketMarker>[0],
    ) {
      return new ObsWebsocketMarker(options);
    });
    const recording = {
      outputActive: false,
      outputPaused: false,
      outputDuration: 0,
    };
    const connect = vi
      .spyOn(OBSWebSocket.prototype, "connect")
      .mockResolvedValue({
        obsWebSocketVersion: "5.5.0",
        rpcVersion: 1,
        negotiatedRpcVersion: 1,
      });
    const call = vi
      .spyOn(OBSWebSocket.prototype, "call")
      .mockImplementation(async (request) =>
        request === "GetRecordStatus" ? { ...recording } : undefined,
      );
    const directory = await mkdtemp(join(tmpdir(), "heart-on-stream-export-"));
    const path = join(directory, "highlights.txt");
    try {
      const f = fixture();
      const socket = connect.mock.contexts[0] as OBSWebSocket;
      await f.session.start(selection);
      recording.outputActive = true;
      socket.emit("RecordStateChanged", {
        outputActive: true,
        outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
        outputPath: "",
      });
      const spikes = [60, 130, 200];
      for (let second = 0; second <= 208; second++) {
        recording.outputDuration =
          Math.min(second, 58) * 1_000 + Math.max(0, second - 201) * 1_000;
        if (second > 0) await vi.advanceTimersByTimeAsync(1_000);
        if (second === 58 || second === 201) {
          const paused = second === 58;
          recording.outputActive = !paused;
          recording.outputPaused = paused;
          socket.emit("RecordStateChanged", {
            outputActive: !paused,
            outputState: paused
              ? "OBS_WEBSOCKET_OUTPUT_PAUSED"
              : "OBS_WEBSOCKET_OUTPUT_RESUMED",
            outputPath: "",
          });
        }
        if (second <= 203) {
          const elevated = spikes.some(
            (spike) => second >= spike - 5 && second <= spike,
          );
          f.pushFrame(pulse(second, elevated ? 88 : 70));
        }
        if (second === 203) await f.session.stop();
      }
      expect(recording.outputDuration).toBe(65_000);
      recording.outputActive = false;
      socket.emit("RecordStateChanged", {
        outputActive: false,
        outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED",
        outputPath: "",
      });
      expect(f.panels().at(-1)?.highlights).toMatchObject(
        spikes.map((second) => ({
          sessionOffsetUs: second * 1_000_000,
          recordingOffsetMs: null,
        })),
      );
      expect(new Set(call.mock.calls.map(([request]) => request))).toEqual(
        new Set(["GetRecordStatus", "GetProfileParameter"]),
      );
      await adapters.dialog.showSaveDialog.withImplementation(
        async () => ({ canceled: false, filePath: path }),
        async () => {
          expect(await f.session.exportChapters?.()).toMatchObject({
            ok: false,
            message: expect.stringContaining("Save the highlight list"),
          });
          expect(adapters.dialog.showSaveDialog).not.toHaveBeenCalled();
          expect(await f.session.saveHighlightList?.()).toMatchObject({
            ok: true,
          });
          expect(await readFile(path, "utf8")).toBe(
            "Highlight list — session time (OBS video time in brackets when recorded)\n01:00 spike +18 vs baseline\n02:10 spike +18 vs baseline\n03:20 spike +18 vs baseline",
          );
        },
      );
    } finally {
      connect.mockRestore();
      call.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["OBS stops before rediscovery", "End", "Off", "live End drain"])(
    "uses the run's OBS overlap for chapter export (%s)",
    async (scenario) => {
      const { ObsWebsocketMarker } = await vi.importActual<
        typeof import("../../src/infrastructure/obs/obs-websocket-marker")
      >("../../src/infrastructure/obs/obs-websocket-marker");
      adapters.ObsWebsocketMarker.mockImplementationOnce(function RealMarker(
        options: ConstructorParameters<typeof ObsWebsocketMarker>[0],
      ) {
        return new ObsWebsocketMarker(options);
      });
      const stopsBeforeRediscovery =
        scenario === "OBS stops before rediscovery";
      const recording = {
        outputActive: stopsBeforeRediscovery,
        outputPaused: false,
        outputDuration: stopsBeforeRediscovery ? 60_000 : 0,
      };
      const lateStatus = deferred<typeof recording>();
      const connect = vi
        .spyOn(OBSWebSocket.prototype, "connect")
        .mockResolvedValue({
          obsWebSocketVersion: "5.5.0",
          rpcVersion: 1,
          negotiatedRpcVersion: 1,
        });
      const call = vi
        .spyOn(OBSWebSocket.prototype, "call")
        .mockImplementation(async (request) => {
          if (request !== "GetRecordStatus") return undefined;
          return stopsBeforeRediscovery && recording.outputActive
            ? lateStatus.promise
            : { ...recording };
        });
      const directory = await mkdtemp(
        join(tmpdir(), "heart-on-stream-export-"),
      );
      const path = join(directory, "timestamps.txt");
      const close = deferred<void>();
      try {
        const f = fixture();
        const socket = connect.mock.contexts[0] as OBSWebSocket;
        await f.session.start({ ...selection, recordSession: true });
        const spikes = [60, 130, 200];
        for (let second = 0; second <= 203; second++) {
          if (second > 0) await vi.advanceTimersByTimeAsync(1_000);
          if (stopsBeforeRediscovery && second === 5) {
            expect(f.panels().at(-1)?.runtime?.obsMessage).toContain(
              "status request failed",
            );
            expect(call.mock.calls).toEqual([
              [
                "GetProfileParameter",
                { parameterCategory: "Output", parameterName: "Mode" },
              ],
              [
                "GetProfileParameter",
                { parameterCategory: "AdvOut", parameterName: "RecSplitFile" },
              ],
              ["GetRecordStatus"],
            ]);
            recording.outputActive = false;
            recording.outputDuration = 0;
            for (const state of ["STOPPING", "STOPPED"]) {
              socket.emit("RecordStateChanged", {
                outputActive: false,
                outputState: `OBS_WEBSOCKET_OUTPUT_${state}`,
                outputPath: "file-a.mp4",
              });
            }
            lateStatus.resolve({
              ...recording,
              outputActive: true,
              outputDuration: 60_000,
            });
          }
          const elevated = spikes.some(
            (spike) => second >= spike - 5 && second <= spike,
          );
          f.pushFrame(pulse(second, elevated ? 88 : 70));
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(f.panels().at(-1)?.highlights).toMatchObject(
          spikes.map((second) => ({
            sessionOffsetUs: second * 1_000_000,
            recordingOffsetMs: null,
          })),
        );

        const startObs = () => {
          recording.outputActive = true;
          socket.emit("RecordStateChanged", {
            outputActive: true,
            outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
            outputPath: "",
          });
        };
        adapters.recorder.stop.mockReturnValueOnce(close.promise);
        try {
          if (scenario === "live End drain") {
            await f.session.setPrivacyMode?.("off", "drain");
            startObs();
          }
          const finishing =
            scenario === "Off"
              ? f.session.setPrivacyMode?.("off")
              : f.session.stop();
          await vi.advanceTimersByTimeAsync(0);
          expect(adapters.recorder.append.mock.lastCall?.[0]).toEqual({
            kind: "end",
            durationUs: 203_000_000,
          });
          expect(adapters.recorder.stop).toHaveBeenCalledOnce();
          if (scenario === "End" || scenario === "Off") startObs();
          close.resolve();
          await finishing;
        } finally {
          close.resolve();
        }

        await adapters.dialog.showSaveDialog.withImplementation(
          async () => ({ canceled: false, filePath: path }),
          async () => {
            if (stopsBeforeRediscovery) {
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: false,
                message: expect.stringContaining("Save the highlight list"),
              });
              expect(adapters.dialog.showSaveDialog).not.toHaveBeenCalled();
              expect(await f.session.saveHighlightList?.()).toMatchObject({
                ok: true,
              });
              expect(await readFile(path, "utf8")).toContain("03:20 spike");
            } else {
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: true,
              });
              expect(await readFile(path, "utf8")).toBe(
                "00:00 Intro\n01:00 spike +18 vs baseline\n02:10 spike +18 vs baseline",
              );
            }
          },
        );
      } finally {
        connect.mockRestore();
        call.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "connected after a split",
    "connected after a split with mixed-case true",
    "split setting unavailable",
    "reconnected after a split",
    "observed split during run",
    "observed split without a duration",
    "started run in a verified split file",
    "started run after a split with a three-second boundary read",
    "split after End",
    "advanced with splitting disabled",
    "advanced with the default split setting",
    "advanced with an unset split setting",
    "advanced with a malformed split setting",
    "advanced with a 5.1-second split setting reply and successful retry",
    "simple output",
  ])("uses verified OBS file times for export (%s)", async (scenario) => {
    const { ObsWebsocketMarker } = await vi.importActual<
      typeof import("../../src/infrastructure/obs/obs-websocket-marker")
    >("../../src/infrastructure/obs/obs-websocket-marker");
    adapters.ObsWebsocketMarker.mockImplementationOnce(function RealMarker(
      options: ConstructorParameters<typeof ObsWebsocketMarker>[0],
    ) {
      return new ObsWebsocketMarker(options);
    });
    const missingSplitDuration =
      scenario === "observed split without a duration";
    const observedSplit =
      scenario === "observed split during run" || missingSplitDuration;
    const startedInSplitFile =
      scenario === "started run in a verified split file";
    const delayedSplit =
      scenario ===
      "started run after a split with a three-second boundary read";
    const splitAfterEnd = scenario === "split after End";
    const reconnected = scenario === "reconnected after a split";
    const simple = scenario === "simple output";
    const splittingDisabled = scenario === "advanced with splitting disabled";
    const defaultSplit = scenario === "advanced with the default split setting";
    const unsetSplit = scenario === "advanced with an unset split setting";
    const malformedSplit =
      scenario === "advanced with a malformed split setting";
    const retrySplit =
      scenario ===
      "advanced with a 5.1-second split setting reply and successful retry";
    const mixedCaseTrue =
      scenario === "connected after a split with mixed-case true";
    const unknownOrigin =
      scenario === "connected after a split" ||
      mixedCaseTrue ||
      scenario === "split setting unavailable" ||
      malformedSplit ||
      delayedSplit ||
      reconnected;
    const earlierFilesMs = unknownOrigin || startedInSplitFile ? 600_000 : 0;
    const recording = {
      outputActive: !(observedSplit || splitAfterEnd),
      outputPaused: false,
      outputDuration: earlierFilesMs,
    };
    const connection = {
      obsWebSocketVersion: "5.5.0",
      rpcVersion: 1,
      negotiatedRpcVersion: 1,
    };
    const pendingConnection = deferred<typeof connection>();
    const connect = vi
      .spyOn(OBSWebSocket.prototype, "connect")
      .mockImplementation(async () =>
        retrySplit || defaultSplit ? pendingConnection.promise : connection,
      );
    let failSplitStatus = false;
    let delaySplitStatus = false;
    let splitSettingRequests = 0;
    const call = vi
      .spyOn(OBSWebSocket.prototype, "call")
      .mockImplementation(async (request, data) => {
        if (request === "GetRecordStatus") {
          if (failSplitStatus) {
            failSplitStatus = false;
            throw new Error("Cannot read the duration at the split");
          }
          if (delaySplitStatus) {
            delaySplitStatus = false;
            await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
          }
          return { ...recording };
        }
        if (
          request === "GetProfileParameter" &&
          data &&
          "parameterName" in data
        ) {
          const name = data.parameterName;
          if (name === "RecSplitFile") {
            splitSettingRequests++;
            if (defaultSplit || unsetSplit) {
              const response = defaultSplit
                ? { parameterValue: null, defaultParameterValue: null }
                : {};
              // OBS sends null or omits unset values despite the library's types.
              return response as {
                parameterValue: string;
                defaultParameterValue: string;
              };
            }
            if (malformedSplit)
              return { parameterValue: "invalid", defaultParameterValue: "" };
            if (retrySplit) {
              if (splitSettingRequests === 1)
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, 5_100),
                );
              return {
                parameterValue: "FaLsE",
                defaultParameterValue: "false",
              };
            }
          }
          const value =
            name === "Mode"
              ? simple
                ? "Simple"
                : "Advanced"
              : splittingDisabled
                ? "false"
                : mixedCaseTrue
                  ? "TrUe"
                  : "true";
          if (
            scenario === "split setting unavailable" &&
            name === "RecSplitFile"
          )
            throw new Error("Profile parameter unavailable");
          return { parameterValue: value, defaultParameterValue: value };
        }
        if (request === "CreateRecordChapter") return undefined;
        throw new Error(`Unexpected OBS request: ${request}`);
      });
    const directory = await mkdtemp(
      join(tmpdir(), "heart-on-stream-file-times-"),
    );
    const path = join(directory, "timestamps.txt");
    try {
      const f = fixture();
      const socket = connect.mock.contexts[0] as OBSWebSocket;
      await vi.advanceTimersByTimeAsync(0);
      const startObs = () => {
        recording.outputActive = true;
        recording.outputDuration = 0;
        socket.emit("RecordStateChanged", {
          outputActive: true,
          outputState: "OBS_WEBSOCKET_OUTPUT_STARTED",
          outputPath: "file-a.mp4",
        });
      };
      const split = () => {
        failSplitStatus = missingSplitDuration;
        delaySplitStatus = delayedSplit;
        socket.emit("RecordFileChanged", { newOutputPath: "file-b.mp4" });
      };
      if (observedSplit || splitAfterEnd || reconnected) startObs();
      if (reconnected) {
        socket.emit("ConnectionClosed", new OBSWebSocketError(1000, "Closed"));
        recording.outputDuration = earlierFilesMs;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(connect).toHaveBeenCalledTimes(2);
      }
      if (startedInSplitFile || delayedSplit) {
        split();
        await vi.advanceTimersByTimeAsync(0);
      }
      await f.session.start(selection);
      for (let second = 0; second <= 203; second++) {
        recording.outputDuration = earlierFilesMs + second * 1_000;
        if (second > 0) await vi.advanceTimersByTimeAsync(1_000);
        if ((defaultSplit && second === 20) || (retrySplit && second === 55)) {
          pendingConnection.resolve(connection);
          await vi.advanceTimersByTimeAsync(0);
        }
        if (observedSplit && second === 61) split();
        const elevated =
          (second >= 55 && second <= 60) || (second >= 125 && second <= 130);
        f.pushFrame(pulse(second, elevated ? 88 : 70));
        if (second === 60 || second === 130)
          await vi.advanceTimersByTimeAsync(0);
        if (retrySplit && second === 60) {
          expect(
            call.mock.calls.filter(
              ([request]) => request === "CreateRecordChapter",
            ),
          ).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(100);
          expect(
            f.panels().at(-1)?.highlights[0]?.recordingOffsetMs,
          ).toBeNull();
          expect(await f.session.exportChapters?.()).toMatchObject({
            ok: false,
            message: expect.stringContaining("Save the highlight list"),
          });
        }
        if (retrySplit && second === 61) {
          expect(splitSettingRequests).toBe(2);
          expect(f.panels().at(-1)?.highlights[0]?.recordingOffsetMs).toBe(
            60_000,
          );
          expect(
            adapters.highlights.updateRecordingOffset,
          ).toHaveBeenCalledWith(
            expect.objectContaining({ sessionOffsetUs: 60_000_000 }),
            60_000,
          );
        }
      }
      await vi.advanceTimersByTimeAsync(0);
      await f.session.stop();
      if (scenario === "split setting unavailable")
        expect(splitSettingRequests).toBe(4);
      expect(
        f
          .panels()
          .at(-1)
          ?.highlights.map((item) => item.sessionOffsetUs),
      ).toEqual([60_000_000, 130_000_000]);
      expect(
        call.mock.calls.filter(
          ([request]) => request === "CreateRecordChapter",
        ),
      ).toHaveLength(2);
      await adapters.dialog.showSaveDialog.withImplementation(
        async () => ({ canceled: false, filePath: path }),
        async () => {
          if (unknownOrigin || observedSplit) {
            expect(await f.session.exportChapters?.()).toMatchObject({
              ok: false,
              message: expect.stringContaining("Save the highlight list"),
            });
            expect(adapters.dialog.showSaveDialog).not.toHaveBeenCalled();
          } else {
            const chapters =
              "00:00 Intro\n01:00 spike +18 vs baseline\n02:10 spike +18 vs baseline";
            expect(await f.session.exportChapters?.()).toMatchObject({
              ok: true,
            });
            expect(await readFile(path, "utf8")).toBe(chapters);
            if (splitAfterEnd) {
              recording.outputDuration = 204_000;
              split();
              expect(await f.session.exportChapters?.()).toMatchObject({
                ok: true,
              });
              expect(await readFile(path, "utf8")).toBe(chapters);
            }
          }
          expect(await f.session.saveHighlightList?.()).toMatchObject({
            ok: true,
          });
          const first = "01:00 spike +18 vs baseline";
          const second = "02:10 spike +18 vs baseline";
          expect((await readFile(path, "utf8")).split("\n").slice(1)).toEqual([
            unknownOrigin ? first : `${first} (video 01:00)`,
            unknownOrigin || missingSplitDuration
              ? second
              : `${second} (video ${observedSplit ? "01:09" : "02:10"})`,
          ]);
        },
      );
    } finally {
      connect.mockRestore();
      call.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loops replay, applies the selected mode on the next loop, and cancels on user Stop", async () => {
    const f = fixture(["--replay", replayFixture, "--speed=20", "--loop"]);
    await f.session.start(selection);
    await f.session.setPrivacyMode?.("highlightsOnly");
    await vi.advanceTimersByTimeAsync(6050);
    expect(f.panels().at(-1)).toMatchObject({
      active: true,
      privacyMode: "highlightsOnly",
    });
    await f.session.stop();
    const calls = adapters.publisher.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapters.publisher.publish).toHaveBeenCalledTimes(calls);
    expect(f.panels().at(-1)?.active).toBe(false);
  });

  it.each([
    ["--replay"],
    ["--replay", "/missing/session.jsonl"],
    ["--replay", replayFixture, "--speed=0"],
  ])(
    "opens the panel for invalid replay arguments/files: %j",
    async (...args) => {
      const f = fixture(args);
      expect(f.options.configuration.public.canStart).toBe(false);
      expect(f.panels().at(-1)?.runtime?.replayMessage).not.toBe("");
      expect(f.options.configuration.apiKey).toBeNull();
      expect(f.panels().at(-1)?.replay).toBe(true);
      expect(adapters.JsonlSessionRecorder).not.toHaveBeenCalled();
    },
  );
});
