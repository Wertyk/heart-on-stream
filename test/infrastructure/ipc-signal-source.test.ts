import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { SignalSource } from "../../src/application/ports/signal-source";
import type { SignalFrame } from "../../src/domain/signal/index";
import { IpcSignalSource } from "../../src/infrastructure/ipc/ipc-signal-source";

const frames: [SignalFrame, SignalFrame, SignalFrame] = [
  { kind: "processing", status: "running", t: 20 },
  { kind: "validation", code: "ok", hint: "Ready", t: 10 },
  { kind: "pulseWave", samples: [{ value: 0.2, stable: true, t: 30 }] },
];

function fixture() {
  const ipc = new EventEmitter();
  const trusted = {};
  const source: SignalSource = new IpcSignalSource(
    ipc,
    (sender) => sender === trusted,
  );
  const emit = (frame: SignalFrame, sender = trusted) =>
    ipc.emit("frame:push", sender, { captureGeneration: 1, frame });
  return { ipc, source, emit };
}

describe("IpcSignalSource", () => {
  it("forwards only trusted frames and retains delivery order and waveform batches", async () => {
    const f = fixture();
    const received = vi.fn();
    f.source.subscribe(received);
    await f.source.start();
    f.emit(frames[0], {});
    for (const frame of frames) f.emit(frame);
    expect(received.mock.calls.map(([frame]) => frame)).toEqual(frames);
    await f.source.stop();
  });

  it("is silent before Start and after Stop, starts once, and retains subscriptions on restart", async () => {
    const f = fixture();
    const received = vi.fn();
    const unsubscribe = f.source.subscribe(received);
    f.emit(frames[0]);
    await f.source.stop();
    await f.source.start();
    await f.source.start();
    expect(f.ipc.listenerCount("frame:push")).toBe(1);
    f.emit(frames[0]);
    await f.source.stop();
    await f.source.stop();
    expect(f.ipc.listenerCount("frame:push")).toBe(0);
    f.emit(frames[1]);
    await f.source.start();
    f.emit(frames[2]);
    unsubscribe();
    unsubscribe();
    f.emit(frames[0]);
    expect(received.mock.calls.map(([frame]) => frame)).toEqual([
      frames[0],
      frames[2],
    ]);
    await f.source.stop();
  });

  it("supports independent subscribers, unsubscribe, and subscriptions added while started", async () => {
    const f = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = f.source.subscribe(first);
    await f.source.start();
    f.source.subscribe(second);
    f.emit(frames[0]);
    unsubscribe();
    f.emit(frames[1]);
    expect(first).toHaveBeenCalledOnce();
    expect(second.mock.calls.map(([frame]) => frame)).toEqual(
      frames.slice(0, 2),
    );
    await f.source.stop();
  });
});

describe("IPC trust-boundary validation", () => {
  it("drops malformed shapes, unknown kinds/codes, extra fields, nonfinite numbers and unsafe timestamps", async () => {
    const ipc = new EventEmitter();
    const warn = vi.fn();
    const source = new IpcSignalSource(ipc, (event) => event === "trusted", {
      nowMs: () => 0,
      warn,
    });
    const received = vi.fn();
    source.subscribe(received);
    await source.start();
    const invalid: unknown[] = [
      null,
      [],
      {},
      "frame",
      { kind: "video", data: [] },
      { kind: "capture", t: 1, state: "paused" },
      { kind: "end", durationUs: 1 },
      { kind: "processing", status: "invalid", t: 1 },
      { kind: "processing", status: "running", t: 1.2 },
      { kind: "processing", status: "running", t: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "validation", code: "unknown", hint: "", t: 1 },
      { kind: "validation", code: "ok", hint: 7, t: 1 },
      { kind: "talking", detected: true, stable: "yes", t: 1 },
      {
        kind: "pulseRate",
        reading: { value: Number.NaN, confidence: 90, stable: true, t: 1 },
      },
      {
        kind: "breathingRate",
        reading: {
          value: 14,
          confidence: Number.POSITIVE_INFINITY,
          stable: true,
          t: 1,
        },
      },
      {
        kind: "pulseRate",
        reading: { value: 70, confidence: 90, stable: true },
      },
      {
        kind: "pulseRate",
        reading: { value: 70, confidence: 90, stable: true, t: "1" },
      },
      {
        kind: "pulseWave",
        samples: [{ value: 1, stable: true, t: Number.NEGATIVE_INFINITY }],
      },
      {
        kind: "breathingWave",
        samples: [{ value: 1, stable: true, t: 1, media: "extra" }],
      },
      { kind: "pulseWave", samples: {} },
      { kind: "processing", status: "running", t: 1, media: "extra" },
    ];
    for (const frame of invalid)
      expect(() =>
        ipc.emit("frame:push", "trusted", { captureGeneration: 1, frame }),
      ).not.toThrow();
    expect(received).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.lastCall?.[0]).toContain("total: 1");
    for (const payload of [
      frames[2],
      { captureGeneration: "1", frame: frames[2] },
      { captureGeneration: 0, frame: frames[2] },
      { captureGeneration: 1.5, frame: frames[2] },
      { captureGeneration: 1, frame: frames[2], media: "extra" },
    ])
      expect(() => ipc.emit("frame:push", "trusted", payload)).not.toThrow();
    expect(received).not.toHaveBeenCalled();
    ipc.emit("frame:push", "trusted", {
      captureGeneration: 2,
      frame: frames[2],
    });
    expect(received).toHaveBeenCalledWith(frames[2], 2);
    expect(received.mock.lastCall?.[0]).not.toBe(frames[2]);
    await source.stop();
  });

  it("counts invalid frames and rate-limits payload-free warnings, without warning for untrusted input", async () => {
    const ipc = new EventEmitter();
    const warn = vi.fn();
    let now = 100;
    const source = new IpcSignalSource(ipc, (event) => event === "trusted", {
      nowMs: () => now,
      warn,
    });
    await source.start();
    ipc.emit("frame:push", "other", { private: "never log" });
    expect(warn).not.toHaveBeenCalled();
    for (let n = 0; n < 100; n++)
      ipc.emit("frame:push", "trusted", { private: "never log" });
    now += 4999;
    ipc.emit("frame:push", "trusted", null);
    expect(warn).toHaveBeenCalledOnce();
    now++;
    ipc.emit("frame:push", "trusted", null);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.lastCall?.[0]).toContain("total: 102");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("never log");
    await source.stop();
  });

  it("isolates subscriber and logger exceptions so delivery never throws into ipcMain", async () => {
    const ipc = new EventEmitter();
    const source = new IpcSignalSource(ipc, () => true, {
      nowMs: () => 0,
      warn: () => {
        throw new Error("logger");
      },
    });
    source.subscribe(() => {
      throw new Error("consumer");
    });
    const second = vi.fn();
    source.subscribe(second);
    await source.start();
    for (const frame of frames)
      expect(() =>
        ipc.emit("frame:push", {}, { captureGeneration: 1, frame }),
      ).not.toThrow();
    expect(second.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(() => ipc.emit("frame:push", {}, null)).not.toThrow();
    await source.stop();
  });
});
