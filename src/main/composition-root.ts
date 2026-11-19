import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  type IpcMainEvent,
  ipcMain,
} from "electron";
import OBSWebSocket from "obs-websocket-js";
import packageJson from "../../package.json";
import type { SignalSource } from "../application/ports/signal-source";
import { StreamSession } from "../application/use-cases/stream-session";
import { loadConfiguration } from "../infrastructure/electron/configuration";
import { observeExportDuration } from "../infrastructure/electron/obs-export-duration";
import { createPanelCommands } from "../infrastructure/electron/panel-commands";
import { registerSessionShortcuts } from "../infrastructure/electron/session-shortcuts";
import { createWindowHost } from "../infrastructure/electron/window-host";
import { IpcSignalSource } from "../infrastructure/ipc/ipc-signal-source";
import { ObsWebsocketMarker } from "../infrastructure/obs/obs-websocket-marker";
import {
  OverlayServer,
  OverlayServerStartError,
} from "../infrastructure/overlay/overlay-server";
import { JsonlReplaySource } from "../infrastructure/replay/jsonl-replay-source";
import { PerSessionRecorder } from "../infrastructure/replay/per-session-recorder";
import { shouldRecordSession } from "../infrastructure/replay/recording-session";
import { ChapterTextWriter } from "../infrastructure/storage/chapter-text-writer";
import { FsHighlightRepository } from "../infrastructure/storage/fs-highlight-repository";
import { ConsoleLogger } from "../infrastructure/system/console-logger";
import { SystemClock } from "../infrastructure/system/system-clock";
import type {
  MeasurementOptions,
  PanelRuntimeState,
} from "../shared/ipc-contract";
import type { LaunchOptions } from "./launch-options";

