import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type {
  HeartBridge,
  PanelStatePayload,
} from "../../src/shared/ipc-contract";

describe("sandboxed custom preload bundle", () => {
  it("inlines the SDK preload, exposes both bridges, and requires only electron", async () => {
    const result = await build({
      absWorkingDir: fileURLToPath(new URL("../../", import.meta.url)),
      entryPoints: ["src/preload/preload.ts"],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      external: ["electron"],
    });
    const code = result.outputFiles?.[0]?.text;
    if (!code) throw new Error("Missing bundled preload.");
    const exposed = new Map<string, unknown>();
    const ipcRenderer = {
      invoke: vi.fn(async (channel: string) =>
        channel === "camera:access-status" ? "denied" : null,
      ),
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    runInNewContext(code, {
      process: { env: {} },
      require(name: string) {
        if (name !== "electron")
          throw new Error(`Unexpected runtime dependency: ${name}`);
        return {
          contextBridge: {
            exposeInMainWorld: (name: string, api: unknown) =>
              exposed.set(name, api),
          },
          ipcRenderer,
        };
      },
    });
    expect(exposed.has("__smartspectraBridge")).toBe(true);
    const bridge = exposed.get("heartBridge") as HeartBridge;
    expect(bridge).toBeDefined();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(bridge).not.toHaveProperty("ipcRenderer");
    await bridge.getConfiguration();
    await bridge.acceptConsent();
    await expect(bridge.getCameraAccessStatus()).resolves.toBe("denied");
    const options = { metricConfig: "b", recordSession: true } as const;
    await bridge.beginMeasurement(options);
    expect(bridge.noticeEnd()).toBeUndefined();
    await bridge.endMeasurement();
    await bridge.setPrivacyMode("numbers");
    await bridge.setPrivacyMode("off", "drain");
    await bridge.pause();
    await bridge.resume();
    await bridge.copyOverlayUrl();
    await bridge.exportChapters();
    await bridge.saveHighlightList();
    await bridge.deleteAllData();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["app:configuration"],
      ["panel:accept-consent"],
      ["camera:access-status"],
      ["measurement:begin", options],
      ["measurement:end"],
      ["session:privacy", "numbers"],
      ["session:privacy", "off", "drain"],
      ["session:pause"],
      ["session:resume"],
      ["panel:copy-overlay"],
      ["session:export"],
      ["session:save-highlights"],
      ["session:delete"],
    ]);
    const listener = vi.fn();
    const unsubscribe = bridge.onPanelState(listener);
    const receive = ipcRenderer.on.mock.lastCall?.[1] as (
      event: unknown,
      state: PanelStatePayload,
    ) => void;
    const state = {} as PanelStatePayload;
    receive({ privateEvent: true }, state);
    expect(listener).toHaveBeenCalledExactlyOnceWith(state);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "panel:state",
      receive,
    );
    const frame = { kind: "processing", t: 1, status: "running" } as const;
    const payload = { captureGeneration: 1, frame };
    bridge.pushFrame(payload);
    expect(ipcRenderer.send.mock.calls).toEqual([
      ["measurement:end-notice"],
      ["frame:push", payload],
    ]);
    const recordingListener = vi.fn();
    const unsubscribeRecording = bridge.onRecordingState(recordingListener);
    const receiveRecording = ipcRenderer.on.mock.lastCall?.[1] as (
      event: unknown,
      state: unknown,
    ) => void;
    const recording = {
      active: true,
      filePath: "/app/recordings/session.jsonl",
      error: "",
    };
    receiveRecording({ privateEvent: true }, recording);
    expect(recordingListener).toHaveBeenCalledExactlyOnceWith(recording);
    unsubscribeRecording();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "recording:state",
      receiveRecording,
    );
  });
});
