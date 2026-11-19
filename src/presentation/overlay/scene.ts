import type { OverlayState } from "../../domain/privacy/index";
import {
  breathTrailSpan,
  emptyWaveBuffer,
  playWave,
  pulseTraceSpan,
  receiveBeatWave,
  receiveWave,
  visitBeatPeaks,
  type WaveBuffer,
  type WaveSpan,
} from "./wave-buffer";

const maxRings = 3;
const minPeakSpacingMs = 300;
const initialRingDurationMs = 1_600;
const flareDurationMs = 420;

interface BeatRing {
  readonly atMs: number;
  readonly durationMs: number;
}

interface BeatRings {
  readonly checkedThroughMs: number | null;
  readonly lastPeakAtMs: number | null;
  readonly active: readonly BeatRing[];
}

interface SpikeFlare {
  readonly atMs: number;
  readonly ringAtMs: number | null;
}

const emptyRings: BeatRings = {
  checkedThroughMs: null,
  lastPeakAtMs: null,
  active: [],
};

export interface OverlayScene {
  readonly state: OverlayState | null;
  readonly replayRate: number | null;
  readonly beat: WaveBuffer;
  readonly breath: WaveBuffer;
  readonly rings: BeatRings;
  readonly flare: SpikeFlare | null;
}

export interface AnimatedWave extends WaveSpan {
  readonly opacity: number;
}

export interface OverlayAnimation {
  readonly beat: number;
  readonly pulseTrace: AnimatedWave | null;
  readonly breathRibbon: AnimatedWave | null;
  readonly ringProgress: readonly number[];
  readonly flare: number;
  readonly flareRingIndex: number;
  readonly calibrationAngle: number;
  readonly statusDotOpacity: number;
}

const idleAnimation: OverlayAnimation = {
  beat: 0,
  pulseTrace: null,
  breathRibbon: null,
  ringProgress: [],
  flare: 0,
  flareRingIndex: -1,
  calibrationAngle: 0,
  statusDotOpacity: 1,
};

export function emptyScene(): OverlayScene {
  return {
    state: null,
    replayRate: null,
    beat: emptyWaveBuffer(),
    breath: emptyWaveBuffer(),
    rings: emptyRings,
    flare: null,
  };
}

/** Privacy/status changes discard old animation so it cannot reappear on resume. */
export function receiveSnapshot(
  scene: OverlayScene,
  state: OverlayState,
  nowMs: number,
): OverlayScene {
  // End publishes Off. Pausing or hiding the waves keeps the same replay run.
  const replayRate =
    state.replay && state.mode !== "off" ? scene.replayRate : null;
  if (
    state.mode === "off" ||
    state.mode === "highlightsOnly" ||
    state.status === "paused"
  ) {
    return { ...emptyScene(), state, replayRate };
  }
  const previous = scene.state;
  const reset =
    previous?.mode !== state.mode ||
    (previous &&
      "status" in previous &&
      (previous.status === "paused" ||
        (previous.status !== "calibrating" && state.status === "calibrating")));
  const beat = receiveBeatWave(
    reset ? emptyWaveBuffer(replayRate) : scene.beat,
    state.beatWave,
    nowMs,
  );
  const previousLive =
    previous && "status" in previous && previous.status === "live";
  const keepRings =
    !reset &&
    previousLive &&
    beat.cursorAtMs === scene.beat.cursorAtMs &&
    (beat.points.at(-1)?.atMs ?? -1) >= (scene.beat.points.at(-1)?.atMs ?? -1);
  let flare: SpikeFlare | null = null;
  if (state.status === "live" && state.intensity === "spike" && previousLive) {
    if (previous.intensity !== "spike") flare = { atMs: nowMs, ringAtMs: null };
    else if (keepRings) flare = scene.flare;
  }
  return {
    state,
    replayRate,
    beat,
    breath: receiveWave(
      reset ? emptyWaveBuffer(replayRate) : scene.breath,
      state.breathWave,
      nowMs,
    ),
    rings: keepRings ? scene.rings : emptyRings,
    flare,
  };
}

