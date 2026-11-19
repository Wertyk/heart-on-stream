import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDebugPanel,
  type DebugViewModel,
} from "../../src/presentation/panel/debug-panel";
import type { PanelCommandResult } from "../../src/shared/ipc-contract";
import {
  deferred,
  pulse,
  pulses,
  quickPolicy,
  fixture as sessionFixture,
} from "../application/fakes";

/** Minimal DOM fake exercises native controls without a browser, camera or GUI. */
class ElementFake {
  id = "";
  type = "";
  className = "";
  htmlFor = "";
  textContent = "";
  private inputValue = "";
  selectedIndex = -1;
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  srcObject: unknown = null;
  readonly focus = vi.fn();
  readonly play = vi.fn(async () => {});
  readonly children: (ElementFake | string)[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, () => void>();
  constructor(readonly tag: string) {}
  get length() {
    return this.children.length;
  }
  get value() {
    if (this.tag !== "select") return this.inputValue;
    const option = this.children[this.selectedIndex];
    return option instanceof ElementFake ? option.value : "";
  }
  set value(value: string) {
    if (this.tag === "select")
      this.selectedIndex = this.children.findIndex(
        (option) => option instanceof ElementFake && option.value === value,
      );
    else this.inputValue = value;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: (ElementFake | string)[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: (ElementFake | string)[]) {
    this.children.splice(0, this.children.length, ...children);
  }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, callback);
  }
  trigger(event: string) {
    this.listeners.get(event)?.();
  }
}
afterEach(() => vi.unstubAllGlobals());

