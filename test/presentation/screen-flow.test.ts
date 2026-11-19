import { describe, expect, it } from "vitest";
import {
  canUseCamera,
  cyclePrivacyMode,
  initialFlow,
  multipleFacesMessage,
  phaseText,
  privacyDescriptions,
  receiptText,
  sessionHighlights,
  transitionFlow,
} from "../../src/presentation/panel/screen-flow";
import { fixture } from "../application/fakes";

const state = fixture().session.panelState;

describe("streamer screen flow", () => {
  it("gates camera/SDK access until the only-person checkbox and agreement, then follows the full flow", () => {
    let flow = initialFlow(false);
    expect(canUseCamera(flow)).toBe(false);
    expect(transitionFlow(flow, { type: "start" })).toBe(flow);
    expect(transitionFlow(flow, { type: "agree", onlyPerson: false })).toBe(
      flow,
    );
    flow = transitionFlow(flow, { type: "agree", onlyPerson: true });
    expect(flow.screen).toBe("setup");
    expect(canUseCamera(flow)).toBe(true);
    flow = transitionFlow(flow, { type: "start" });
    expect(flow.screen).toBe("live");
    flow = transitionFlow(flow, { type: "session", active: true });
    flow = transitionFlow(flow, { type: "capture", busy: true });
    flow = transitionFlow(flow, { type: "session", active: false });
    expect(flow.screen).toBe("live");
    flow = transitionFlow(flow, { type: "capture", busy: false });
    expect(flow.screen).toBe("receipt");
    expect(transitionFlow(flow, { type: "new" }).screen).toBe("setup");
  });

  it("requires acknowledgement of the replay notice and never allows a camera", () => {
    let flow = initialFlow(true);
    expect(transitionFlow(flow, { type: "start" })).toBe(flow);
    flow = transitionFlow(flow, { type: "agree", onlyPerson: false });
    expect(flow.screen).toBe("setup");
    expect(canUseCamera(flow)).toBe(false);
    flow = transitionFlow(flow, { type: "start" });
    flow = transitionFlow(flow, { type: "session", active: true });
    flow = transitionFlow(flow, { type: "session", active: false });
    expect(flow.screen).toBe("receipt");
    expect(transitionFlow(flow, { type: "new" }).screen).toBe("setup");
  });

  it("counts highlights only for this session and formats an honest receipt", () => {
    const highlight = {
      t: 20,
      sessionStartedAt: 1,
      sessionOffsetUs: 19,
      recordingOffsetMs: null,
      label: "spike",
      deltaBpm: 10,
      talkingRecent: false,
    };
    const highlights = [highlight, { ...highlight, sessionStartedAt: 2 }];
    const current = sessionHighlights({
      ...state,
      highlights,
      runtime: {
        overlayUrl: "",
        overlayError: "",
        obsMessage: "",
        replayFile: "",
        replayMessage: "",
        sessionStartedAt: 2,
      },
    });
    expect(current).toHaveLength(1);
    expect(sessionHighlights({ ...state, highlights })).toHaveLength(0);
    expect(receiptText(false, current.length)).toBe(
      "Camera: off · Video saved: no · Highlights: 1 · Telemetry: disabled · AI: none",
    );
    expect(receiptText(true, 0)).toContain("Camera: not used");
  });

  it("shows calibration, baseline progress and the immediate multiple-faces message", () => {
    expect(
      phaseText({
        ...state,
        progress: {
          phase: "warming",
          elapsedSeconds: 7.8,
          requiredSeconds: 12,
        },
      }),
    ).toBe("Calibrating 7/12 s");
    expect(
      phaseText({
        ...state,
        progress: {
          phase: "baselining",
          elapsedSeconds: 22,
          requiredSeconds: 60,
        },
      }),
    ).toBe("Building your baseline 22/60 s");
    expect(
      multipleFacesMessage({
        ...state,
        validation: { t: 1, code: "multipleFacesFound", hint: "One face only" },
      }),
    ).toBe("Measurement paused: more than one face in view");
    expect(multipleFacesMessage(state)).toBe("");
  });

  it("cycles Vibe → Numbers → Highlights only → Vibe, excluding Off", () => {
    expect([
      cyclePrivacyMode("vibe"),
      cyclePrivacyMode("numbers"),
      cyclePrivacyMode("highlightsOnly"),
      cyclePrivacyMode("off"),
    ]).toEqual(["numbers", "highlightsOnly", "vibe", "vibe"]);
  });

  it("tells streamers that Vibe shares their beat and breath timing without numbers", () => {
    expect(privacyDescriptions.vibe).toContain(
      "The overlay animates with your beat and breath timing and carries no numbers.",
    );
  });
});
