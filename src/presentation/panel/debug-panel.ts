import type { PrivacyMode } from "../../domain/privacy/index";
import { DEFAULT_SPIKE_POLICY } from "../../domain/session/index";
import type {
  MetricConfiguration,
  PanelCommandResult,
  PanelStatePayload,
  PublicConfiguration,
  RecordingState,
} from "../../shared/ipc-contract";
import {
  forgetCameraPreference,
  readCameraPreference,
  saveCameraPreference,
} from "./camera-preference";
import {
  type CameraDevice,
  isVirtualCamera,
  selectCamera,
} from "./camera-selection";
import { element, svgElement } from "./panel-elements";
import { createPrivacyDial, privacyLabels } from "./privacy-dial";
import { createPulseChart } from "./pulse-chart";
import { PulseHistory } from "./pulse-history";
import { createReceiptTimeline } from "./receipt-timeline";
import {
  type FlowEvent,
  initialFlow,
  multipleFacesMessage,
  type PanelScreen,
  phaseText,
  receiptFacts,
  receiptText,
  receiptTitle,
  sessionHighlights,
  sessionTime,
  transitionFlow,
} from "./screen-flow";

/** SDK-local values complement the normalized main-process snapshot. */
export interface DebugViewModel {
  readonly active: boolean;
  readonly busy: boolean;
  readonly cameraDisconnected: boolean;
  readonly processingStatus: string;
  readonly pulse: {
    readonly value: number;
    readonly confidence: number;
    readonly stable: boolean;
  } | null;
  readonly validation: { readonly code: number; readonly hint: string } | null;
  readonly fps: number;
  readonly error: string;
}

interface PanelActions {
  acceptConsent(): Promise<void>;
  start(
    deviceId: string,
    config: MetricConfiguration,
    recordSession: boolean,
    privacyMode: PrivacyMode,
  ): Promise<void>;
  stop(): Promise<void>;
  refreshCameras(): void;
  setPrivacyMode(mode: PrivacyMode): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  copyOverlayUrl(): Promise<PanelCommandResult>;
  exportChapters(): Promise<PanelCommandResult>;
  saveHighlightList(): Promise<PanelCommandResult>;
  deleteAllData(): Promise<PanelCommandResult>;
}

