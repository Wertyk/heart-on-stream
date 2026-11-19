interface InstanceLifecycle {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

interface InstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/** Gate startup before adapters or userData access, and raise the existing window on relaunch. */
export function claimSingleInstance(
  app: InstanceLifecycle,
  currentWindow: () => InstanceWindow | undefined,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  return true;
}
