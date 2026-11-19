import type { OverlayWave } from "../../domain/privacy/index";
import type { OverlayTheme } from "./options";
import type { OverlayView } from "./view";

const palettes = {
  neon: {
    calm: "#ff67c5",
    elevated: "#ffae68",
    spike: "#ff526e",
    ribbon: "#6ce4ef",
    text: "#fff5fc",
    edge: "#ffe1f4",
    glow: 20,
  },
  minimal: {
    calm: "#f3edf5",
    elevated: "#f3cc87",
    spike: "#ee8e9d",
    ribbon: "#d3e9e7",
    text: "#ffffff",
    edge: "#ffffff",
    glow: 3,
  },
} as const;

const replayBadge = { x: 18, y: 0, width: 78, height: 24 };

/** Center the measured text in the pill using an alphabetic baseline. */
export function replayBadgeTextPosition(
  metrics: Pick<
    TextMetrics,
    "width" | "actualBoundingBoxAscent" | "actualBoundingBoxDescent"
  >,
): { x: number; baselineY: number } {
  return {
    x: replayBadge.x + (replayBadge.width - metrics.width) / 2,
    baselineY:
      replayBadge.y +
      (replayBadge.height +
        metrics.actualBoundingBoxAscent -
        metrics.actualBoundingBoxDescent) /
        2,
  };
}

function heartPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(0, 39);
  ctx.bezierCurveTo(-11, 27, -47, 4, -47, -19);
  ctx.bezierCurveTo(-47, -49, -10, -53, 0, -28);
  ctx.bezierCurveTo(10, -53, 47, -49, 47, -19);
  ctx.bezierCurveTo(47, 4, 11, 27, 0, 39);
  ctx.closePath();
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  paintLabel(ctx, text, x, y, color);
}

function paintLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(13, 10, 24, 0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawReplayBadge(ctx: CanvasRenderingContext2D, color: string): void {
  const { x, y, width, height } = replayBadge;
  ctx.fillStyle = "rgba(13, 10, 24, 0.85)";
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 6);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  const text = "REPLAY";
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const position = replayBadgeTextPosition(ctx.measureText(text));
  paintLabel(ctx, text, position.x, position.baselineY, color);
}

/** All output stays on the transparent canvas; hidden modes clear it completely. */
export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: OverlayTheme,
  view: OverlayView,
  beat: number,
  breath: {
    readonly points: OverlayWave;
    readonly cursorAtMs: number | null;
    readonly opacity: number;
  },
): void {
  ctx.clearRect(0, 0, width, height);
  if (!view.visible) return;
  const palette = palettes[theme];
  const color = palette[view.intensity];
  const scale = Math.max(0.1, Math.min(1, width / 520, height / 230));
  ctx.save();
  ctx.translate(24 * scale, height - 206 * scale);
  ctx.scale(scale, scale);
  ctx.save();
  ctx.translate(66, 84);
  const heartScale = view.paused ? 1 : 1 + beat * 0.22;
  ctx.scale(heartScale, heartScale);
  ctx.globalAlpha = view.paused ? 0.35 : 1;
  ctx.shadowColor = color;
  ctx.shadowBlur = palette.glow + (view.paused ? 0 : beat * 12);
  const fill = ctx.createLinearGradient(0, -48, 0, 42);
  fill.addColorStop(0, palette.edge);
  fill.addColorStop(0.3, color);
  fill.addColorStop(1, color);
  ctx.fillStyle = fill;
  ctx.strokeStyle = "rgba(20, 12, 30, 0.75)";
  ctx.lineWidth = 2;
  heartPath(ctx);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  if (view.pulseLabel) label(ctx, view.pulseLabel, 145, 78, 28, palette.text);
  if (view.breathingLabel)
    label(ctx, view.breathingLabel, 146, 105, 16, palette.ribbon);
  if (view.statusLabel)
    label(
      ctx,
      view.statusLabel,
      146,
      view.readingsCaption ? 147 : 133,
      view.paused ? 20 : 14,
      palette.text,
    );
  if (view.readingsCaption)
    label(ctx, view.readingsCaption, 146, 126, 12, palette.text);
  if (view.replay) drawReplayBadge(ctx, palette.ribbon);

  if (
    !view.paused &&
    breath.opacity > 0 &&
    breath.points.length > 1 &&
    breath.cursorAtMs !== null
  ) {
    ctx.save();
    ctx.globalAlpha = breath.opacity;
    ctx.beginPath();
    let first = true;
    for (const point of breath.points) {
      const x = 22 + 432 * (1 - (breath.cursorAtMs - point.atMs) / 6_000);
      const y = 171 - (point.v - 0.5) * 42;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(13, 10, 24, 0.65)";
    ctx.lineWidth = 7;
    ctx.stroke();
    const ink = ctx.createLinearGradient(22, 0, 454, 0);
    ink.addColorStop(0, "transparent");
    ink.addColorStop(0.4, palette.ribbon);
    ink.addColorStop(1, palette.ribbon);
    ctx.strokeStyle = ink;
    ctx.shadowColor = palette.ribbon;
    ctx.shadowBlur = palette.glow / 2;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