/** Persistent native controls retain focus and details state across frequent signal updates. */
export function createDebugPanel(
  root: Element,
  actions: PanelActions,
  replay = false,
) {
  function button(text: string, id: string, action: () => void) {
    const node = element("button", text);
    node.id = id;
    node.type = "button";
    node.addEventListener("click", () => {
      if (!node.disabled) action();
    });
    return node;
  }
  function status(id: string, alert = false) {
    const node = element("p", "", alert ? "error" : "muted");
    node.id = id;
    node.setAttribute("role", alert ? "alert" : "status");
    return node;
  }
  function label(text: string, input: HTMLElement) {
    const node = element("label", text);
    node.htmlFor = input.id;
    return node;
  }
  function select(id: string, values: readonly (readonly [string, string])[]) {
    const node = element("select");
    node.id = id;
    for (const [value, text] of values) {
      const option = element("option", text);
      option.value = value;
      node.append(option);
    }
    return node;
  }
  function card(...children: Element[]) {
    const node = element("div", "", "card");
    node.append(...children);
    return node;
  }
  function heart(className: string) {
    const node = element("div", "", `heart ${className}`);
    node.setAttribute("aria-hidden", "true");
    const icon = svgElement("svg", { viewBox: "0 0 112 112" });
    icon.append(
      svgElement("path", {
        class: "heart-shape",
        d: "M56 96C44 86 13 64 13 41a22 22 0 0 1 43-10 22 22 0 0 1 43 10c0 23-31 45-43 55Z",
      }),
    );
    node.append(icon);
    return node;
  }
  const header = element("header", "", "panel-header");
  const brand = element("div", "", "brand");
  brand.append(heart("brand-heart"), element("h1", "Heart on Stream"));
  const replayBadge = element("span", "REPLAY", "badge replay-badge");
  replayBadge.hidden = !replay;
  header.append(brand, replayBadge);
  const steps = element("nav", "", "steps");
  steps.setAttribute("aria-label", "Session progress");
  function screen(name: PanelScreen, text: string) {
    const step = element("span", text);
    steps.append(step);
    const section = element("section", "", `panel-screen panel-${name}`);
    const heading = element("h2", text, "screen-title");
    heading.id = `heading-${name}`;
    heading.tabIndex = -1;
    section.setAttribute("aria-labelledby", heading.id);
    return { name, section, heading, step };
  }
  const consentView = screen("consent", replay ? "Replay notice" : "Consent");
  const setupView = screen("setup", "Setup");
  const liveView = screen("live", "Live");
  const receiptView = screen("receipt", "Receipt");
  const screens = [consentView, setupView, liveView, receiptView];
  const { section: consentScreen, heading: consentTitle } = consentView;
  const { section: setup, heading: setupTitle } = setupView;
  const { section: live, heading: liveTitle } = liveView;
  const { section: receipt, heading: receiptHeading } = receiptView;
  const consent = element("input");
  consent.type = "checkbox";
  consent.id = "only-person";
  const consentLabel = element("label", "", "check-label");
  consentLabel.append(consent, " I am the only person on camera");
  consentLabel.hidden = replay;
  const agree = button(
    replay ? "Continue to setup" : "I agree",
    "agree",
    () => {
      const agreement = {
        type: "agree",
        onlyPerson: consent.checked,
      } as const;
      if (transitionFlow(flow, agreement) === flow) return;
      acceptingConsent = true;
      updateControls();
      void run(async () => {
        await actions.acceptConsent();
        flow = transitionFlow(flow, agreement);
      }).finally(() => {
        acceptingConsent = false;
        renderScreen();
      });
    },
  );
  agree.className = "primary";
  const heroText = element("div");
  consentTitle.textContent = replay
    ? "Replay notice"
    : "Your face. Your rules.";
  if (!replay)
    heroText.append(element("p", "BEFORE THE CAMERA TURNS ON", "eyebrow"));
  heroText.append(
    consentTitle,
    element(
      "p",
      replay
        ? "Replay plays back a saved session of numeric signal and status data. The camera and session recording stay off."
        : "Pulse and breathing estimates come from your camera via the Presage SmartSpectra SDK.",
      "hero-intro",
    ),
  );
  const hero = card(heroText, heart("hero-heart"));
  hero.className = "card consent-hero";
  consentScreen.append(hero);
  if (!replay) {
    const disclosures = element("div", "", "disclosure-grid");
    for (const [title, text] of [
      [
        "Camera stays off",
        "The camera stays off until you agree and start a session.",
      ],
      [
        "Computed on this computer",
        "Pulse and breathing are computed on this computer. The SDK contacts Presage to check your API key. SDK telemetry is disabled.",
      ],
      [
        "Viewers see only your dial",
        "The overlay shows only what your selected privacy mode allows. This panel is for you, the streamer, only.",
      ],
      [
        "One person on camera",
        "Measurement pauses if a second face comes into view.",
      ],
    ])
      disclosures.append(card(element("h3", title), element("p", text)));
    const insights = card(
      element("h3", "Presage LLM Insights"),
      element(
        "p",
        "During live measurement the Presage SDK also sends automatic LLM Insights check-ins: once readings stabilize and then every 60 seconds, it sends an allowlisted set of the vitals the SDK has computed (pulse rate, breathing rate and heart-rate variability, where available) with session and request identifiers, but no video or images, to Presage, which forwards them to a language model. The SDK has no setting to turn this off. Heart on Stream never requests insights and ignores any replies.",
      ),
    );
    insights.className = "card disclosure-box";
    const storage = element("div", "", "consent-storage");
    storage.append(
      element("h3", "Stored only here"),
      element(
        "p",
        "No video or images are ever saved or sent anywhere. Your camera choice and highlights.json are stored locally. Numeric session recordings are saved only if recording is enabled.",
      ),
      element(
        "p",
        "For wellness / entertainment. This is not a medical device.",
        "muted",
      ),
    );
    consentScreen.append(disclosures, insights, storage);
  }
  const consentFooter = card(consentLabel, agree);
  consentFooter.className = "card consent-footer";
  consentScreen.append(consentFooter);

  const configurationMessage = status("configuration-message");
  configurationMessage.textContent = "Loading local configuration…";
  const camera = select("camera", []);
  const cameraMessage = status("camera-message");
  const virtualCameraHint = status("virtual-camera-hint");
  virtualCameraHint.textContent =
    "Start the virtual camera in OBS first; otherwise it sends a placeholder image.";
  virtualCameraHint.hidden = true;
  const refresh = button(
    "Refresh cameras",
    "refresh-cameras",
    actions.refreshCameras,
  );
  const cameraGroup = element("div");
  cameraGroup.hidden = replay;
  cameraGroup.append(
    label("Camera", camera),
    camera,
    virtualCameraHint,
    cameraMessage,
    refresh,
  );
  const config = select("metric-config", [
    ["a", "(a) Pulse rate, pulse waveform, talking"],
    ["b", "(b) Config (a) + chest breathing, breathing rate"],
  ]);
  // Default (b): live tests showed it matches (a) on pulse and adds breathing for the overlay.
  config.value = "b";
  config.disabled = replay;
  const replayMetricsHelp = element(
    "p",
    "Replay uses the metrics already saved in the file.",
    "help",
  );
  replayMetricsHelp.hidden = !replay;
  const mode = createPrivacyDial("privacy-mode", "privacy-help", () =>
    updateControls(),
  );
  const liveMode = createPrivacyDial(
    "live-privacy-mode",
    "live-privacy-help",
    (mode) => {
      void run(() => actions.setPrivacyMode(mode));
    },
  );
  const cycleHelp = () =>
    element(
      "p",
      "Use the arrow keys to move between modes and Enter or Space to apply. The privacy hotkey cycles Vibe → Numbers → Highlights only. Off ends measurement.",
      "help",
    );
  const record = element("input");
  record.type = "checkbox";
  record.id = "record-session";
  const recordLabel = element("label", "", "check-label");
  recordLabel.append(record, " Record session");
  const recordingHelp = element(
    "p",
    "Opt-in saves numeric/status frames only in <project root>/recordings/. The --record launch flag enables recording for every session.",
    "help",
  );
  recordLabel.hidden = recordingHelp.hidden = replay;
  const replayFile = element("p", "", "file-path");
  replayFile.hidden = !replay;
  const overlayUrl = element("code");
  overlayUrl.id = "overlay-url";
  const copyMessage = status("copy-message");
  const copy = button("Copy", "copy-overlay", () => {
    void command(actions.copyOverlayUrl, copyMessage);
  });
  const urlRow = element("div", "", "url-row");
  urlRow.append(overlayUrl, copy);
  const start = button(
    replay ? "Start replay" : "Start session",
    "start",
    () => {
      if (!flow.consentAccepted || start.disabled) return;
      updateFlow({ type: "start" });
      pending = true;
      updateControls();
      void run(() =>
        actions.start(
          replay ? "" : (selectedCamera()?.deviceId ?? ""),
          config.value === "b" ? "b" : "a",
          !replay && record.checked,
          mode.value,
        ),
      ).finally(() => {
        pending = false;
        if (
          flow.screen === "live" &&
          !flow.sessionActive &&
          !flow.captureBusy
        ) {
          flow = { ...flow, screen: "setup" };
          renderScreen();
        }
        updateControls();
      });
    },
  );
  start.className = "primary";
  const sessionSettings = card(
    element("h3", "Measurement"),
    cameraGroup,
    label("Metric configuration", config),
    config,
    replayMetricsHelp,
    recordLabel,
    recordingHelp,
  );
  const sharingSettings = card(
    mode.group,
    cycleHelp(),
    element("h3", "OBS Browser Source"),
    urlRow,
    copyMessage,
  );
  sharingSettings.className = "card sharing-settings";
  const setupGrid = element("div", "", "setup-grid");
  setupGrid.append(sessionSettings, sharingSettings);
  const setupControls = element("div", "", "controls setup-controls");
  setup.append(
    setupTitle,
    configurationMessage,
    replayFile,
    setupGrid,
    setupControls,
  );

  const liveHeader = element("div", "", "live-header");
  const liveBadges = element("div", "", "live-badges");
  const liveStatus = element("span", "Starting…", "badge live-status");
  liveStatus.hidden = replay;
  const indicator = status("measuring-indicator");
  indicator.className = replay ? "badge live-status" : "badge";
  indicator.textContent = replay ? "Replay stopped" : "Camera off";
  const liveObs = element("span", "OBS is disconnected.", "badge");
  liveObs.setAttribute("aria-hidden", "true");
  const liveCamera = element("p", "", "muted");
  liveCamera.id = "live-camera";
  liveCamera.hidden = true;
  const badge = element("span", "Vibe", "badge");
  badge.id = "privacy-badge";
  liveBadges.append(liveStatus, indicator, liveObs, badge);
  const phase = status("session-phase");
  phase.className = "phase";
  const preview = element("video");
  preview.autoplay = true;
  preview.muted = true;
  preview.playsInline = true;
  preview.hidden = replay;
  preview.setAttribute("aria-label", "Local camera preview");
  const multipleFaces = status("multiple-faces", true);
  multipleFaces.className = "warning";
  multipleFaces.hidden = true;
  const unusableInput = status("unusable-input", true);
  unusableInput.className = "warning";
  unusableInput.hidden = true;
  unusableInput.textContent =
    "No usable face for 60 s. Measurement paused to save credits. Press Resume when ready.";
  const cameraDisconnected = status("camera-disconnected", true);
  cameraDisconnected.className = "warning";
  cameraDisconnected.hidden = true;
  cameraDisconnected.textContent =
    "Camera disconnected. Reconnect it and press Resume.";
  const condition = status("condition");
  const validation = element("p", "Waiting for camera conditions…");
  const quality = element("ul", "", "checklist");
  const pulseQuality = element("li");
  const talkingQuality = element("li");
  quality.append(pulseQuality, talkingQuality);
  const highlights = element("ol", "", "highlights");
  highlights.id = "highlights";
  const emptyHighlights = element(
    "p",
    "Highlights will appear here as your pulse rises relative to your own baseline.",
    "help",
  );
  const raw = element("details");
  raw.append(
    element("summary", "Raw SDK values"),
    element(
      "p",
      "Latest SDK output. Estimates can be stale during or after a warning or pause.",
      "help",
    ),
  );
  const rawValues = element("dl");
  const values = new Map<string, HTMLElement>();
  for (const text of [
    "Pulse rate",
    "Confidence",
    "Stable",
    "Breathing rate",
    "Talking",
    "Validation code",
    "Processing status",
    "Frames per second",
  ]) {
    const value = element("dd", "—");
    rawValues.append(element("dt", text), value);
    values.set(text, value);
  }
  raw.append(rawValues);
  const pause = button("Pause", "pause", () => {
    void run(actions.pause);
  });
  const resume = button("Resume", "resume", () => {
    void run(actions.resume);
  });
  resume.hidden = true;
  const stop = button("End session", "end-session", () => {
    void run(actions.stop);
  });
  stop.className = "danger";
  const controls = element("div", "", "controls");
  controls.append(pause, resume, stop);
  liveTitle.className = "sr-only";
  liveHeader.append(liveTitle, liveBadges, controls);
  const conditionGroup = card(
    element("h3", "Conditions"),
    preview,
    liveCamera,
    condition,
    validation,
    quality,
  );
  const pulseValue = element("strong", "—", "signal-value");
  const breathingValue = element("strong", "—", "signal-value");
  const readings = element("dl", "", "signal-readings");
  for (const [title, value, unit] of [
    ["Pulse", pulseValue, "BPM"],
    ["Breathing", breathingValue, "breaths/min"],
  ] as const) {
    const metric = element("div", "", "signal-metric");
    const reading = element("dd");
    reading.append(value, element("span", unit, "signal-unit"));
    metric.append(element("dt", title), reading);
    readings.append(metric);
  }
  const intensity = element("span", "Calm", "badge intensity");
  intensity.hidden = true;
  const baseline = element("p", "", "baseline-note");
  const signalCaption = element("div", "", "signal-caption");
  signalCaption.append(element("h3", "Your signal"), intensity);
  const signalTop = element("div", "", "signal-top");
  signalTop.append(heart("signal-heart"), readings);
  const chart = createPulseChart();
  const history = new PulseHistory();
  const signal = card(signalCaption, phase, signalTop, baseline, chart.root);
  signal.className = "card signal-card";

  const livePrivacy = card(
    element("h3", "What viewers see"),
    liveMode.group,
    cycleHelp(),
  );
  const liveSide = element("div", "", "live-side");
  liveSide.append(livePrivacy, conditionGroup);
  const liveGrid = element("div", "", "live-grid");
  liveGrid.append(signal, liveSide);
  raw.className = "card raw-card";
  const highlightsCard = card(
    element("h3", "Session highlights"),
    emptyHighlights,
    highlights,
  );
  const liveDetails = element("div", "", "live-details");
  liveDetails.append(highlightsCard, raw);
  live.append(
    liveHeader,
    multipleFaces,
    unusableInput,
    cameraDisconnected,
    liveGrid,
    liveDetails,
    element(
      "p",
      "Pause / Resume: Cmd/Ctrl+Shift+P · Privacy: Cmd/Ctrl+Shift+M",
      "help hotkeys",
    ),
  );

  const receiptSummary = element(
    "p",
    receiptText(replay, 0, false),
    "receipt-summary sr-only",
  );
  receiptSummary.id = "receipt-summary";
  const receiptTiles = element("dl", "", "receipt-tiles");
  // The full receipt summary provides the equivalent content to screen readers.
  receiptTiles.setAttribute("aria-hidden", "true");
  function receiptTile(title: string) {
    const value = element("dd");
    const tile = card(element("dt", title), value);
    receiptTiles.append(tile);
    return { tile, value };
  }
  const cameraTile = receiptTile("Camera");
  const videoTile = receiptTile("Video saved");
  const telemetryTile = receiptTile("SDK telemetry");
  const presageTile = receiptTile("Sent to Presage");
  telemetryTile.tile.hidden = replay;
  const timeline = createReceiptTimeline();
  const setupDeleteMessage = status("setup-delete-message");
  const receiptMessage = status("receipt-message");
  const setupDelete = deleteControls("setup-", setupDeleteMessage);
  const receiptDelete = deleteControls("", receiptMessage);
  setupControls.append(start, setupDelete.trigger);
  setup.append(setupDelete.confirmation, setupDeleteMessage);
  function deleteControls(prefix: string, message: HTMLElement) {
    const confirmation = element("div", "", "confirmation");
    confirmation.hidden = true;
    const trigger = button("Delete all data", `${prefix}delete-data`, () => {
      confirmation.hidden = false;
      confirm.focus();
    });
    trigger.className = "danger";
    const confirm = button(
      "Delete permanently",
      `${prefix}confirm-delete`,
      () => {
        confirmation.hidden = true;
        void command(deleteAllData, message).finally(() => trigger.focus());
      },
    );
    confirm.className = "danger";
    const cancel = button("Keep data", `${prefix}cancel-delete`, () => {
      confirmation.hidden = true;
      trigger.focus();
    });
    confirmation.append(
      element(
        "p",
        "Delete all local highlights, app session recordings, and the remembered camera choice? This cannot be undone. Exported text files and chapters already inside OBS recordings are kept.",
      ),
      confirm,
      cancel,
    );
    return { trigger, confirmation, confirm };
  }
  const exportButton = button(
    "Export YouTube chapters",
    "export-chapters",
    () => {
      if (!flow.hasMainSession) return;
      void command(actions.exportChapters, receiptMessage);
    },
  );
  const saveHighlights = button(
    "Save highlight list",
    "save-highlights",
    () => {
      void command(actions.saveHighlightList, receiptMessage);
    },
  );
  const newSession = button("New session", "new-session", () => {
    if (transitionFlow(flow, { type: "new" }) === flow) return;
    receiptMessage.textContent = "";
    showHighlights([], null, false);
    history.reset();
    chart.render(false, [], null, null, null);
    recordingPath.textContent = "";
    error.textContent = "";
    mode.setValue("vibe");
    liveMode.setValue("vibe");
    updateFlow({ type: "new" });
  });
  newSession.className = "primary";
  receiptHeading.textContent = receiptTitle(0);
  const receiptHero = card(receiptHeading, receiptSummary);
  receiptHero.className = "card receipt-hero";
  const receiptControls = element("div", "", "controls");
  receiptControls.append(
    exportButton,
    saveHighlights,
    receiptDelete.trigger,
    newSession,
  );
  const receiptActions = card(
    receiptControls,
    element(
      "p",
      "Save a highlight list to keep every timestamp, even when YouTube chapter rules cannot be met.",
      "help",
    ),
    receiptDelete.confirmation,
    receiptMessage,
  );
  receipt.append(receiptHero, receiptTiles, timeline.root, receiptActions);
  const runtimeStatus = element("footer");
  const obs = status("obs-status");
  const overlayError = status("overlay-error");
  const replayMessage = status("replay-message");
  const shortcuts = status("shortcut-message");
  const sessionErrors = status("session-errors");
  const recordingStatus = status("recording-status");
  const recordingPath = element("p", "", "file-path");
  const recordingError = status("recording-error");
  recordingStatus.hidden =
    recordingPath.hidden =
    recordingError.hidden =
      replay;
  recordingStatus.textContent = "Recording: off";
  const error = status("command-error", true);
  const readingsNotice = element(
    "p",
    "Wellness / entertainment, not a medical device. Readings are camera-based estimates.",
  );
  readingsNotice.id = "readings-notice";
  runtimeStatus.append(
    readingsNotice,
    obs,
    overlayError,
    shortcuts,
    replayMessage,
    sessionErrors,
    recordingStatus,
    recordingPath,
    recordingError,
    error,
  );
  root.replaceChildren(
    header,
    steps,
    ...screens.map(({ section }) => section),
    runtimeStatus,
  );

  let cameraOn = false;
  let cameras: readonly CameraDevice[] = [];
  let rememberedCamera = replay ? undefined : readCameraPreference();
  let flow = initialFlow(replay);
  let acceptingConsent = false;
  let canStart = false;
  let recordByDefault = false;
  let pending = false;
  let commandBusy = false;
  let lastScreen: PanelScreen | null = null;
  let latestState: PanelStatePayload | null = null;
  let disconnectedThrough: number | null = null;
  let sdkValidationCode: number | null = null;
  let lastHighlightKey = "";
  let lastTimelineDuration: number | null = null;
  function write(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }
  function selectedCamera(): CameraDevice | undefined {
    return cameras[camera.selectedIndex];
  }
  function rememberCamera(device: CameraDevice): void {
    if (!device.deviceId && !device.label) return;
    if (
      device.deviceId === rememberedCamera?.deviceId &&
      device.label === rememberedCamera.label
    )
      return;
    rememberedCamera = device;
    saveCameraPreference(device);
  }
  function showCameraChoice(): void {
    const selected = selectedCamera();
    virtualCameraHint.hidden = !selected || !isVirtualCamera(selected.label);
    cameraMessage.textContent = !cameras.length
      ? "No video inputs found. Connect a webcam or enable OBS Virtual Camera, then refresh."
      : !selected
        ? "Choose a camera to start."
        : selected.label
          ? ""
          : "Camera names appear after access is granted.";
    updateControls();
  }
  function restoreCameraChoice(): CameraDevice | undefined {
    const selected = selectCamera(cameras, rememberedCamera);
    camera.selectedIndex = selected ? cameras.indexOf(selected) : -1;
    showCameraChoice();
    return selected;
  }
  function updateControls(): void {
    consent.disabled = acceptingConsent;
    agree.disabled = acceptingConsent || (!replay && !consent.checked);
    start.disabled =
      !canStart ||
      !flow.consentAccepted ||
      pending ||
      commandBusy ||
      flow.captureBusy ||
      flow.sessionActive ||
      (!replay && !selectedCamera()) ||
      mode.value === "off";
    record.disabled = replay || recordByDefault || pending;
    const sharingControlsDisabled =
      !flow.sessionActive || latestState?.privacyMode === "off";
    pause.disabled =
      resume.disabled =
      liveMode.group.disabled =
        sharingControlsDisabled;
    stop.disabled = !flow.sessionActive && !flow.captureBusy && !pending;
    exportButton.disabled = commandBusy || !flow.hasMainSession;
    newSession.disabled = commandBusy;
    for (const { trigger, confirm } of [setupDelete, receiptDelete])
      trigger.disabled = confirm.disabled =
        commandBusy || pending || flow.captureBusy || flow.sessionActive;
    copy.disabled = !overlayUrl.textContent || commandBusy;
    saveHighlights.disabled =
      commandBusy ||
      !flow.hasMainSession ||
      !latestState ||
      sessionHighlights(latestState).length === 0;
  }
  function renderScreen(): void {
    for (const { name, section, step } of screens) {
      section.hidden = name !== flow.screen;
      step.setAttribute(
        "aria-current",
        name === flow.screen ? "step" : "false",
      );
    }
    if (lastScreen !== flow.screen) {
      setupDelete.confirmation.hidden =
        receiptDelete.confirmation.hidden = true;
      screens.find(({ name }) => name === flow.screen)?.heading.focus();
      lastScreen = flow.screen;
    }
    updateControls();
  }
  function updateFlow(event: FlowEvent): void {
    flow = transitionFlow(flow, event);
    renderScreen();
  }
  async function run(action: () => Promise<void>): Promise<void> {
    error.textContent = "";
    try {
      await action();
    } catch (failure) {
      error.textContent =
        failure instanceof Error
          ? failure.message
          : "The session command failed.";
    }
  }
  async function command(
    action: () => Promise<PanelCommandResult>,
    target: HTMLElement,
  ): Promise<void> {
    if (commandBusy) return;
    commandBusy = true;
    updateControls();
    try {
      target.textContent = (await action()).message;
    } catch {
      target.textContent = "The command could not complete. Try again.";
    } finally {
      commandBusy = false;
      updateControls();
    }
  }
  async function deleteAllData(): Promise<PanelCommandResult> {
    const result = await actions.deleteAllData();
    if (!result.ok) return result;
    try {
      forgetCameraPreference();
    } catch {
      return {
        ok: false,
        message:
          "Session data was deleted. Unable to clear the remembered camera choice. Try again.",
      };
    }
    rememberedCamera = undefined;
    restoreCameraChoice();
    return result;
  }
  const show = (name: string, text: string): void => {
    const node = values.get(name);
    if (node) node.textContent = text;
  };
  function showReadings(state: PanelStatePayload): void {
    const disconnected = !cameraDisconnected.hidden;
    if (!state.active) disconnectedThrough = null;
    else if (disconnected)
      disconnectedThrough = Math.max(
        disconnectedThrough ?? -1,
        state.t ?? -1,
        state.pulse?.t ?? -1,
        state.breathing?.t ?? -1,
        state.talking?.t ?? -1,
        state.validation?.t ?? -1,
      );
    // Main retains raw readings across a pause. Wait for a fresh reading of
    // each kind so the disconnected camera's values stay hidden after Resume.
    const current = <T extends { readonly t: number }>(reading: T | null) =>
      !disconnected &&
      reading !== null &&
      (disconnectedThrough === null || reading.t > disconnectedThrough)
        ? reading
        : null;
    const pulse = current(state.pulse);
    const breathing = current(state.breathing);
    const talking = current(state.talking);
    const validationState = current(state.validation);
    const pulseOutOfRange =
      state.pulseOutOfRange &&
      !disconnected &&
      (disconnectedThrough === null || (state.t ?? -1) > disconnectedThrough);
    const hidden =
      !state.active ||
      disconnected ||
      state.privacyMode === "off" ||
      state.phase === "paused" ||
      state.pauseReason !== null ||
      (state.validation !== null && state.validation.code !== "ok") ||
      pulseOutOfRange;
    const fresh = <T extends { readonly t: number }>(reading: T | null) =>
      reading &&
      (state.readingsFreshAfter === null ||
        reading.t > state.readingsFreshAfter)
        ? reading
        : null;
    if (!state.active) history.reset();
    // Main can withdraw the pulse before it reports a queued second-face warning.
    const withdrawn = pulse === null && history.samples.length > 0;
    const time = state.runtime?.sessionStartedAt === null ? null : state.t;
    const visiblePulse = state.active
      ? history.update(time, fresh(pulse), hidden || withdrawn)
      : null;
    const visibleBreathing = hidden ? null : fresh(breathing);
    const baselineBpm = visiblePulse === null ? null : state.baselineBpm;
    const threshold = state.talkingRecent
      ? DEFAULT_SPIKE_POLICY.talkingSpikeDeltaBpm
      : DEFAULT_SPIKE_POLICY.spikeDeltaBpm;
    chart.render(
      visiblePulse !== null,
      history.samples,
      time,
      baselineBpm,
      baselineBpm === null ? null : baselineBpm + threshold,
    );
    const delta =
      baselineBpm === null || visiblePulse === null
        ? null
        : Math.round(visiblePulse.value - baselineBpm);
    write(
      baseline,
      baselineBpm === null || delta === null
        ? ""
        : `Your baseline ${Math.round(baselineBpm)} · ${delta >= 0 ? "+" : ""}${delta} now`,
    );
    write(pulseValue, visiblePulse ? visiblePulse.value.toFixed(0) : "—");
    write(breathingValue, visibleBreathing?.value.toFixed(1) ?? "—");
    intensity.hidden = visiblePulse === null;
    signal.setAttribute(
      "data-intensity",
      visiblePulse === null ? "" : state.intensity,
    );
    write(
      intensity,
      state.intensity === "spike"
        ? "Spike"
        : state.intensity === "elevated"
          ? "Elevated"
          : "Calm",
    );
    write(
      condition,
      validationState?.hint || "Waiting for the SDK condition hint…",
    );
    validation.textContent = `Validation: ${validationState?.code ?? "waiting"}`;
    pulseQuality.textContent = `Pulse signal: ${pulse?.stable && pulse.confidence >= 50 ? "ready" : "waiting for a stable estimate"}`;
    talkingQuality.textContent = `Talking: ${talking ? (talking.detected ? "yes — try to stay quiet for a clearer signal" : "no") : "waiting"}`;
    show(
      "Pulse rate",
      pulseOutOfRange
        ? "out of range"
        : pulse
          ? `${pulse.value.toFixed(1)} BPM`
          : "—",
    );
    show("Confidence", pulse ? String(pulse.confidence) : "—");
    show("Stable", pulse ? String(pulse.stable) : "—");
    show(
      "Breathing rate",
      breathing ? `${breathing.value.toFixed(1)} breaths/min` : "—",
    );
    show("Talking", talking ? String(talking.detected) : "—");
    show(
      "Validation code",
      !replay && sdkValidationCode !== null
        ? `${sdkValidationCode} (${validationState?.code ?? "waiting"})`
        : (validationState?.code ?? "—"),
    );
  }
  function showHighlights(
    current: ReturnType<typeof sessionHighlights>,
    durationMs: number | null,
    sdkStarted: boolean,
  ): void {
    const key = JSON.stringify(current);
    if (key !== lastHighlightKey) {
      highlights.replaceChildren(
        ...current.map((highlight) =>
          element(
            "li",
            `${sessionTime(highlight.sessionOffsetUs)} · ${highlight.label}`,
          ),
        ),
      );
      emptyHighlights.hidden = current.length > 0;
    }
    if (key !== lastHighlightKey || durationMs !== lastTimelineDuration) {
      timeline.render(durationMs, current);
      lastTimelineDuration = durationMs;
    }
    lastHighlightKey = key;
    write(receiptHeading, receiptTitle(current.length));
    write(receiptSummary, receiptText(replay, current.length, sdkStarted));
    const facts = receiptFacts(replay, sdkStarted);
    write(cameraTile.value, facts.camera);
    write(videoTile.value, facts.video);
    write(telemetryTile.value, facts.telemetry ?? "SDK did not start");
    write(presageTile.value, facts.presage);
  }
  consent.addEventListener("change", updateControls);
  camera.addEventListener("change", () => {
    const selected = selectedCamera();
    if (selected) rememberCamera(selected);
    showCameraChoice();
  });
  showHighlights([], null, false);
  renderScreen();
  return {
    showSession(state: PanelStatePayload): void {
      latestState = state;
      const wasActive = flow.sessionActive;
      updateFlow({ type: "session", active: state.active });
      if (state.active || wasActive) {
        if (mode.value !== state.privacyMode) mode.setValue(state.privacyMode);
        if (liveMode.value !== state.privacyMode)
          liveMode.setValue(state.privacyMode);
      }
      write(badge, privacyLabels[state.privacyMode]);
      write(liveStatus, state.active ? "LIVE" : "Starting…");
      const running =
        state.active &&
        state.pauseReason === null &&
        state.privacyMode !== "off";
      (replay ? indicator : liveStatus).setAttribute(
        "data-running",
        String(running),
      );
      write(
        indicator,
        replay
          ? !state.active
            ? "Replay stopped"
            : state.pauseReason !== null
              ? "Replay paused"
              : "Replay playing"
          : cameraOn
            ? "Camera on"
            : state.active &&
                state.privacyMode !== "off" &&
                state.pauseReason === null
              ? "Starting camera…"
              : "Camera off",
      );
      write(phase, phaseText(state));
      pause.hidden = state.pauseReason !== null;
      resume.hidden = state.pauseReason === null;
      unusableInput.hidden = state.pauseReason !== "unusableInput";
      const message = multipleFacesMessage(state);
      write(multipleFaces, message);
      multipleFaces.hidden = !message;
      showReadings(state);
      showHighlights(
        flow.hasMainSession ? sessionHighlights(state) : [],
        flow.hasMainSession && !state.active ? state.sessionDurationMs : null,
        flow.hasMainSession && state.sdkStarted,
      );
      show("Processing status", state.processing);
      if (replay)
        show("Frames per second", "Not included in numeric replay frames");
      write(
        sessionErrors,
        state.errors.map((entry) => entry.message).join(" "),
      );
      if (state.runtime) {
        write(obs, state.runtime.obsMessage);
        write(liveObs, state.runtime.obsMessage);
        overlayUrl.textContent = state.runtime.overlayUrl;
        write(overlayError, state.runtime.overlayError);
        replayFile.textContent = `Replay file: ${state.runtime.replayFile || "unavailable"}`;
        write(replayMessage, state.runtime.replayMessage);
        write(shortcuts, state.runtime.shortcutMessage ?? "");
      }
      updateControls();
    },
    showError(message: string): void {
      error.textContent = message;
    },
    showConfiguration(configuration: PublicConfiguration): void {
      canStart = configuration.canStart;
      recordByDefault = configuration.recordByDefault;
      record.checked = recordByDefault;
      configurationMessage.textContent = configuration.message;
      updateControls();
    },
    showRecording(state: RecordingState): void {
      write(recordingStatus, `Recording: ${state.active ? "on" : "off"}`);
      recordingPath.textContent =
        flow.hasMainSession && state.filePath ? `File: ${state.filePath}` : "";
      write(recordingError, state.error);
    },
    showCameras(devices: readonly CameraDevice[]): CameraDevice | undefined {
      cameras = devices;
      camera.replaceChildren(
        ...devices.map((device, index) => {
          const option = element(
            "option",
            device.label || `Camera ${index + 1}`,
          );
          option.value = device.deviceId;
          return option;
        }),
      );
      return restoreCameraChoice();
    },
    showCameraError(message: string): void {
      cameraMessage.textContent = message;
    },
    showStream(stream: MediaStream | null): void {
      cameraOn = stream !== null;
      if (!replay) write(indicator, cameraOn ? "Camera on" : "Camera off");
      const track = stream?.getVideoTracks()[0];
      const label = track?.label;
      liveCamera.hidden = replay || !label;
      write(liveCamera, label ? `Camera: ${label}` : "");
      if (track) {
        const deviceId = track.getSettings().deviceId ?? "";
        if (
          !rememberedCamera ||
          (deviceId && deviceId === rememberedCamera.deviceId) ||
          (label && label === rememberedCamera.label)
        ) {
          rememberCamera({
            deviceId: deviceId || rememberedCamera?.deviceId || "",
            label: label || rememberedCamera?.label || "",
          });
        }
      }
      preview.srcObject = stream;
      if (stream) void preview.play().catch(() => {});
    },
    showMeasurement(state: DebugViewModel): void {
      sdkValidationCode = state.validation?.code ?? null;
      const hideDisconnect = !state.cameraDisconnected;
      if (cameraDisconnected.hidden !== hideDisconnect) {
        cameraDisconnected.hidden = hideDisconnect;
        if (latestState) showReadings(latestState);
      }
      updateFlow({ type: "capture", busy: state.active || state.busy });
      show("Frames per second", state.fps.toFixed(1));
      show("Processing status", state.processingStatus);
      if (state.validation)
        show(
          "Validation code",
          `${state.validation.code} (${latestState?.validation?.code ?? "waiting"})`,
        );
      write(error, state.error);
    },
  };
}