/** One adapter graph, with credentials retained only in main memory. */
export function composeApplication(options: LaunchOptions): {
  openWindow(): BrowserWindow;
} {
  const projectRoot = process.cwd();
  const distRoot = join(__dirname, "..");
  const envPath = join(projectRoot, ".env");
  const configuration = loadConfiguration(
    {
      exists: () => existsSync(envPath),
      loadEnvFile: () => process.loadEnvFile(envPath),
      environment: () => process.env,
    },
    options.replay,
    options.record,
  );
  // Replay never loads local credential files or accesses SMARTSPECTRA_API_KEY.
  const password = process.env.OBS_WS_PASSWORD;
  const obsUrl = process.env.OBS_WS_URL;
  const portText = process.env.OVERLAY_PORT ?? "7777";
  delete process.env.SMARTSPECTRA_API_KEY;
  delete process.env.OBS_WS_PASSWORD;
  const port = Number(portText);
  const validPort =
    /^\d+$/u.test(portText) &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535;
  const clock = new SystemClock();
  const logger = new ConsoleLogger([
    configuration.apiKey ?? "",
    password ?? "",
  ]);

  return {
    openWindow: () => {
      const windowConfiguration = { ...configuration };
      return createWindowHost({
        distRoot,
        replay: options.replay,
        configuration: windowConfiguration,
        bindSdk(window) {
          // The window host calls this only for the first consented live Start.
          const { bindSmartSpectraIpc } = createRequire(__filename)(
            "@smartspectra/node-sdk/main",
          ) as typeof import("@smartspectra/node-sdk/main");
          bindSmartSpectraIpc(window);
        },
        createMeasurementSession(
          window,
          isTrusted,
          onActivityChanged,
          hasRecordedConsent,
        ) {
          let runtime: PanelRuntimeState = {
            overlayUrl: validPort ? `http://127.0.0.1:${port}/overlay` : "",
            overlayError: validPort
              ? ""
              : "OVERLAY_PORT must be an integer between 1 and 65535.",
            obsMessage: "OBS is disconnected.",
            replayFile:
              options.replay && options.file ? basename(options.file) : "",
            replayMessage: options.replay ? options.error : "",
          };
          let selection: MeasurementOptions = {
            metricConfig: "a",
            recordSession: false,
          };
          let disposed = false;
          let starting: Promise<void> | null = null;
          let userGeneration = 0;
          let exportRevision = 0;
          let stream: StreamSession;
          let validationTimer: ReturnType<typeof setTimeout> | undefined;
          let scheduledValidationDeadline: number | null = null;
          const send = (channel: string, state: unknown): void => {
            if (!window.isDestroyed()) window.webContents.send(channel, state);
          };
          const sendPanel = (): void => {
            const state = stream.panelState;
            send("panel:state", {
              ...state,
              runtime: {
                ...runtime,
                sessionStartedAt: stream.sessionStartedAt,
                ...(!options.replay && state.active
                  ? { captureGeneration: stream.captureGeneration }
                  : {}),
              },
            });
            send("recording:state", {
              active: state.recording,
              filePath: recorder.filePath,
              error: state.errors
                .filter((error) => error.operation.startsWith("recording"))
                .map((error) => error.message)
                .join(" "),
            });
          };
          let source: SignalSource;
          let replayError = options.error;
          if (options.replay) {
            try {
              if (replayError || !options.file)
                throw new Error(replayError || "Choose a replay file.");
              const replaySource = new JsonlReplaySource(
                resolve(projectRoot, options.file),
                {
                  speed: options.speed,
                  onEnd: () => {
                    // Legacy replays may have neither a drain nor an end record.
                    endRun();
                    const generation = userGeneration;
                    void stream
                      .whenIdle()
                      .then(async () => {
                        if (disposed || generation !== userGeneration) return;
                        await stream.stopSession();
                        if (disposed || generation !== userGeneration) return;
                        if (options.loop) await start(selection, false);
                        else {
                          runtime = {
                            ...runtime,
                            replayMessage: "Replay finished",
                          };
                          sendPanel();
                        }
                      })
                      .catch(() => {
                        runtime = {
                          ...runtime,
                          replayMessage: "Unable to finish replay.",
                        };
                        sendPanel();
                      });
                  },
                },
              );
              replaySource.subscribe((record) => {
                // Freeze overlap at delivery, even if session processing is queued.
                if (record.kind === "drain" || record.kind === "end") endRun();
              });
              source = replaySource;
            } catch (error) {
              replayError =
                error instanceof Error
                  ? error.message
                  : "Unable to decode replay file.";
              runtime = { ...runtime, replayMessage: replayError };
              // An unavailable replay can never fall back to live IPC or a camera.
              source = {
                subscribe: () => () => {},
                start: async () => {
                  throw new Error("Replay file is unavailable.");
                },
                stop: async () => {},
              };
            }
            if (replayError) {
              // Configuration is returned only to the trusted renderer after subscriptions exist.
              windowConfiguration.public = {
                ...windowConfiguration.public,
                canStart: false,
                message: replayError,
              };
            }
          } else {
            source = new IpcSignalSource<IpcMainEvent>(ipcMain, isTrusted, {
              nowMs: () => clock.now() / 1000,
              warn: (message) => logger.warn(message),
            });
          }
          const publisher = new OverlayServer(
            join(distRoot, "presentation/overlay"),
            { port: validPort ? port : 7777 },
          );
          const obsClient = new OBSWebSocket();
          const exportDuration = observeExportDuration(obsClient);
          const marker = new ObsWebsocketMarker({
            client: exportDuration.client,
            ...(obsUrl ? { url: obsUrl } : {}),
            ...(password ? { password } : {}),
          });
          const recorder = new PerSessionRecorder(
            join(projectRoot, "recordings"),
            () => ({
              appVersion: packageJson.version,
              metricConfig:
                selection.metricConfig === "a"
                  ? "(a) Pulse rate, pulse waveform, talking"
                  : "(b) Config (a) + chest breathing, breathing rate",
              startTimeUs: clock.now(),
            }),
          );
          stream = new StreamSession(
            {
              source,
              publisher,
              marker: {
                captureRecording: () => marker.captureRecording(),
                async createChapter(label, signal, token) {
                  const revision = exportRevision;
                  const recording = exportDuration.recordingGeneration;
                  const result = await marker.createChapter(
                    label,
                    signal,
                    token,
                  );
                  if (
                    !disposed &&
                    revision === exportRevision &&
                    result.status === "created"
                  )
                    exportDuration.marked(result.recordingOffsetMs, recording);
                  return result;
                },
              },
              recorder,
              clock,
              logger,
              highlights: new FsHighlightRepository(app.getPath("userData")),
            },
            { replay: options.replay },
          );
          function scheduleValidationCheck(): void {
            const deadline = stream.validationDeadlineUs;
            if (deadline === scheduledValidationDeadline) return;
            scheduledValidationDeadline = deadline;
            clearTimeout(validationTimer);
            if (deadline === null) return;
            validationTimer = setTimeout(
              () => {
                scheduledValidationDeadline = null;
                void stream
                  .checkValidationTimeout()
                  .then(scheduleValidationCheck, () => {
                    logger.error("Unable to check the input timeout.");
                  });
              },
              Math.max(0, Math.ceil((deadline - clock.now()) / 1000)),
            );
          }
          let runActive = false;
          let runEndRequested = false;
          function endRun(): void {
            runEndRequested = true;
            exportDuration.endRun();
          }
          const unsubscribePanel = stream.subscribePanel((state) => {
            if (state.active !== runActive) {
              runActive = state.active;
              if (runActive)
                exportDuration.startRun({ alreadyEnded: runEndRequested });
              else exportDuration.endRun();
            }
            scheduleValidationCheck();
            onActivityChanged(state.active);
            sendPanel();
          });
          const unsubscribeObs = marker.subscribeStatus((status) => {
            runtime = { ...runtime, obsMessage: status.message };
            sendPanel();
          });
          const commands = createPanelCommands({
            stream,
            async recordingDurationMs() {
              const revision = exportRevision;
              // A pending origin check can hold acknowledged chapter offsets.
              // Let the observer offer the plain list while verification retries.
              if (!exportDuration.verifyingFileOrigin)
                await stream.settleChapters();
              if (revision !== exportRevision)
                return { ok: false, reason: "timelineReplaced" };
              const duration = await exportDuration.durationMs(
                stream.currentHighlights,
              );
              return revision === exportRevision
                ? duration
                : { ok: false, reason: "timelineReplaced" };
            },
            session: () => ({
              startedAt: stream.sessionStartedAt,
              highlights: stream.currentHighlights,
              durationMs: stream.sessionDurationMs,
            }),
            userData: app.getPath("userData"),
            overlayUrl: runtime.overlayUrl,
            writeClipboard: (text) => clipboard.writeText(text),
            saveDialog: (defaultPath) =>
              dialog.showSaveDialog(window, {
                title: "Save session timestamps",
                defaultPath,
                filters: [{ name: "Text", extensions: ["txt"] }],
              }),
            writer: new ChapterTextWriter(app.getPath("userData")),
          });
          const unregisterShortcuts = registerSessionShortcuts({
            registry: globalShortcut,
            lifecycle: app,
            state: () => stream.panelState,
            setPaused: (paused) => stream.setPaused(paused),
            setPrivacyMode: (mode) => {
              selection = { ...selection, privacyMode: mode };
              return stream.setPrivacyMode(mode);
            },
            report: (shortcutMessage) => {
              runtime = { ...runtime, shortcutMessage };
              sendPanel();
            },
          });
          window.webContents.on("did-finish-load", sendPanel);
          if (validPort)
            void publisher.start().catch((error: unknown) => {
              runtime = {
                ...runtime,
                overlayError:
                  error instanceof OverlayServerStartError
                    ? error.message
                    : "Unable to start the overlay server.",
              };
              sendPanel();
            });
          void marker
            .start()
            .catch(() =>
              logger.warn(
                "OBS is unavailable; local highlights remain enabled.",
              ),
            );

          function start(
            request: MeasurementOptions,
            user = true,
          ): Promise<void> {
            if (disposed || stream.panelState.active) return Promise.resolve();
            if (starting) return starting;
            if (replayError && options.replay)
              return Promise.reject(new Error(replayError));
            if (user) userGeneration++;
            selection = request;
            runEndRequested = false;
            exportRevision++;
            runtime = { ...runtime, replayMessage: "" };
            starting = stream
              .startSession({
                consentRecorded: options.replay || hasRecordedConsent(),
                privacyMode: request.privacyMode ?? "vibe",
                recordingEnabled:
                  !options.replay &&
                  shouldRecordSession(options.record, request.recordSession),
              })
              .finally(() => {
                starting = null;
              });
            return starting;
          }
          return {
            ...commands,
            get captureGeneration() {
              return stream.captureGeneration;
            },
            deleteAllData() {
              endRun();
              exportRevision++;
              return commands.deleteAllData();
            },
            setPaused: (paused) => stream.setPaused(paused),
            start,
            stop() {
              endRun();
              userGeneration++;
              return stream.stopSession();
            },
            setPrivacyMode(mode, shutdown) {
              if (mode === "off") {
                endRun();
                userGeneration++;
                // Live capture signals End after the recorder has received the final SDK frames.
                if (!options.replay) return stream.withdrawSharing(shutdown);
              }
              selection = { ...selection, privacyMode: mode };
              return stream.setPrivacyMode(mode);
            },
            async dispose() {
              unregisterShortcuts();
              exportDuration.dispose();
              disposed = true;
              userGeneration++;
              await stream.stopSession();
              unsubscribePanel();
              unsubscribeObs();
              window.webContents.removeListener("did-finish-load", sendPanel);
              await Promise.all([publisher.stop(), marker.stop()]);
            },
          };
        },
      });
    },
  };
}