function fixture(
  replay = false,
  recordByDefault = false,
  cameraStorage = new Map<string, string>(),
) {
  const elements: ElementFake[] = [];
  vi.stubGlobal("document", {
    createElement(tag: string) {
      const node = new ElementFake(tag);
      elements.push(node);
      return node;
    },
  });
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => cameraStorage.get(key) ?? null,
      setItem: (key: string, value: string) => cameraStorage.set(key, value),
      removeItem: (key: string) => cameraStorage.delete(key),
    },
  });
  const actions = {
    acceptConsent: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    refreshCameras: vi.fn(),
    setPrivacyMode: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    copyOverlayUrl: vi.fn(async () => ({
      ok: true as const,
      message: "Overlay URL copied.",
    })),
    exportChapters: vi.fn(
      async (): Promise<PanelCommandResult> => ({
        ok: false as const,
        message: "Too few chapters.",
      }),
    ),
    saveHighlightList: vi.fn(async () => ({
      ok: true as const,
      message: "Highlight list saved to /local/highlights.txt",
    })),
    deleteAllData: vi.fn(async () => ({
      ok: true as const,
      message: "All data deleted.",
    })),
  };
  const root = new ElementFake("main");
  const panel = createDebugPanel(root as unknown as Element, actions, replay);
  panel.showConfiguration({
    canStart: true,
    recordByDefault,
    message: "Ready",
  });
  panel.showCameras([{ deviceId: "camera", label: "Fake camera" }]);
  const node = (id: string) => {
    const found = elements.find((value) => value.id === id);
    if (!found) throw new Error(`Missing ${id}`);
    return found;
  };
  const click = (id: string) => node(id).trigger("click");
  const screen = (name: string) =>
    elements.find(
      (value) =>
        value.tag === "section" &&
        value.attributes.get("aria-labelledby") === `heading-${name}`,
    );
  const accept = () => {
    node("only-person").checked = true;
    node("only-person").trigger("change");
    click("agree");
    return settle();
  };
  const state = {
    ...sessionFixture({ replay }).session.panelState,
    runtime: {
      overlayUrl: "http://127.0.0.1:7777/overlay",
      overlayError: "",
      obsMessage: "OBS is disconnected.",
      replayFile: replay ? "synthetic-spike.jsonl" : "",
      replayMessage: "",
      shortcutMessage: "",
      sessionStartedAt: 1000,
    },
  };
  const measurement: DebugViewModel = {
    active: false,
    busy: false,
    cameraDisconnected: false,
    processingStatus: "Idle",
    pulse: null,
    validation: null,
    fps: 0,
    error: "",
  };
  return {
    root,
    panel,
    actions,
    elements,
    node,
    click,
    screen,
    accept,
    state,
    measurement,
  };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("streamer panel DOM", () => {
  it.each([false, true])(
    "keeps the readings notice visible on Live, expanded raw values and Receipt (replay: %s)",
    async (replay) => {
      const f = fixture(replay);
      const visibleText = (node: ElementFake | string): string => {
        if (typeof node === "string") return node;
        if (node.hidden) return "";
        return [node.textContent, ...node.children.map(visibleText)].join(" ");
      };
      const notice =
        "Wellness / entertainment, not a medical device. Readings are camera-based estimates.";
      await f.accept();
      f.panel.showSession({
        ...f.state,
        active: true,
        privacyMode: "numbers",
        pulse: { value: 70, confidence: 95, stable: true, t: 1000 },
      });
      expect(f.screen("live")?.hidden).toBe(false);
      expect(visibleText(f.root)).toContain(notice);
      const raw = f.elements.find((node) => node.tag === "details");
      if (!raw) throw new Error("Missing raw values");
      raw.open = true;
      f.panel.showMeasurement({
        ...f.measurement,
        pulse: { value: 70, confidence: 95, stable: true },
      });
      expect(visibleText(f.root)).toContain(notice);
      f.panel.showSession(f.state);
      expect(f.screen("receipt")?.hidden).toBe(false);
      expect(visibleText(f.root)).toContain(notice);
      expect(f.node("readings-notice").hidden).toBe(false);
    },
  );

  it("discloses the SDK's live network activity before agreement", () => {
    const f = fixture();
    const screen = f.screen("consent");
    expect(screen?.hidden).toBe(false);
    const children = screen?.children ?? [];
    const agreeIndex = children.indexOf(f.node("agree"));
    expect(agreeIndex).toBeGreaterThan(0);
    const beforeAgreement = children.slice(0, agreeIndex);
    expect(beforeAgreement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "p",
          hidden: false,
          textContent:
            "Pulse and breathing are computed on this computer. The SDK contacts Presage to check your API key. SDK telemetry is disabled.",
        }),
        expect.objectContaining({
          tag: "p",
          hidden: false,
          textContent:
            "During live measurement the Presage SDK also sends automatic LLM Insights check-ins: once readings stabilize and then every 60 seconds, it sends recent pulse rate, heart-rate variability and breathing rate values (no video or images) to Presage, which forwards them to a language model. The SDK has no setting to turn this off. Heart on Stream never requests insights and ignores any replies.",
        }),
      ]),
    );
  });

  it("requires the only-person checkbox and I agree before Setup or Start; preserves opted-in configuration", async () => {
    const f = fixture();
    expect(f.screen("consent")?.hidden).toBe(false);
    expect(f.screen("setup")?.hidden).toBe(true);
    f.click("agree");
    f.click("start");
    expect(f.actions.acceptConsent).not.toHaveBeenCalled();
    expect(f.actions.start).not.toHaveBeenCalled();
    await f.accept();
    expect(f.actions.acceptConsent).toHaveBeenCalledOnce();
    expect(f.screen("setup")?.hidden).toBe(false);
    expect(f.node("heading-setup").focus).toHaveBeenCalledOnce();
    f.node("camera").value = "camera";
    // Config (b) is the default chosen after the live SDK tests.
    expect(f.node("metric-config").value).toBe("b");
    f.node("record-session").checked = true;
    f.click("start");
    expect(f.node("end-session").disabled).toBe(false);
    expect(f.actions.start).toHaveBeenCalledExactlyOnceWith(
      "camera",
      "b",
      true,
      "vibe",
    );
    f.panel.showSession({ ...f.state, active: true, privacyMode: "vibe" });
    await settle();
    expect(f.screen("live")?.hidden).toBe(false);
    f.panel.showMeasurement({ ...f.measurement, active: true });
    f.panel.showSession({ ...f.state, active: false });
    expect(f.screen("receipt")?.hidden).toBe(true);
    f.panel.showMeasurement(f.measurement);
    expect(f.screen("receipt")?.hidden).toBe(false);
    f.click("new-session");
    expect(f.screen("setup")?.hidden).toBe(false);
    expect(f.actions.acceptConsent).toHaveBeenCalledOnce();
  });

  it("keeps consent open until agreement is recorded and allows retry after a failure", async () => {
    const f = fixture();
    let rejectAgreement!: (error: Error) => void;
    f.actions.acceptConsent.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectAgreement = reject;
      }),
    );
    await f.accept();
    try {
      expect(f.screen("consent")?.hidden).toBe(false);
      expect(f.node("agree").disabled).toBe(true);
      f.click("agree");
      f.click("start");
      expect(f.actions.acceptConsent).toHaveBeenCalledOnce();
      expect(f.actions.start).not.toHaveBeenCalled();
    } finally {
      rejectAgreement(new Error("Unable to record agreement."));
      await settle();
    }
    expect(f.screen("consent")?.hidden).toBe(false);
    expect(f.node("command-error").textContent).toBe(
      "Unable to record agreement.",
    );
    expect(f.node("agree").disabled).toBe(false);

    f.click("agree");
    await settle();
    expect(f.screen("setup")?.hidden).toBe(false);
    expect(f.node("command-error").textContent).toBe("");
  });

  const obsCamera = { deviceId: "obs", label: "OBS Virtual Camera" };
  const physicalCamera = { deviceId: "built-in", label: "MacBook Pro Camera" };

  it("defaults to the physical camera when OBS Virtual Camera is listed first", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showCameras([obsCamera, physicalCamera]);
    expect(f.node("camera").value).toBe(physicalCamera.deviceId);
    expect(f.node("start").disabled).toBe(false);
    expect(f.node("virtual-camera-hint").hidden).toBe(true);
  });

  it("only defaults to a virtual camera when it is the sole input", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showCameras([obsCamera]);
    expect(f.node("camera").value).toBe(obsCamera.deviceId);
    f.panel.showCameras([obsCamera, { deviceId: "camo", label: "Camo" }]);
    expect(f.node("camera").selectedIndex).toBe(-1);
    expect(f.node("start").disabled).toBe(true);
  });

  it("shows the virtual camera hint immediately on selection and hides it for a physical camera", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showCameras([obsCamera, physicalCamera]);
    f.node("camera").value = obsCamera.deviceId;
    f.node("camera").trigger("change");
    expect(f.node("virtual-camera-hint").hidden).toBe(false);
    expect(f.node("virtual-camera-hint").textContent).toBe(
      "Start the virtual camera in OBS first; otherwise it sends a placeholder image.",
    );
    f.node("camera").value = physicalCamera.deviceId;
    f.node("camera").trigger("change");
    expect(f.node("virtual-camera-hint").hidden).toBe(true);
  });

  it("restores an explicit camera choice across panel launches by ID and then by label", async () => {
    const storage = new Map<string, string>();
    const first = fixture(false, false, storage);
    await first.accept();
    first.panel.showCameras([physicalCamera, obsCamera]);
    first.node("camera").value = obsCamera.deviceId;
    first.node("camera").trigger("change");

    const next = fixture(false, false, storage);
    await next.accept();
    const renamed = { ...obsCamera, label: "OBS Virtual Camera (renamed)" };
    const newId = { ...obsCamera, deviceId: "new-obs" };
    next.panel.showCameras([physicalCamera, newId, renamed]);
    expect(next.node("camera").value).toBe(obsCamera.deviceId);
    next.panel.showCameras([physicalCamera, newId]);
    expect(next.node("camera").value).toBe(newId.deviceId);
    expect(next.node("virtual-camera-hint").hidden).toBe(false);
  });

  it("uses the physical default while the remembered camera is missing and restores it on reconnect", async () => {
    const storage = new Map<string, string>();
    const first = fixture(false, false, storage);
    await first.accept();
    first.panel.showCameras([physicalCamera, obsCamera]);
    first.node("camera").value = obsCamera.deviceId;
    first.node("camera").trigger("change");

    const next = fixture(false, false, storage);
    await next.accept();
    const camo = { deviceId: "camo", label: "Camo" };
    next.panel.showCameras([camo, physicalCamera]);
    expect(next.node("camera").value).toBe(physicalCamera.deviceId);
    next.panel.showCameras([camo, physicalCamera, obsCamera]);
    expect(next.node("camera").value).toBe(obsCamera.deviceId);
  });

  it("preserves the first anonymous input before permission and reapplies the default when labels arrive", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showCameras([{ deviceId: "", label: "" }]);
    const picker = f.node("camera");
    expect(picker.children[0]).toMatchObject({ textContent: "Camera 1" });
    expect(picker.selectedIndex).toBe(0);
    expect(f.node("start").disabled).toBe(false);
    expect(f.node("virtual-camera-hint").hidden).toBe(true);
    f.panel.showCameras([
      { ...obsCamera, label: "" },
      { ...physicalCamera, label: "" },
    ]);
    expect(picker.value).toBe(obsCamera.deviceId);
    f.panel.showCameras([obsCamera, physicalCamera]);
    expect(picker.value).toBe(physicalCamera.deviceId);
  });

  it("shows the actual stream's camera label on Live and clears it when capture ends", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showSession({ ...f.state, active: true });
    const stream = {
      getVideoTracks: () => [
        {
          label: "Actual USB Camera",
          getSettings: () => ({ deviceId: "usb" }),
        },
      ],
    } as unknown as MediaStream;
    f.panel.showStream(stream);
    expect(f.screen("live")?.hidden).toBe(false);
    expect(f.node("live-camera").hidden).toBe(false);
    expect(f.node("live-camera").textContent).toBe("Camera: Actual USB Camera");
    f.panel.showStream(null);
    expect(f.node("live-camera").hidden).toBe(true);
  });

  it("forgets the camera in the current picker and across launches after confirmed deletion", async () => {
    const storage = new Map<string, string>();
    const f = fixture(false, false, storage);
    await f.accept();
    f.panel.showCameras([obsCamera, physicalCamera]);
    f.node("camera").value = obsCamera.deviceId;
    f.node("camera").trigger("change");
    f.panel.showSession({ ...f.state, active: true });
    f.panel.showSession(f.state);
    f.click("delete-data");
    f.click("cancel-delete");
    expect(storage.size).toBe(1);
    f.click("delete-data");
    f.click("confirm-delete");
    await settle();
    expect(storage.size).toBe(0);
    f.click("new-session");
    expect(f.node("camera").value).toBe(physicalCamera.deviceId);

    const next = fixture(false, false, storage);
    await next.accept();
    next.panel.showCameras([obsCamera, physicalCamera]);
    expect(next.node("camera").value).toBe(physicalCamera.deviceId);
  });

  it("replaces consent with a replay notice, hides camera/record controls and keeps REPLAY across every screen", async () => {
    const f = fixture(true);
    expect(f.screen("consent")?.children).toContainEqual(
      expect.objectContaining({
        textContent:
          "Replay plays back a saved session of numeric signal and status data. The camera and session recording stay off.",
      }),
    );
    const badge = f.elements.find((node) => node.textContent === "REPLAY");
    expect(badge?.hidden).toBe(false);
    f.click("agree");
    await settle();
    f.click("start");
    f.panel.showSession({ ...f.state, active: true, privacyMode: "vibe" });
    await settle();
    expect(f.actions.start).toHaveBeenCalledWith("", "b", false, "vibe");
    expect(f.node("record-session").disabled).toBe(true);
    expect(f.elements.find((node) => node.tag === "video")?.hidden).toBe(true);
    expect(f.node("measuring-indicator").textContent).toBe("Replay playing");
    f.panel.showSession(f.state);
    expect(f.screen("receipt")?.hidden).toBe(false);
    expect(f.node("receipt-summary").textContent).toContain("Camera: not used");
    f.click("new-session");
    expect(f.screen("setup")?.hidden).toBe(false);
    expect(badge?.hidden).toBe(false);
  });

  it("shows conditions, current-session highlights, raw values and runtime messages, retaining the expanded raw view", async () => {
    const f = fixture(true);
    await f.accept();
    const raw = f.elements.find((node) => node.tag === "details");
    if (!raw) throw new Error("Missing raw values");
    raw.open = true;
    const highlight = {
      t: 21_001_000,
      sessionStartedAt: 1000,
      sessionOffsetUs: 21_000_000,
      recordingOffsetMs: null,
      label: "spike +18 vs baseline",
      deltaBpm: 18,
      talkingRecent: false,
    };
    f.panel.showSession({
      ...f.state,
      active: true,
      phase: "paused",
      privacyMode: "numbers",
      pulse: { value: 70, confidence: 95, stable: true, t: 1000 },
      breathing: { value: 14, confidence: 80, stable: true, t: 1000 },
      talking: { detected: true, stable: true, t: 1000 },
      validation: {
        code: "multipleFacesFound",
        hint: "Keep one face in view",
        t: 1000,
      },
      highlights: [highlight, { ...highlight, sessionStartedAt: 2000 }],
      runtime: {
        ...f.state.runtime,
        overlayError: "Overlay unavailable",
        shortcutMessage: "Shortcut unavailable",
      },
    });
    expect(f.node("multiple-faces").hidden).toBe(false);
    expect(f.node("multiple-faces").textContent).toBe(
      "Measurement paused: more than one face in view",
    );
    expect(f.node("condition").textContent).toBe("Keep one face in view");
    expect(f.node("privacy-badge").textContent).toBe("Numbers");
    expect(f.node("highlights").children).toHaveLength(1);
    expect((f.node("highlights").children[0] as ElementFake).textContent).toBe(
      "00:21 · spike +18 vs baseline",
    );
    expect(f.node("receipt-summary").textContent).toContain("Highlights: 1");
    expect(
      f.elements.some((node) => node.textContent === "14.0 breaths/min"),
    ).toBe(true);
    expect(f.node("obs-status").textContent).toBe("OBS is disconnected.");
    expect(f.node("shortcut-message").textContent).toBe("Shortcut unavailable");
    expect(raw.open).toBe(true);
  });

  it("reflects pause/privacy snapshots, handles buttons and disables Off at Setup", async () => {
    const f = fixture();
    await f.accept();
    f.node("privacy-mode").value = "off";
    f.node("privacy-mode").trigger("change");
    expect(f.node("start").disabled).toBe(true);
    f.panel.showSession({
      ...f.state,
      active: true,
      privacyMode: "highlightsOnly",
      pauseReason: "manual",
    });
    expect(f.node("resume").hidden).toBe(false);
    expect(f.node("pause").hidden).toBe(true);
    expect(f.node("live-privacy-mode").value).toBe("highlightsOnly");
    f.click("resume");
    expect(f.actions.resume).toHaveBeenCalledOnce();
    expect(f.actions.pause).not.toHaveBeenCalled();
    f.panel.showSession({
      ...f.state,
      active: true,
      pauseReason: null,
      privacyMode: "vibe",
    });
    expect(f.node("pause").hidden).toBe(false);
    expect(f.node("resume").hidden).toBe(true);
    f.click("pause");
    f.node("live-privacy-mode").value = "numbers";
    f.node("live-privacy-mode").trigger("change");
    f.click("end-session");
    await settle();
    expect(f.actions.pause).toHaveBeenCalledOnce();
    expect(f.actions.setPrivacyMode).toHaveBeenCalledWith("numbers");
    expect(f.actions.stop).toHaveBeenCalledOnce();
  });

  it("keeps Off available while the camera permission prompt is pending", async () => {
    const f = fixture();
    let finishStart!: () => void;
    f.actions.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishStart = resolve;
      }),
    );
    await f.accept();
    f.click("start");
    expect(f.actions.start).toHaveBeenCalledOnce();
    try {
      f.panel.showSession({ ...f.state, active: true, privacyMode: "numbers" });
      const privacy = f.node("live-privacy-mode");
      expect(privacy.disabled).toBe(false);
      privacy.value = "off";
      privacy.trigger("change");
      expect(f.actions.setPrivacyMode).toHaveBeenCalledExactlyOnceWith("off");
    } finally {
      finishStart();
      await settle();
    }
  });

  it.each(["manual", "unusableInput"] as const)(
    "reports camera off after %s pause and clears the banner on Resume",
    async (pauseReason) => {
      const f = fixture();
      await f.accept();
      const active = { ...f.state, active: true, privacyMode: "vibe" as const };
      const preview = f.elements.find((node) => node.tag === "video");
      const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
      f.panel.showSession(active);
      f.panel.showStream(stream);
      expect(f.node("measuring-indicator").textContent).toBe("Camera on");
      expect(preview?.srcObject).toBe(stream);
      const paused = { ...active, phase: "paused" as const, pauseReason };
      f.panel.showSession(paused);
      f.panel.showStream(null);
      f.panel.showSession(paused);
      expect(f.node("measuring-indicator").textContent).toBe("Camera off");
      expect(preview?.srcObject).toBeNull();
      expect(f.node("resume").hidden).toBe(false);
      expect(f.node("pause").hidden).toBe(true);
      const banner = f.node("unusable-input");
      expect(banner.hidden).toBe(pauseReason !== "unusableInput");
      expect(banner.textContent).toBe(
        "No usable face for 60 s. Measurement paused to save credits. Press Resume when ready.",
      );
      f.panel.showSession(active);
      expect(banner.hidden).toBe(true);
      expect(f.node("pause").hidden).toBe(false);
      expect(f.node("resume").hidden).toBe(true);
      expect(f.node("measuring-indicator").textContent).toBe(
        "Starting camera…",
      );
    },
  );

  it("offers confirmed deletion on Setup before Start and explains what is kept", async () => {
    const storage = new Map<string, string>();
    const f = fixture(false, false, storage);
    await f.accept();
    f.node("camera").trigger("change");
    expect(storage.size).toBe(1);
    expect(f.screen("setup")?.hidden).toBe(false);
    expect(f.screen("setup")?.children).toContain(f.node("setup-delete-data"));
    f.click("setup-delete-data");
    expect(f.node("setup-confirm-delete").focus).toHaveBeenCalledOnce();
    expect(
      f.elements.some((element) =>
        element.textContent.includes(
          "Exported text files and chapters already inside OBS recordings are kept.",
        ),
      ),
    ).toBe(true);
    f.click("setup-cancel-delete");
    expect(f.actions.deleteAllData).not.toHaveBeenCalled();
    const deletion = deferred<{ ok: true; message: string }>();
    f.actions.deleteAllData.mockReturnValueOnce(deletion.promise);
    f.click("setup-delete-data");
    f.click("setup-confirm-delete");
    expect(f.node("start").disabled).toBe(true);
    deletion.resolve({ ok: true, message: "All data deleted." });
    await settle();
    expect(f.actions.deleteAllData).toHaveBeenCalledOnce();
    expect(f.actions.start).not.toHaveBeenCalled();
    expect(f.node("start").disabled).toBe(false);
    expect(storage.size).toBe(0);
    expect(f.node("setup-delete-message").textContent).toBe(
      "All data deleted.",
    );
  });

  it("shows the camera disconnect prompt and clears old readings until fresh data arrives", async () => {
    const f = fixture();
    await f.accept();
    const lastSnapshot = {
      ...f.state,
      active: true,
      t: 1000,
      pulse: { value: 70, confidence: 95, stable: true, t: 1000 },
      breathing: { value: 14, confidence: 80, stable: true, t: 1000 },
    };
    const hasReading = (text: string) =>
      f.elements.some((node) => node.tag === "dd" && node.textContent === text);
    f.panel.showSession(lastSnapshot);
    expect(hasReading("70.0 BPM")).toBe(true);
    expect(hasReading("14.0 breaths/min")).toBe(true);
    f.panel.showMeasurement({ ...f.measurement, cameraDisconnected: true });
    const banner = f.node("camera-disconnected");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe(
      "Camera disconnected. Reconnect it and press Resume.",
    );
    expect(hasReading("70.0 BPM")).toBe(false);
    f.panel.showSession({ ...lastSnapshot, pauseReason: "manual" });
    expect(f.node("resume").hidden).toBe(false);
    expect(hasReading("14.0 breaths/min")).toBe(false);

    f.panel.showSession(lastSnapshot);
    f.panel.showMeasurement({ ...f.measurement, active: true });
    expect(banner.hidden).toBe(true);
    expect(hasReading("70.0 BPM")).toBe(false);
    f.panel.showSession({
      ...lastSnapshot,
      t: 2000,
      pulse: { ...lastSnapshot.pulse, value: 75, t: 2000 },
    });
    expect(hasReading("75.0 BPM")).toBe(true);
    expect(hasReading("14.0 breaths/min")).toBe(false);
  });

  it("uses native clipboard/export actions and requires a cancelable deletion confirmation", async () => {
    const f = fixture();
    await f.accept();
    f.panel.showSession(f.state);
    f.click("copy-overlay");
    await settle();
    expect(f.node("copy-message").textContent).toBe("Overlay URL copied.");
    f.panel.showSession({ ...f.state, active: true });
    f.panel.showSession(f.state);
    f.click("export-chapters");
    await settle();
    expect(f.node("receipt-message").textContent).toBe("Too few chapters.");
    f.actions.exportChapters.mockResolvedValueOnce({
      ok: true,
      path: "/local/chapters.txt",
      message: "Chapters saved to /local/chapters.txt",
    });
    f.click("export-chapters");
    await settle();
    expect(f.node("receipt-message").textContent).toBe(
      "Chapters saved to /local/chapters.txt",
    );
    f.click("delete-data");
    expect(f.actions.deleteAllData).not.toHaveBeenCalled();
    expect(f.node("confirm-delete").focus).toHaveBeenCalledOnce();
    f.click("cancel-delete");
    expect(f.actions.deleteAllData).not.toHaveBeenCalled();
    f.click("delete-data");
    f.click("confirm-delete");
    await settle();
    expect(f.actions.deleteAllData).toHaveBeenCalledOnce();
    expect(f.node("receipt-message").textContent).toBe("All data deleted.");
  });

  it("offers Save highlight list alongside the chapter refusal and shows the saved path", async () => {
    const f = fixture(true);
    await f.accept();
    const highlight = {
      t: 21_001_000,
      sessionStartedAt: 1000,
      sessionOffsetUs: 21_000_000,
      recordingOffsetMs: null,
      label: "spike +18 vs baseline",
      deltaBpm: 18,
      talkingRecent: false,
    };
    f.panel.showSession({ ...f.state, active: true, highlights: [highlight] });
    f.panel.showSession({ ...f.state, highlights: [highlight] });
    expect(f.screen("receipt")?.hidden).toBe(false);
    expect(f.node("save-highlights").disabled).toBe(false);
    f.click("export-chapters");
    await settle();
    expect(f.node("receipt-message").textContent).toBe("Too few chapters.");
    f.click("save-highlights");
    expect(f.node("save-highlights").disabled).toBe(true);
    await settle();
    expect(f.actions.saveHighlightList).toHaveBeenCalledOnce();
    expect(f.node("receipt-message").textContent).toBe(
      "Highlight list saved to /local/highlights.txt",
    );
    expect(
      f.elements.some((element) =>
        element.textContent.includes("keep that recording running"),
      ),
    ).toBe(false);
    f.panel.showSession(f.state);
    expect(f.node("save-highlights").disabled).toBe(true);
  });

  it("reenables receipt buttons after export while the OBS offset write is still held", async () => {
    const f = fixture(true);
    const { session, highlights } = sessionFixture({ policy: quickPolicy });
    const writing = deferred<void>();
    const release = deferred<void>();
    const update = highlights.updateRecordingOffset.bind(highlights);
    highlights.updateRecordingOffset = async (receipt, offset) => {
      writing.resolve();
      await release.promise;
      return update(receipt, offset);
    };
    await f.accept();
    await session.startSession({ consentRecorded: true, privacyMode: "vibe" });
    await session.ingestFrame(pulse(0));
    await pulses(session, 1, 2, 82);
    await writing.promise;
    const runtime = {
      ...f.state.runtime,
      sessionStartedAt: session.sessionStartedAt,
    };
    f.panel.showSession({ ...session.panelState, runtime });
    await session.stopSession();
    f.panel.showSession({ ...session.panelState, runtime });
    f.actions.exportChapters.mockImplementationOnce(async () => {
      await session.exportChapters({ recordingDurationMs: 60_000 });
      return { ok: false, message: "Too few chapters." };
    });
    f.click("export-chapters");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.node("receipt-message").textContent).toBe("Too few chapters.");
      for (const id of ["save-highlights", "delete-data", "new-session"])
        expect(f.node(id).disabled).toBe(false);
      expect(highlights.items[0]?.recordingOffsetMs).toBeNull();
    } finally {
      release.resolve();
    }
  });

  it("reflects the recording flag, preserves errors and safely renders SDK hint text", () => {
    const f = fixture(false, true);
    expect(f.node("record-session").checked).toBe(true);
    expect(f.node("record-session").disabled).toBe(true);
    f.panel.showRecording({
      active: false,
      filePath: "/recordings/session.jsonl",
      error: "Recording failed",
    });
    f.panel.showMeasurement({ ...f.measurement, error: "SDK mapping failed" });
    expect(f.node("recording-error").textContent).toBe("Recording failed");
    expect(f.node("command-error").textContent).toBe("SDK mapping failed");
    f.panel.showSession({
      ...f.state,
      validation: { code: "ok", t: 1, hint: "<img src=x>" },
    });
    expect(f.node("condition").textContent).toBe("<img src=x>");
  });

  it("shows the macOS camera permission steps and returns a blocked Start to Setup", async () => {
    const f = fixture();
    const message =
      "macOS is blocking camera access for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Enable it in System Settings > Privacy & Security > Camera, then quit and reopen that app and start Heart on Stream again.";
    f.actions.start.mockImplementation(async () => {
      f.panel.showMeasurement({ ...f.measurement, error: message });
    });

    await f.accept();
    f.click("start");
    await settle();

    expect(f.screen("setup")?.hidden).toBe(false);
    expect(f.node("start").disabled).toBe(false);
    expect(f.node("command-error").textContent).toBe(message);
    expect(f.node("command-error").attributes.get("role")).toBe("alert");
  });

  it("displays the launching app and selected device guidance after a camera refusal", async () => {
    const f = fixture();
    const message =
      "Camera: NotAllowedError. On macOS, check System Settings > Privacy & Security > Camera for the app that launched Heart on Stream (for example Terminal, iTerm or VS Code). Check that the selected device is available and that access is allowed.";
    f.actions.start.mockImplementation(async () => {
      f.panel.showMeasurement({ ...f.measurement, busy: true });
      f.panel.showMeasurement({ ...f.measurement, error: message });
    });

    await f.accept();
    f.click("start");
    await settle();

    expect(f.node("command-error").textContent).toBe(message);
    expect(f.node("command-error").attributes.get("role")).toBe("alert");
  });

  it("retains the restrictive CSP, has no inline scripts/styles and uses labels and native controls", () => {
    const html = readFileSync(
      new URL("../../src/presentation/panel/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain("script-src 'self'; style-src 'self'");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/style\s*=/u);
    expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/u);
    const f = fixture();
    for (const control of f.elements.filter((node) => node.tag === "select")) {
      expect(
        f.elements.some(
          (node) => node.tag === "label" && node.htmlFor === control.id,
        ),
      ).toBe(true);
    }
    expect(
      f.elements.some(
        (node) =>
          node.tag === "summary" && node.textContent === "Raw SDK values",
      ),
    ).toBe(true);
  });
});
