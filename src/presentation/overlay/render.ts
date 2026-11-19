import type { OverlayTheme } from "./options";
import type { AnimatedWave, OverlayAnimation } from "./scene";
import type { OverlayView } from "./view";
import { maxBeatGapMs } from "./wave-buffer";

const palettes = {
  neon: {
    calm: "#ff67c5",
    elevated: "#ffae68",
    spike: "#ff526e",
    ribbon: "#6ce4ef",
    text: "#fff5fc",
    edge: "#ffe1f4",
    glow: 20,
    halo: 0.28,
  },
  minimal: {
    calm: "#f3edf5",
    elevated: "#f3cc87",
    spike: "#ee8e9d",
    ribbon: "#d3e9e7",
    text: "#ffffff",
    edge: "#ffffff",
    glow: 3,
    halo: 0.08,
  },
} as const;

const card = { width: 640, height: 272, radius: 40, inset: 24 };
const halo = { x: 114, y: card.height / 2, radius: 88 };
const info = { x: 220, width: 380 };
const traceBand = { centerY: 128, height: 106 };
const ribbonBand = { centerY: 226, height: 40 };
const mint = "#bfe8d6";
const pausedInk = "#c9d8d2";
const circle = 2 * Math.PI;

const replayBadge = { x: 18, y: 0, width: 78, height: 24 };
const cardBadge = {
  ...replayBadge,
  x: info.x + info.width - replayBadge.width,
  y: 26,
};

/** Keep both viewport margins as the entire card scales down. */
export function indicatorLayout(
  width: number,
  height: number,
): { x: number; y: number; scale: number } {
  const scale = Math.min(
    1,
    width / (card.width + 2 * card.inset),
    height / (card.height + 2 * card.inset),
  );
  return {
    x: card.inset * scale,
    y: height - (card.height + card.inset) * scale,
    scale,
  };
}

