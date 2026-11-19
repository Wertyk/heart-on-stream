import { basename } from "node:path";
import {
  hasDifferentLaunchOptions,
  isLaunchOptions,
  type LaunchOptions,
} from "./launch-options";

interface InstanceLifecycle {
  requestSingleInstanceLock(additionalData: LaunchOptions): boolean;
  quit(): void;
  on(
    event: "second-instance",
    listener: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void,
  ): unknown;
}

interface InstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/** Gate startup before adapters or userData access, and raise the existing window on relaunch. */
export function claimSingleInstance<Window extends InstanceWindow>(
  app: InstanceLifecycle,
  currentWindow: () => Window | undefined,
  options: LaunchOptions,
  showRelaunchMessage: (window: Window, message: string) => void,
): boolean {
  if (!app.requestSingleInstanceLock(options)) {
    if (options.error) console.error(options.error);
    app.quit();
    return false;
  }
  app.on(
    "second-instance",
    (_event, _argv, workingDirectory, additionalData) => {
      const window = currentWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.focus();
      if (!isLaunchOptions(additionalData)) return;
      const { error } = additionalData;
      if (
        !error &&
        !hasDifferentLaunchOptions(options, additionalData, workingDirectory)
      )
        return;

      const replayFile =
        options.replay && options.file ? basename(options.file) : "";
      const running = replayFile
        ? `Heart on Stream is running a replay of ${replayFile}.`
        : `Heart on Stream is running in ${options.replay ? "replay" : "live"} mode.`;
      const message = error
        ? `The new command has invalid arguments.\n${error}\n\n${running}`
        : `${running}\n\nClose this window, then run the command again.`;
      showRelaunchMessage(window, message);
    },
  );
  return true;
}
