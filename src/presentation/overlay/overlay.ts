import { connectOverlay } from "./connection";
import { parseOverlayOptions } from "./options";
import { renderOverlay } from "./render";
import { disconnectScene, emptyScene, receiveSnapshot } from "./scene";
import { overlayView } from "./view";
import { playWave, waveTrail } from "./wave-buffer";

const canvas = document.querySelector<HTMLCanvasElement>("#overlay");
if (!canvas) throw new Error("Overlay canvas is missing.");
const context = canvas.getContext("2d");
if (!context) throw new Error("Canvas rendering is unavailable.");
const { port, theme } = parseOverlayOptions(
  window.location.search,
  window.location,
);

// CSSOM property writes work with the server's restrictive style-src policy.
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
canvas.style.position = "fixed";
canvas.style.inset = "0";
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.display = "block";

let width = 0;
let height = 0;
function resize(): void {
  if (!canvas || !context) return;
  width = window.innerWidth;
  height = window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}
window.addEventListener("resize", resize);
resize();

let scene = emptyScene();
let stopped = false;
const disconnect = connectOverlay(
  port,
  (state, firstSnapshot) => {
    scene = receiveSnapshot(
      firstSnapshot ? emptyScene() : scene,
      state,
      performance.now(),
    );
  },
  () => {
    scene = disconnectScene(scene);
  },
);

let frame = 0;
function draw(nowMs: number): void {
  if (stopped || !context) return;
  const beat = playWave(scene.beat, nowMs);
  const breath = playWave(scene.breath, nowMs);
  scene = { ...scene, beat: beat.buffer, breath: breath.buffer };
  renderOverlay(
    context,
    width,
    height,
    theme,
    overlayView(scene.state),
    beat.value,
    {
      points: waveTrail(breath.buffer),
      cursorAtMs: breath.buffer.cursorAtMs,
      opacity: breath.opacity,
    },
  );
  frame = requestAnimationFrame(draw);
}
frame = requestAnimationFrame(draw);

window.addEventListener("pagehide", () => {
  stopped = true;
  disconnect();
  cancelAnimationFrame(frame);
  window.removeEventListener("resize", resize);
});
