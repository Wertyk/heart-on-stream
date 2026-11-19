import type { PrivacyMode } from "../../domain/privacy/index";
import type { PanelStatePayload } from "../../shared/ipc-contract";

export type PanelScreen = "consent" | "setup" | "live" | "receipt";
export interface ScreenFlow {
  readonly screen: PanelScreen;
  readonly replay: boolean;
  readonly consentAccepted: boolean;
  readonly sessionActive: boolean;
  /** Main may still report the previous run during a new camera preflight. */
  readonly hasMainSession: boolean;
  readonly captureBusy: boolean;
}
export type FlowEvent =
  | { readonly type: "agree"; readonly onlyPerson: boolean }
  | { readonly type: "start" }
  | { readonly type: "session"; readonly active: boolean }
  | { readonly type: "capture"; readonly busy: boolean }
  | { readonly type: "new" };

/** A replay notice takes the place of consent; neither initial screen allows measurement. */
export function initialFlow(replay: boolean): ScreenFlow {
  return {
    screen: "consent",
    replay,
    consentAccepted: false,
    sessionActive: false,
    hasMainSession: false,
    captureBusy: false,
  };
}

/** The renderer uses this gate before accessing any live camera or SDK. */
export function canUseCamera(flow: ScreenFlow): boolean {
  return !flow.replay && flow.consentAccepted;
}

/** Receipt waits for capture teardown as well as the main session stop. */
export function transitionFlow(flow: ScreenFlow, event: FlowEvent): ScreenFlow {
  let next = flow;
  switch (event.type) {
    case "agree":
      if (flow.screen === "consent" && (flow.replay || event.onlyPerson))
        next = { ...flow, consentAccepted: true, screen: "setup" };
      break;
    case "start":
      if (flow.screen === "setup" && flow.consentAccepted)
        next = { ...flow, screen: "live" };
      break;
    case "session":
      next = {
        ...flow,
        sessionActive: event.active,
        hasMainSession: flow.hasMainSession || event.active,
      };
      if (event.active && flow.consentAccepted)
        next = { ...next, screen: "live" };
      if (!event.active && flow.sessionActive && !flow.captureBusy)
        next = { ...next, screen: "receipt" };
      break;
    case "capture":
      next = { ...flow, captureBusy: event.busy };
      if (
        !event.busy &&
        flow.captureBusy &&
        !flow.sessionActive &&
        flow.screen === "live"
      )
        next = { ...next, screen: "receipt" };
      break;
    case "new":
      if (flow.screen === "receipt" && !flow.captureBusy && !flow.sessionActive)
        next = { ...flow, screen: "setup", hasMainSession: false };
      break;
  }
  return next;
}

/** Off ends measurement, so the hotkey only cycles the three enabled modes. */
export function cyclePrivacyMode(mode: PrivacyMode): PrivacyMode {
  return mode === "vibe"
    ? "numbers"
    : mode === "numbers"
      ? "highlightsOnly"
      : "vibe";
}

export const privacyDescriptions: Record<PrivacyMode, string> = {
  off: "Off — camera and SDK stopped. The overlay receives only mode and replay status.",
  vibe: "Vibe — no BPM or breathing-rate numbers. The overlay receives beat and breath waveform points with timing, intensity and status, so viewers could still estimate a rate from the rhythm.",
  numbers: "Numbers — Vibe plus rounded pulse and breathing estimates.",
  highlightsOnly:
    "Highlights only — only mode and replay status reach the overlay. Local highlights continue.",
};

/** Filter by the SDK timeline identity, including when a replay is run repeatedly. */
export function sessionHighlights(state: PanelStatePayload) {
  const startedAt = state.runtime?.sessionStartedAt;
  return startedAt === undefined || startedAt === null
    ? []
    : state.highlights.filter(
        (highlight) => highlight.sessionStartedAt === startedAt,
      );
}

export function receiptText(
  replay: boolean,
  count: number,
  sdkStarted: boolean,
): string {
  const { camera, video, telemetry, presage } = receiptFacts(
    replay,
    sdkStarted,
  );
  const summary = `Camera: ${camera} · Video saved: ${video} · Highlights: ${count}`;
  return telemetry === null
    ? `${summary} · Sent to Presage: ${presage}`
    : `${summary} · SDK telemetry: ${telemetry} · Sent to Presage: ${presage}`;
}

/** The tiles and screen-reader summary share the same disclosure facts. */
export function receiptFacts(replay: boolean, sdkStarted: boolean) {
  return {
    camera: replay ? "not used" : "off",
    video: "no",
    telemetry: !replay && sdkStarted ? "off" : null,
    presage: replay
      ? "nothing (SDK not used)"
      : sdkStarted
        ? "key check; the SDK may send automatic vitals check-ins during measurement (no video)"
        : "nothing (SDK did not start)",
  };
}

export function receiptTitle(count: number): string {
  const moments = count === 1 ? "moment" : "moments";
  return `Your heart marked ${count === 0 ? "nothing" : `${count} ${moments}`}.`;
}

export function phaseText(state: PanelStatePayload): string {
  if (state.phase === "paused") return "Measurement paused";
  if (state.phase === "out_of_range") return "Reading out of range";
  if (state.progress) {
    const { elapsedSeconds, requiredSeconds, phase } = state.progress;
    return `${phase === "warming" ? "Calibrating" : "Building your baseline"} ${Math.min(requiredSeconds, Math.floor(elapsedSeconds))}/${requiredSeconds} s`;
  }
  return state.phase === "live"
    ? "Live"
    : state.active
      ? "Starting…"
      : "Session ended";
}

export function multipleFacesMessage(state: PanelStatePayload): string {
  return state.validation?.code === "multipleFacesFound"
    ? "Measurement paused: more than one face in view"
    : "";
}

export function sessionTime(offsetUs: number): string {
  const seconds = Math.max(0, Math.floor(offsetUs / 1_000_000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