/** Center the measured text in the pill using an alphabetic baseline. */
export function replayBadgeTextPosition(
  metrics: Pick<
    TextMetrics,
    "width" | "actualBoundingBoxAscent" | "actualBoundingBoxDescent"
  >,
  bounds = replayBadge,
): { x: number; baselineY: number } {
  return {
    x: bounds.x + (bounds.width - metrics.width) / 2,
    baselineY:
      bounds.y +
      (bounds.height +
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

function drawCard(
  ctx: CanvasRenderingContext2D,
  color: string,
  scale: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, card.width, card.height, card.radius);
  ctx.fillStyle = "rgba(8,13,14,0.66)";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 25 * scale;
  ctx.shadowOffsetY = 8 * scale;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawLiveHalo(
  ctx: CanvasRenderingContext2D,
  color: string,
  glow: number,
  haloOpacity: number,
  animation: OverlayAnimation,
): void {
  ctx.save();
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, halo.radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "transparent");
  ctx.globalAlpha = haloOpacity;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, halo.radius, 0, circle);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  const progress = animation.ringProgress;
  for (let i = 0; i < progress.length; i += 1) {
    const age = progress[i];
    if (age === undefined) continue;
    // A spike strengthens one beat ring within the same three-ring budget.
    const flare = i === animation.flareRingIndex ? animation.flare : 0;
    ctx.globalAlpha = 0.47 * (1 - age) ** 2 + 0.5 * flare * (1 - 0.5 * age);
    ctx.shadowBlur = glow * (0.4 + flare);
    ctx.lineWidth = 2 + 3 * flare;
    ctx.beginPath();
    ctx.arc(0, 0, halo.radius * (0.7 + age * 1.25), 0, circle);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeart(
  ctx: CanvasRenderingContext2D,
  view: OverlayView,
  animation: OverlayAnimation,
  palette: (typeof palettes)[OverlayTheme],
  color: string,
  glow: number,
): void {
  ctx.save();
  ctx.translate(halo.x, halo.y);
  if (view.statusLabel === "calibrating") {
    ctx.beginPath();
    ctx.arc(
      0,
      0,
      69,
      animation.calibrationAngle,
      animation.calibrationAngle + circle * 0.73,
    );
    ctx.strokeStyle = mint;
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (view.content) {
    drawLiveHalo(ctx, color, glow, palette.halo, animation);
    const heartScale = 1 + animation.beat * 0.22;
    ctx.scale(heartScale, heartScale);
    ctx.shadowColor = color;
    ctx.shadowBlur = glow * (1 + 0.6 * animation.beat);
    const fill = ctx.createLinearGradient(0, -48, 0, 42);
    fill.addColorStop(0, palette.edge);
    fill.addColorStop(0.3, color);
    fill.addColorStop(1, color);
    ctx.fillStyle = fill;
  } else {
    ctx.fillStyle = view.paused ? "#3d4c48" : "#5f7a72";
  }
  heartPath(ctx);
  ctx.fill();
  ctx.restore();
}

function drawStatus(
  ctx: CanvasRenderingContext2D,
  view: OverlayView,
  color: string,
  dotOpacity: number,
  glow: number,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = "700 18px system-ui, sans-serif";
  ctx.letterSpacing = "3px";
  if (view.statusLabel) {
    ctx.fillText(view.statusLabel.toUpperCase(), info.x, halo.y + 6);
    if (view.statusDetail) {
      ctx.font = "500 17px system-ui, sans-serif";
      ctx.letterSpacing = "0px";
      ctx.fillStyle = "#a3b5af";
      ctx.fillText(view.statusDetail, info.x, halo.y + 34);
    }
  } else {
    ctx.save();
    ctx.globalAlpha = dotOpacity;
    ctx.shadowColor = color;
    ctx.shadowBlur = glow * 0.6;
    ctx.beginPath();
    ctx.arc(info.x + 5, 42, 5, 0, circle);
    ctx.fill();
    ctx.restore();
    ctx.fillText(view.intensity.toUpperCase(), info.x + 24, 48);
  }
  ctx.restore();
}

function drawReadings(
  ctx: CanvasRenderingContext2D,
  view: OverlayView,
  palette: (typeof palettes)[OverlayTheme],
): void {
  ctx.fillStyle = palette.text;
  if (view.pulseFigure) {
    ctx.font = "800 96px system-ui, sans-serif";
    ctx.fillText(view.pulseFigure, info.x, 148);
    const figureWidth = ctx.measureText(view.pulseFigure).width;
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.fillText("BPM", info.x + figureWidth + 12, 146);
  } else if (view.pulseLabel) {
    ctx.font = "700 42px system-ui, sans-serif";
    ctx.fillText(view.pulseLabel, info.x, 136);
  }
  if (view.breathingLabel) {
    ctx.fillStyle = palette.ribbon;
    ctx.font = "600 22px system-ui, sans-serif";
    ctx.fillText(view.breathingLabel, info.x, 176);
  }
  if (view.readingsCaption) {
    ctx.fillStyle = palette.text;
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillText(view.readingsCaption.toUpperCase(), info.x, 198);
  }
}

function drawReplayBadge(ctx: CanvasRenderingContext2D): void {
  const { x, y, width, height } = cardBadge;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, height / 2);
  ctx.fillStyle = "rgba(43,38,20,0.85)";
  ctx.fill();
  ctx.strokeStyle = "#e8c873";
  ctx.lineWidth = 1;
  ctx.stroke();

  const text = "REPLAY";
  ctx.font = "700 12px system-ui, sans-serif";
  ctx.fillStyle = "#f4dc94";
  const position = replayBadgeTextPosition(ctx.measureText(text), cardBadge);
  ctx.fillText(text, position.x, position.baselineY);
}

function wavePath(
  ctx: CanvasRenderingContext2D,
  wave: AnimatedWave,
  band: { centerY: number; height: number },
  maxGapMs: number,
): boolean {
  const pxPerMs = info.width / wave.durationMs;
  const right = info.x + info.width;
  let previousAtMs: number | undefined;
  let hasLine = false;

  ctx.beginPath();
  for (let i = wave.fromIndex; i < wave.toIndex; i += 1) {
    const point = wave.points[i];
    if (!point) continue;
    const x = right - (wave.cursorAtMs - point.atMs) * pxPerMs;
    const y = band.centerY - (point.v - 0.5) * band.height;
    if (previousAtMs === undefined || point.atMs - previousAtMs > maxGapMs) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
      hasLine = true;
    }
    previousAtMs = point.atMs;
  }
  return hasLine;
}

function waveInk(
  ctx: CanvasRenderingContext2D,
  color: string,
  fadeRight: boolean,
): CanvasGradient {
  const ink = ctx.createLinearGradient(info.x, 0, info.x + info.width, 0);
  ink.addColorStop(0, "transparent");
  ink.addColorStop(0.16, color);
  if (fadeRight) ink.addColorStop(0.84, color);
  ink.addColorStop(1, fadeRight ? "transparent" : color);
  return ink;
}

function drawTrace(
  ctx: CanvasRenderingContext2D,
  trace: AnimatedWave,
  color: string,
  glow: number,
): void {
  if (!wavePath(ctx, trace, traceBand, maxBeatGapMs)) return;
  ctx.save();
  ctx.globalAlpha = trace.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = waveInk(ctx, color, true);
  ctx.shadowColor = color;
  ctx.shadowBlur = glow * 0.5;
  ctx.stroke();
  ctx.restore();
}

function drawRibbon(
  ctx: CanvasRenderingContext2D,
  ribbon: AnimatedWave,
  color: string,
  glow: number,
): void {
  if (!wavePath(ctx, ribbon, ribbonBand, Infinity)) return;
  ctx.save();
  ctx.globalAlpha = ribbon.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = waveInk(ctx, color, false);
  ctx.shadowColor = color;
  ctx.shadowBlur = glow * 0.6;
  ctx.stroke();
  ctx.globalAlpha = ribbon.opacity * 0.45;
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.strokeStyle = waveInk(ctx, mint, false);
  ctx.stroke();
  ctx.restore();
}

/** All output stays on the transparent canvas; hidden modes clear it completely. */
export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: OverlayTheme,
  view: OverlayView,
  animation: OverlayAnimation,
): void {
  ctx.clearRect(0, 0, width, height);
  if (!view.visible || width <= 0 || height <= 0) return;

  const palette = palettes[theme];
  const color = view.content
    ? palette[view.intensity]
    : view.paused
      ? pausedInk
      : mint;
  const { x, y, scale } = indicatorLayout(width, height);
  const glow = palette.glow * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  drawCard(ctx, color, scale);
  // Keep the widest rings inside the glass and clear of the viewport edges.
  ctx.clip();
  drawHeart(ctx, view, animation, palette, color, glow);
  drawStatus(ctx, view, color, animation.statusDotOpacity, glow);
  if (view.content === "readings") drawReadings(ctx, view, palette);
  if (view.content === "trace" && animation.pulseTrace)
    drawTrace(ctx, animation.pulseTrace, color, glow);
  if (view.content && animation.breathRibbon)
    drawRibbon(ctx, animation.breathRibbon, palette.ribbon, glow);
  if (view.replay) drawReplayBadge(ctx);
  ctx.restore();
}