function advanceRings(
  rings: BeatRings,
  beat: WaveBuffer,
  fromMs: number,
  cursorAtMs: number,
): BeatRings {
  const active = rings.active.filter(
    ({ atMs, durationMs }) => cursorAtMs - atMs < durationMs,
  );
  const checkedThroughMs = Math.max(
    fromMs,
    Math.min(cursorAtMs, beat.points.at(-2)?.atMs ?? fromMs),
  );
  let lastPeakAtMs = rings.lastPeakAtMs;
  if (checkedThroughMs > fromMs) {
    visitBeatPeaks(beat.points, fromMs, checkedThroughMs, (atMs) => {
      const interval = lastPeakAtMs === null ? 0 : atMs - lastPeakAtMs;
      // Suppress closely spaced maxima within one beat. Reset duration after a gap.
      if (lastPeakAtMs !== null && interval < minPeakSpacingMs) return;
      lastPeakAtMs = atMs;
      const durationMs =
        interval > 0 && interval <= 1_500
          ? 2 * interval
          : initialRingDurationMs;
      if (cursorAtMs - atMs >= durationMs) return;
      if (active.length === maxRings) active.shift();
      active.push({ atMs, durationMs });
    });
  }
  return { checkedThroughMs, lastPeakAtMs, active };
}

function withOpacity(
  wave: WaveSpan | null,
  opacity: number,
): AnimatedWave | null {
  return wave ? { ...wave, opacity } : null;
}

function advanceFlare(
  flare: SpikeFlare | null,
  activeRings: readonly BeatRing[],
  nowMs: number,
): SpikeFlare | null {
  if (!flare || nowMs - flare.atMs >= flareDurationMs) return null;
  const ring = activeRings.at(-1);
  return flare.ringAtMs === null && ring
    ? { ...flare, ringAtMs: ring.atMs }
    : flare;
}

/** Share the delayed playback cursor between the heart, trace and ring effects. */
export function advanceScene(
  scene: OverlayScene,
  nowMs: number,
): { scene: OverlayScene; animation: OverlayAnimation } {
  const { state } = scene;
  if (!state || !("status" in state) || state.status === "paused")
    return { scene, animation: idleAnimation };

  const replayThroughMs = state.replay
    ? Math.max(
        scene.beat.points.at(-1)?.atMs ?? 0,
        scene.breath.points.at(-1)?.atMs ?? 0,
      )
    : undefined;
  const beat = playWave(scene.beat, nowMs, replayThroughMs);
  const breath = playWave(scene.breath, nowMs, replayThroughMs);
  const next = {
    ...scene,
    beat: beat.buffer,
    breath: breath.buffer,
    replayRate: state.replay
      ? (beat.buffer.replayClock?.rate ??
        breath.buffer.replayClock?.rate ??
        scene.replayRate)
      : null,
  };
  if (state.status === "calibrating")
    return {
      scene: next,
      animation: {
        ...idleAnimation,
        calibrationAngle: ((nowMs % 4_400) / 4_400) * 2 * Math.PI,
      },
    };

  const cursor = beat.buffer.cursorAtMs;
  const previouslyChecked =
    scene.rings.checkedThroughMs ?? scene.beat.cursorAtMs;
  const rings =
    beat.opacity > 0 && cursor !== null && previouslyChecked !== null
      ? advanceRings(scene.rings, beat.buffer, previouslyChecked, cursor)
      : emptyRings;
  const flare = advanceFlare(scene.flare, rings.active, nowMs);
  return {
    scene: { ...next, rings, flare },
    animation: {
      beat: beat.value,
      pulseTrace:
        state.mode === "vibe" && beat.opacity > 0
          ? withOpacity(pulseTraceSpan(beat.buffer), beat.opacity)
          : null,
      breathRibbon:
        breath.opacity > 0
          ? withOpacity(breathTrailSpan(breath.buffer), breath.opacity)
          : null,
      ringProgress:
        cursor === null
          ? idleAnimation.ringProgress
          : rings.active.map(
              ({ atMs, durationMs }) => (cursor - atMs) / durationMs,
            ),
      flare: flare ? 1 - (nowMs - flare.atMs) / flareDurationMs : 0,
      flareRingIndex: flare
        ? rings.active.findIndex(({ atMs }) => atMs === flare.ringAtMs)
        : -1,
      calibrationAngle: 0,
      statusDotOpacity: 0.725 + 0.275 * Math.cos((nowMs * Math.PI) / 650),
    },
  };
}

/** Discard the last snapshot so a reconnect cannot display stale activity. */
export function disconnectScene(scene: OverlayScene): OverlayScene {
  return scene.state === null ? scene : emptyScene();
}
