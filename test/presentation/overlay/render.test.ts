import { describe, expect, it } from "vitest";
import type {
  NumbersOverlayState,
  OverlayState,
  OverlayWave,
  VibeOverlayState,
} from "../../../src/domain/privacy/index";
import {
  indicatorLayout,
  renderOverlay,
  replayBadgeTextPosition,
} from "../../../src/presentation/overlay/render";
import {
  advanceScene,
  disconnectScene,
  emptyScene,
  receiveSnapshot,
} from "../../../src/presentation/overlay/scene";
import { overlayView } from "../../../src/presentation/overlay/view";

type PathCommand = readonly [string, ...number[]];

function recordingCanvas() {
  let path: PathCommand[] = [];
  const clears: number[][] = [];
  const fills: Array<{ path: PathCommand[]; ink: unknown }> = [];
  const strokes: Array<{
    path: PathCommand[];
    ink: unknown;
    width: number;
    alpha: number;
  }> = [];
  const labels: Array<{ text: string; font: string; ink: unknown }> = [];
  const gradient = () => {
    const stops: Array<[number, string]> = [];
    return {
      stops,
      addColorStop(offset: number, color: string) {
        stops.push([offset, color]);
      },
    };
  };
  const noop = () => {};
  const savedStyles: Array<{
    font: string;
    fillStyle: unknown;
    strokeStyle: unknown;
    lineWidth: number;
    globalAlpha: number;
  }> = [];
  const context = {
    font: "",
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    globalAlpha: 1,
    shadowBlur: 0,
    save() {
      const { font, fillStyle, strokeStyle, lineWidth, globalAlpha } = this;
      savedStyles.push({
        font,
        fillStyle,
        strokeStyle,
        lineWidth,
        globalAlpha,
      });
    },
    restore() {
      Object.assign(this, savedStyles.pop());
    },
    translate: noop,
    scale: noop,
    clip: noop,
    closePath: noop,
    strokeText: noop,
    clearRect: (...bounds: number[]) => clears.push(bounds),
    beginPath: () => {
      path = [];
    },
    moveTo: (...args: number[]) => path.push(["move", ...args]),
    lineTo: (...args: number[]) => path.push(["line", ...args]),
    arc: (...args: number[]) => path.push(["arc", ...args]),
    bezierCurveTo: (...args: number[]) => path.push(["curve", ...args]),
    roundRect: (...args: number[]) => path.push(["roundRect", ...args]),
    fill() {
      fills.push({ path: [...path], ink: this.fillStyle });
    },
    stroke() {
      strokes.push({
        path: [...path],
        ink: this.strokeStyle,
        width: this.lineWidth,
        alpha: this.globalAlpha,
      });
    },
    fillText(text: string) {
      labels.push({ text, font: this.font, ink: this.fillStyle });
    },
    measureText: (text: string) => ({
      width: text.length * 8,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 0,
    }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  };
  return {
    context: context as unknown as CanvasRenderingContext2D,
    clears,
    fills,
    strokes,
    labels,
  };
}

const beatWave: OverlayWave = [
  ...Array.from({ length: 25 }, (_, index) => ({
    atMs: index * 100,
    v: [10, 16, 20, 24].includes(index) ? 1 : 0.2,
  })),
  { atMs: 2_450, v: 0.2 },
];
const vibe: VibeOverlayState = {
  mode: "vibe",
  replay: false,
  status: "live",
  intensity: "calm",
  beatWave,
  breathWave: beatWave,
};
const numbers: NumbersOverlayState = {
  ...vibe,
  mode: "numbers",
  pulseBpm: 72.4,
  breathingRate: 13.7,
  replay: true,
};

function overlay(state: OverlayState = vibe) {
  let scene = receiveSnapshot(emptyScene(), state, 0);
  return {
    disconnect() {
      scene = disconnectScene(scene);
    },
    receive(next: OverlayState, nowMs: number) {
      scene = receiveSnapshot(scene, next, nowMs);
    },
    draw(nowMs: number, theme: "neon" | "minimal" = "neon") {
      const canvas = recordingCanvas();
      const frame = advanceScene(scene, nowMs);
      scene = frame.scene;
      renderOverlay(
        canvas.context,
        1_920,
        1_080,
        theme,
        overlayView(scene.state),
        frame.animation,
      );
      const rings = canvas.strokes.filter(({ path }) =>
        path.some(
          ([kind, , , radius, start, end]) =>
            kind === "arc" &&
            (radius ?? 0) > 50 &&
            end === Math.PI * 2 + (start ?? 0),
        ),
      );
      const waves = canvas.strokes.filter(({ path }) =>
        path.some(([kind]) => kind === "line"),
      );
      return { ...canvas, rings, waves };
    },
  };
}

describe("REPLAY badge text layout", () => {
  it.each([
    { width: 43.5, ascent: 9, descent: 0, x: 35.25, baselineY: 16.5 },
    { width: 60, ascent: 12, descent: 4, x: 27, baselineY: 16 },
  ])(
    "centers text with measured width $width and descent $descent",
    ({ width, ascent, descent, x, baselineY }) => {
      expect(
        replayBadgeTextPosition({
          width,
          actualBoundingBoxAscent: ascent,
          actualBoundingBoxDescent: descent,
        }),
      ).toEqual({ x, baselineY });
    },
  );
});

describe("OBS overlay drawing", () => {
  it("spawns rings on real peaks, expands them and caps them at three", () => {
    const source = overlay();
    expect(source.draw(49).rings).toHaveLength(0);
    const first = source.draw(50).rings;
    expect(first).toHaveLength(1);
    expect(first[0]?.path[0]?.[3]).toBeCloseTo(88 * 0.7);
    const expanding = source.draw(400).rings[0];
    expect(expanding?.path[0]?.[3]).toBeGreaterThan(88 * 0.7);
    expect(expanding?.alpha).toBeLessThan(first[0]?.alpha ?? 0);
    expect(source.draw(650).rings).toHaveLength(2);
    expect(source.draw(1_050).rings).toHaveLength(3);
    const capped = source.draw(1_450).rings;
    expect(capped).toHaveLength(3);
    expect(capped[0]?.path[0]?.[3]).toBeCloseTo(
      88 * (0.7 + (800 / 1_200) * 1.25),
    );
    expect(capped[2]?.path[0]?.[3]).toBeCloseTo(88 * 0.7);
    expect(source.draw(3_500).rings).toHaveLength(0);
  });

  it.each([
    { beatWave: [] },
    { beatWave: beatWave.map((point) => ({ ...point, v: 0.5 })) },
  ])("draws no rings without a peak", ({ beatWave }) => {
    const source = overlay({ ...vibe, beatWave });
    for (const now of [0, 50, 650, 1_450, 2_500])
      expect(source.draw(now).rings).toHaveLength(0);
  });

  it("brightens a beat ring once on entry into spike", () => {
    const source = overlay();
    const width = source.draw(50).rings[0]?.width;
    const spike = { ...vibe, intensity: "spike" } as const;
    source.receive(spike, 600);
    const flare = source.draw(600);
    expect(flare.rings).toHaveLength(1);
    expect(flare.rings[0]?.width).toBeGreaterThan(width ?? 0);
    expect(flare.labels.map(({ text }) => text)).toEqual(["SPIKE"]);
    expect(source.draw(650).rings[1]?.width).toBe(width);
    source.receive(spike, 1_025);
    expect(source.draw(1_025).rings.map(({ width }) => width)).toEqual([
      width,
      width,
    ]);
    source.receive(vibe, 1_040);
    source.receive(spike, 1_050);
    expect(source.draw(1_050).rings[2]?.width).toBeGreaterThan(width ?? 0);

    const silent = overlay({ ...vibe, beatWave: [] });
    silent.receive({ ...spike, beatWave: [] }, 100);
    expect(silent.draw(100).rings).toHaveLength(0);
  });

  it.each([vibe, numbers])(
    "clears the $mode canvas on disconnect during a spike until a fresh snapshot",
    (state) => {
      const source = overlay(state);
      source.receive({ ...state, intensity: "spike" }, 50);
      expect(source.draw(50).labels.map(({ text }) => text)).toContain("SPIKE");

      source.disconnect();
      for (const nowMs of [51, 60_050]) {
        const frame = source.draw(nowMs);
        expect(frame.clears).toEqual([[0, 0, 1_920, 1_080]]);
        expect(frame.fills).toEqual([]);
        expect(frame.strokes).toEqual([]);
        expect(frame.labels).toEqual([]);
      }

      source.receive({ ...state, beatWave: [], breathWave: [] }, 60_100);
      const fresh = source.draw(60_100);
      expect(fresh.labels.map(({ text }) => text)).toContain("CALM");
      expect(fresh.rings).toEqual([]);
      expect(fresh.waves).toEqual([]);
    },
  );

  it("draws a muted heart and rotating calibration arc without numbers", () => {
    const source = overlay({ ...numbers, status: "calibrating" });
    const first = source.draw(50);
    const later = source.draw(400);
    expect(first.labels.map(({ text }) => text)).toEqual([
      "CALIBRATING",
      "Learning your baseline",
      "REPLAY",
    ]);
    expect(first.fills).toContainEqual(
      expect.objectContaining({ ink: "#5f7a72" }),
    );
    const arc = (frame: typeof first) =>
      frame.strokes.find(
        ({ ink, path }) =>
          ink === "#bfe8d6" && path.some(([kind]) => kind === "arc"),
      )?.path[0];
    expect(arc(first)?.[4]).toEqual(expect.any(Number));
    expect(arc(later)?.[4]).not.toBe(arc(first)?.[4]);
  });

  it("draws a dim paused heart and clears the trace, ribbon and rings", () => {
    const source = overlay();
    expect(source.draw(50).rings).toHaveLength(1);
    source.receive({ ...vibe, status: "paused" }, 100);
    const frame = source.draw(100);
    expect(frame.labels).toEqual([
      expect.objectContaining({ text: "PAUSED", ink: "#c9d8d2" }),
    ]);
    expect(frame.fills).toContainEqual(
      expect.objectContaining({ ink: "#3d4c48" }),
    );
    expect(frame.rings).toEqual([]);
    expect(frame.waves).toEqual([]);
  });

  it("draws the numbers, cyan breathing label, caption and gold replay pill", () => {
    const frame = overlay(numbers).draw(100);
    expect(frame.labels.map(({ text }) => text)).toEqual([
      "CALM",
      "72",
      "BPM",
      "14 breaths/min",
      "CAMERA ESTIMATE · NOT MEDICAL",
      "REPLAY",
    ]);
    expect(frame.labels.find(({ text }) => text === "72")?.font).toMatch(
      /96px system-ui/,
    );
    expect(
      frame.labels.find(({ text }) => text === "14 breaths/min")?.ink,
    ).toBe("#6ce4ef");
    expect(frame.labels.find(({ text }) => text === "REPLAY")?.ink).toBe(
      "#f4dc94",
    );
    expect(frame.fills).toContainEqual(
      expect.objectContaining({ ink: "rgba(43,38,20,0.85)" }),
    );
    expect(
      overlay({ ...numbers, pulseBpm: "out_of_range" })
        .draw(100)
        .labels.map(({ text }) => text),
    ).toContain("out of range");
    expect(frame.waves).toHaveLength(2);
  });

  it("scrolls the Vibe trace from actual samples and fades both edges", () => {
    const source = overlay();
    const first = source.draw(50);
    const trace = first.waves[0];
    expect(first.labels.map(({ text }) => text)).toEqual(["CALM"]);
    expect(first.waves).toHaveLength(3);
    expect(trace?.ink).toMatchObject({
      stops: expect.arrayContaining([
        [0, "transparent"],
        [1, "transparent"],
      ]),
    });
    expect(trace?.path).toHaveLength(11);
    expect(source.draw(75).waves[0]?.path[0]?.[1]).toBeLessThan(
      trace?.path[0]?.[1] ?? 0,
    );
    expect(overlay({ ...vibe, beatWave: [] }).draw(50).waves).toHaveLength(2);
  });

  it("breaks the pulse trace across an uncovered gap and leaves its tail empty", () => {
    const source = overlay({
      ...vibe,
      breathWave: [],
      beatWave: [
        { atMs: 0, v: 0.2 },
        { atMs: 100, v: 1 },
        { atMs: 700, v: 0.2 },
        { atMs: 800, v: 0.6 },
      ],
    });
    const frame = source.draw(1_600);
    expect(frame.rings).toHaveLength(0);
    expect(frame.waves[0]?.path.map(([kind]) => kind)).toEqual([
      "move",
      "line",
      "move",
      "line",
    ]);
    expect(frame.waves[0]?.path.at(-1)?.[1]).toBeLessThan(600);
  });

  it("keeps card geometry and the subdued palette in minimal", () => {
    const neon = overlay().draw(50);
    const minimal = overlay().draw(50, "minimal");
    expect(neon.fills[0]).toEqual({
      path: [["roundRect", 0, 0, 640, 272, 40]],
      ink: "rgba(8,13,14,0.66)",
    });
    expect(minimal.fills[0]?.path).toEqual(neon.fills[0]?.path);
    expect(minimal.labels[0]?.ink).toBe("#f3edf5");
  });

  it("anchors at the bottom left and scales both dimensions to fit the viewport", () => {
    expect(indicatorLayout(1_920, 1_080)).toEqual({ x: 24, y: 784, scale: 1 });
    expect(indicatorLayout(344, 180)).toEqual({ x: 12, y: 32, scale: 0.5 });
    expect(indicatorLayout(344, 80)).toEqual({ x: 6, y: 6, scale: 0.25 });
  });

  it.each(["off", "highlightsOnly"] as const)(
    "clears the whole canvas in %s, including replay",
    (mode) => {
      const source = overlay(numbers);
      source.draw(50);
      source.receive({ mode, replay: true }, 100);
      const frame = source.draw(100);
      expect(frame.clears).toEqual([[0, 0, 1_920, 1_080]]);
      expect(frame.fills).toEqual([]);
      expect(frame.strokes).toEqual([]);
      expect(frame.labels).toEqual([]);
    },
  );
});
