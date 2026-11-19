import type { Highlight } from "../../domain/session/index";
import type {
  ObsClient,
  ObsProfileParameter,
  ObsRecordingState,
  ObsRecordingStatus,
} from "../obs/obs-websocket-marker";
import {
  estimateRecordingDurationMs,
  type RecordingDurationReport,
  type RecordingDurationResult,
} from "./session-export";

const profileRetryDelaysMs = [1_000, 2_000, 4_000];

/** Track the OBS video that overlaps a run, including after either one ends. */
export function observeExportDuration(
  client: ObsClient,
  options: { readonly nowMs?: () => number } = {},
) {
  const nowMs = options.nowMs ?? (() => performance.now());
  let generation = 0;
  let statusVersion = 0;
  let requestId = 0;
  let lastAcceptedRequest = 0;
  let active: boolean | undefined;
  let runActive = false;
  let runEnded = false;
  let overlappingGeneration: number | null = null;
  let finishedFile: { generation: number; durationMs: number } | null = null;
  let markedGeneration: number | null = null;
  let latestOffsetMs = 0;
  let mixedRecordings = false;
  let fileOriginMs: number | null = null;
  let runSpansFiles = false;
  let report: RecordingDurationReport | null = null;
  let stoppedAtMs: number | null = null;
  let connectionLost = false;
  let disposed = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<void> | null = null;
  let profileVerification: { result: Promise<boolean>; cancel(): void } | null =
    null;

  function pollWhileActive(): void {
    if (disposed || connectionLost || active !== true) {
      clearInterval(poll);
      poll = undefined;
    } else if (poll === undefined) {
      poll = setInterval(() => void readStatus(), 5000);
      poll.unref();
    }
  }

  function fileOffsetMs(outputDurationMs: number): number | null {
    return fileOriginMs !== null && outputDurationMs >= fileOriginMs
      ? outputDurationMs - fileOriginMs
      : null;
  }

  function fileDurationMs(): number | undefined {
    const durationMs = estimateRecordingDurationMs(report, stoppedAtMs);
    return durationMs === undefined
      ? undefined
      : (fileOffsetMs(durationMs) ?? undefined);
  }

  function replaceTimeline(): void {
    if (
      runEnded &&
      (overlappingGeneration === generation || markedGeneration === generation)
    ) {
      const durationMs = fileDurationMs();
      if (durationMs !== undefined) finishedFile = { generation, durationMs };
    }
    generation++;
    statusVersion++;
    profileVerification?.cancel();
    fileOriginMs = null;
    report = null;
    stoppedAtMs = null;
    active = undefined;
    pollWhileActive();
  }

  function observeOverlap(recordingObserved = active === true): void {
    if (!runActive || !recordingObserved) return;
    overlappingGeneration ??= generation;
  }

  function invalidateProgress(): void {
    if (stoppedAtMs === null && report !== null)
      report = { ...report, reportedAtMs: null };
  }

  function reported(state: ObsRecordingStatus): void {
    if (
      !state ||
      typeof state.outputActive !== "boolean" ||
      !Number.isFinite(state.outputDuration) ||
      state.outputDuration < 0
    ) {
      invalidateProgress();
      return;
    }
    if (typeof state.outputPaused !== "boolean") invalidateProgress();
    const outputActive = state.outputActive || state.outputPaused === true;
    if (
      outputActive &&
      (active === false || state.outputDuration < (report?.durationMs ?? 0))
    ) {
      replaceTimeline();
      verifyUnsplitOrigin();
    }
    if (active !== outputActive) statusVersion++;
    active = outputActive;
    observeOverlap();
    if (active) {
      report = {
        durationMs: state.outputDuration,
        reportedAtMs: state.outputPaused === false ? nowMs() : null,
      };
    } else if (
      stoppedAtMs === null &&
      state.outputDuration > (report?.durationMs ?? -1)
    ) {
      // Without a stop event, even an inactive status gives only a conservative bound.
      report = { durationMs: state.outputDuration, reportedAtMs: null };
    }
    pollWhileActive();
  }

  const disconnected = (): void => {
    connectionLost = true;
    statusVersion++;
    profileVerification?.cancel();
    active = undefined;
    invalidateProgress();
    pollWhileActive();
  };
  const changed = (state: ObsRecordingState): void => {
    if (disposed || connectionLost) return;
    const paused = state.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED";
    const resumed = state.outputState === "OBS_WEBSOCKET_OUTPUT_RESUMED";
    const stopping =
      state.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPING" ||
      state.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED";
    if (stopping) profileVerification?.cancel();
    // OBS sets outputActive to false in its pause event.
    const outputActive = !stopping && (state.outputActive || paused);
    if (state.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") {
      replaceTimeline();
      fileOriginMs = 0;
    } else if (outputActive && active === false) {
      replaceTimeline();
      verifyUnsplitOrigin();
    }
    if (paused || resumed) {
      // Resume needs a fresh duration before any wall-clock time can be added.
      invalidateProgress();
      statusVersion++;
    } else if (!outputActive && stoppedAtMs === null) {
      stoppedAtMs = nowMs();
      statusVersion++;
    }
    if (active !== outputActive) statusVersion++;
    active = outputActive;
    observeOverlap(outputActive || stopping);
    pollWhileActive();
  };
  const fileChanged = (): void => {
    if (disposed || connectionLost) return;
    const fileChangedAtMs = nowMs();
    runSpansFiles ||= runActive;
    replaceTimeline();
    active = true;
    observeOverlap();
    pollWhileActive();
    // The event carries only a file path. Sample the output clock at the boundary.
    void requestStatus(fileChangedAtMs).catch(() => {});
  };
  client.on("ConnectionClosed", disconnected);
  client.on("ConnectionError", disconnected);
  client.on("RecordStateChanged", changed);
  client.on("RecordFileChanged", fileChanged);

  function call(request: "GetRecordStatus"): Promise<ObsRecordingStatus>;
  function call(
    request: "GetProfileParameter",
    data: ObsProfileParameter,
  ): Promise<{ parameterValue?: string | null }>;
  function call(
    request: "CreateRecordChapter",
    data: { chapterName: string },
  ): Promise<unknown>;
  async function call(
    request: "GetRecordStatus" | "GetProfileParameter" | "CreateRecordChapter",
    data?: ObsProfileParameter | { chapterName: string },
  ): Promise<unknown> {
    if (request === "CreateRecordChapter") {
      if (!data || !("chapterName" in data))
        throw new Error("Chapter name is required.");
      return client.call(request, data);
    }
    if (request === "GetProfileParameter") {
      if (!data || !("parameterName" in data))
        throw new Error("Profile parameter name is required.");
      return client.call(request, data);
    }
    return requestStatus();
  }

  function verifyUnsplitOrigin(): void {
    if (
      stoppedAtMs !== null ||
      fileOriginMs !== null ||
      profileVerification !== null
    )
      return;
    let resolve!: (verified: boolean) => void;
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    const retries = new Set<ReturnType<typeof setTimeout>>();
    const verification = { result, cancel: () => finish(false) };
    profileVerification = verification;
    let remainingChecks = 2;

    function finish(verified: boolean): void {
      profileVerification = null;
      for (const retry of retries) clearTimeout(retry);
      if (verified) fileOriginMs = 0;
      resolve(verified);
    }

    function completeCheck(): void {
      if (--remainingChecks === 0) finish(false);
    }

    function check(
      parameter: ObsProfileParameter,
      unsplit: (value: string | null | undefined) => boolean,
      attempt = 0,
    ): void {
      void withTimeout(() =>
        client.call("GetProfileParameter", parameter),
      ).then(
        (response) => {
          if (profileVerification !== verification) return;
          if (
            typeof response === "object" &&
            response !== null &&
            !Array.isArray(response) &&
            unsplit(response.parameterValue)
          )
            finish(true);
          else completeCheck();
        },
        () => {
          if (profileVerification !== verification) return;
          const delay = profileRetryDelaysMs[attempt];
          if (delay === undefined) {
            completeCheck();
            return;
          }
          const retry = setTimeout(() => {
            retries.delete(retry);
            check(parameter, unsplit, attempt + 1);
          }, delay);
          retries.add(retry);
          retry.unref();
        },
      );
    }

    // Simple output has no file splitting, regardless of the saved advanced setting.
    check(
      { parameterCategory: "Output", parameterName: "Mode" },
      (value) => value === "Simple",
    );
    // OBS leaves RecSplitFile unset in a default profile and reads it as false.
    check(
      { parameterCategory: "AdvOut", parameterName: "RecSplitFile" },
      (value) =>
        value === null ||
        value === undefined ||
        (typeof value === "string" && value.toLowerCase() === "false"),
    );
  }

  async function withTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("OBS duration request timed out.")),
            5000,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function requestStatus(
    fileChangedAtMs?: number,
  ): Promise<ObsRecordingStatus> {
    const expected = generation;
    const expectedVersion = statusVersion;
    const id = ++requestId;
    const isCurrent = () =>
      !disposed &&
      !connectionLost &&
      expected === generation &&
      expectedVersion === statusVersion;
    const acceptReport = (): boolean => {
      if (!isCurrent() || id <= lastAcceptedRequest) return false;
      lastAcceptedRequest = id;
      return true;
    };
    let state: ObsRecordingStatus;
    try {
      state = await withTimeout(() => client.call("GetRecordStatus"));
    } catch (error) {
      if (acceptReport()) invalidateProgress();
      throw error;
    }
    const current = isCurrent();
    // The event has no media timestamp. Accept the boundary sample only when
    // the local event-to-reply time is under one second, the export resolution.
    if (
      current &&
      fileChangedAtMs !== undefined &&
      nowMs() - fileChangedAtMs < 1_000 &&
      typeof state?.outputActive === "boolean" &&
      (state?.outputActive === true || state?.outputPaused === true) &&
      typeof state.outputPaused === "boolean" &&
      Number.isFinite(state.outputDuration) &&
      state.outputDuration >= 0
    )
      fileOriginMs = state.outputDuration;
    if (acceptReport()) reported(state);
    const sameFile = current && expected === generation;
    const pendingUnsplitOrigin = sameFile
      ? profileVerification?.result
      : undefined;
    return {
      ...state,
      fileOffsetMs:
        sameFile && state ? fileOffsetMs(state.outputDuration) : null,
      ...(pendingUnsplitOrigin === undefined ? {} : { pendingUnsplitOrigin }),
    };
  }

  function readStatus(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = requestStatus()
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  function checkedTimeline(
    selected: number | null,
  ): RecordingDurationResult | null {
    if (mixedRecordings || runSpansFiles)
      return { ok: false, reason: "mixedRecordings" };
    if (disposed) return { ok: false, reason: "timelineReplaced" };
    if (finishedFile !== null && selected === finishedFile.generation)
      return { ok: true, durationMs: finishedFile.durationMs };
    if (fileOriginMs === null || (selected !== null && selected !== generation))
      return { ok: false, reason: "timelineReplaced" };
    return null;
  }

  return {
    // The marker already refreshes GetRecordStatus at each chapter on this shared client.
    client: {
      async connect(...args) {
        const result = await client.connect(...args);
        if (connectionLost && !disposed) {
          // Continuity cannot be established across a reconnect, even at a larger offset.
          replaceTimeline();
          connectionLost = false;
        }
        if (!disposed) verifyUnsplitOrigin();
        return result;
      },
      disconnect: client.disconnect.bind(client),
      call,
      on: client.on.bind(client),
      off: client.off.bind(client),
    } satisfies ObsClient,
    startRun({ alreadyEnded = false } = {}): void {
      runActive = !alreadyEnded;
      runEnded = alreadyEnded;
      overlappingGeneration = null;
      finishedFile = null;
      markedGeneration = null;
      latestOffsetMs = 0;
      mixedRecordings = false;
      runSpansFiles = false;
      observeOverlap();
    },
    endRun(): void {
      runEnded ||= runActive;
      runActive = false;
    },
    get recordingGeneration(): number {
      return generation;
    },
    get verifyingFileOrigin(): boolean {
      return profileVerification !== null;
    },
    marked(offsetMs: number, recordingGeneration = generation): void {
      if (
        (markedGeneration !== null &&
          markedGeneration !== recordingGeneration) ||
        offsetMs < latestOffsetMs
      )
        mixedRecordings = true;
      markedGeneration ??= recordingGeneration;
      latestOffsetMs = offsetMs;
      if (recordingGeneration !== generation || fileOriginMs === null) return;
      const outputDurationMs = fileOriginMs + offsetMs;
      if (outputDurationMs > (report?.durationMs ?? -1))
        report = { durationMs: outputDurationMs, reportedAtMs: null };
      active ??= true;
      pollWhileActive();
    },
    async durationMs(
      highlights: readonly Highlight[],
    ): Promise<RecordingDurationResult> {
      const hasOffsets = highlights.some(
        (highlight) => highlight.recordingOffsetMs !== null,
      );
      // An overlapping video requires OBS offsets even if no chapter was attempted.
      if (
        !hasOffsets &&
        (highlights.length === 0 || overlappingGeneration === null)
      )
        return { ok: true };
      const timeline = () =>
        checkedTimeline(hasOffsets ? markedGeneration : overlappingGeneration);
      const checked = timeline();
      if (checked) return checked;
      if (!hasOffsets) {
        return {
          ok: true,
          durationMs: fileDurationMs() ?? 0,
        };
      }
      if (active !== false && !connectionLost) await readStatus();
      const replaced = timeline();
      if (replaced) return replaced;
      const latestRecordedOffset = highlights.reduce(
        (latest, highlight) =>
          Math.max(latest, highlight.recordingOffsetMs ?? 0),
        latestOffsetMs,
      );
      if (
        active === true &&
        !connectionLost &&
        report !== null &&
        (fileOffsetMs(report.durationMs) ?? -1) < latestRecordedOffset
      ) {
        replaceTimeline();
        return { ok: false, reason: "timelineReplaced" };
      }
      const durationMs = fileDurationMs();
      return durationMs === undefined ? { ok: true } : { ok: true, durationMs };
    },
    dispose(): void {
      disposed = true;
      profileVerification?.cancel();
      pollWhileActive();
      client.off("ConnectionClosed", disconnected);
      client.off("ConnectionError", disconnected);
      client.off("RecordStateChanged", changed);
      client.off("RecordFileChanged", fileChanged);
    },
  };
}
