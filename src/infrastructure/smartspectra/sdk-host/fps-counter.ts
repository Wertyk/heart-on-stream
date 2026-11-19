export interface FpsWindow {
  readonly startedAtMs: number;
  readonly frames: number;
}

/** Count only accepted frames; time is supplied by the renderer's monotonic clock. */
export function countFrame(window: FpsWindow, sent: boolean): FpsWindow {
  return { ...window, frames: window.frames + (sent ? 1 : 0) };
}

/** Use elapsed time so background timer delays do not inflate the displayed FPS. */
export function sampleFps(
  window: FpsWindow,
  nowMs: number,
): { fps: number; next: FpsWindow } {
  const elapsed = nowMs - window.startedAtMs;
  return {
    fps: elapsed > 0 ? (window.frames * 1000) / elapsed : 0,
    next: { startedAtMs: nowMs, frames: 0 },
  };
}
