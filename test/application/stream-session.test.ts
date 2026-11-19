import { describe, expect, it } from "vitest";
import type { StartSessionOptions } from "../../src/application/use-cases/index";
import type { OverlayState } from "../../src/domain/privacy/index";
import {
  at,
  deferred,
  fixture,
  pulse,
  pulses,
  quickPolicy,
  wave,
} from "./fakes";

const start: StartSessionOptions = {
  consentRecorded: true,
  privacyMode: "vibe",
};

describe("StartSession", () => {
  it.each<StartSessionOptions>([
    { consentRecorded: false, privacyMode: "vibe", recordingEnabled: true },
    { consentRecorded: true, recordingEnabled: true },
    { consentRecorded: true, privacyMode: "off", recordingEnabled: true },
  ])(
    "refuses capture and recording without consent and an enabled selection: %j",
    async (options) => {
      const f = fixture();
      await expect(f.session.startSession(options)).rejects.toThrow();
      expect(f.source.starts).toBe(0);
      expect(f.source.listeners.size).toBe(0);
      expect(f.recorder.starts).toBe(0);
      expect(f.publisher.states).toEqual([]);
      expect(f.session.panelState.active).toBe(false);
    },
  );

  it("subscribes before starting and handles synchronous source delivery", async () => {
    const f = fixture({ replay: true });
    f.source.onStart = () => f.source.emit(pulse(0));
    await f.session.startSession(start);
    await f.session.whenIdle();
    expect(f.calls).toEqual(["source.subscribe", "source.start"]);
    expect(f.panels.at(-1)).toMatchObject({
      active: true,
      replay: true,
      privacyMode: "vibe",
      phase: "warming",
      pulse: { value: 70 },
      progress: { elapsedSeconds: 0, requiredSeconds: 12 },
    });
    expect(f.recorder.starts).toBe(0);
    expect(f.recorder.appends).toBe(0);
    expect(f.publisher.states.at(-1)).toMatchObject({ replay: true });
    await expect(f.session.startSession(start)).rejects.toThrow(
      "already running",
    );
    expect(f.source.starts).toBe(1);
  });

  it("records frames only after an explicit per-session opt-in", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, recordingEnabled: true });
    f.source.emit(pulse(0));
    f.source.emit({ kind: "validation", t: at(1), code: "ok", hint: "Ready" });
    await f.session.whenIdle();
    expect(f.calls.indexOf("recorder.start")).toBeLessThan(
      f.calls.indexOf("source.start"),
    );
    expect(f.recorder.files[0]?.map((frame) => frame.kind)).toEqual([
      "pulseRate",
      "validation",
    ]);
    expect(f.session.panelState.recording).toBe(true);
    await f.session.stopSession();
    expect(f.recorder.files[0]?.at(-1)).toEqual({
      kind: "end",
      durationUs: 1_000_000,
    });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(100));
    expect(f.recorder.starts).toBe(1);
    expect(f.recorder.appends).toBe(3);
    expect(f.session.panelState.recording).toBe(false);
  });

  it("resets calibration, normalizers, timing and manual pause on a fresh start", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, privacyMode: "numbers" });
    await pulses(f.session, 0, 73);
    expect(f.session.panelState.phase).toBe("live");
    await f.session.ingestFrame(wave("breathingWave", [[73, 1000]]));
    await f.session.setPaused(true);
    await f.session.stopSession();
    await f.session.startSession(start);
    await f.session.ingestFrame(wave("breathingWave", [[200, -1000]]));
    expect(f.session.panelState).toMatchObject({
      phase: "warming",
      pauseReason: null,
      pulse: null,
      baselineBpm: null,
      progress: { elapsedSeconds: 0 },
    });
    expect(f.publisher.states.at(-1)).toMatchObject({
      mode: "vibe",
      beatWave: [],
      breathWave: [{ atMs: 0, v: 0.5 }],
    });
  });

  it("cleans up a failed source start, discards its queued frames and allows retry", async () => {
    const f = fixture();
    f.source.failStart = true;
    f.source.onStart = () => f.source.emit(pulse(0));
    await expect(
      f.session.startSession({ ...start, recordingEnabled: true }),
    ).rejects.toThrow("Signal source could not start");
    await f.session.whenIdle();
    expect(f.source.stops).toBe(1);
    expect(f.source.listeners.size).toBe(0);
    expect(f.recorder.stops).toBe(1);
    expect(f.recorder.appends).toBe(0);
    expect(f.session.panelState).toMatchObject({
      active: false,
      processing: "error",
      errors: [expect.objectContaining({ operation: "sourceStart" })],
    });
    expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
    f.source.failStart = false;
    await f.session.startSession(start);
    await f.session.whenIdle();
    expect(f.session.panelState.active).toBe(true);
  });
});

describe("IngestFrame", () => {
  it("maps phases and streamer details while projecting Numbers readings", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, privacyMode: "numbers" });
    await f.session.ingestFrame({
      kind: "processing",
      t: at(0),
      status: "running",
    });
    await f.session.ingestFrame({
      kind: "validation",
      t: at(0),
      code: "ok",
      hint: "Keep your face centered",
    });
    await f.session.ingestFrame({
      kind: "breathingRate",
      reading: { value: 16.2, stable: true, confidence: 95, t: at(0) },
    });
    await pulses(f.session, 0, 11);
    expect(f.publisher.states.at(-1)).toMatchObject({ status: "calibrating" });
    expect(f.panels.at(-1)).toMatchObject({
      phase: "warming",
      processing: "running",
      validation: { hint: "Keep your face centered" },
      breathing: { value: 16.2, confidence: 95 },
      progress: { elapsedSeconds: 11, requiredSeconds: 12 },
    });
    await pulses(f.session, 12, 36);
    expect(f.session.panelState.phase).toBe("baselining");
    expect(f.publisher.states.at(-1)).toMatchObject({ status: "calibrating" });
    await pulses(f.session, 37, 38, 70.4);
    expect(f.session.panelState).toMatchObject({
      phase: "live",
      baselineBpm: 70,
      progress: null,
      pulse: { value: 70.4, confidence: 90, stable: true },
    });
    expect(f.publisher.states.at(-1)).toMatchObject({
      status: "live",
      pulseBpm: 70,
      breathingRate: 16,
    });
    await f.session.ingestFrame(pulse(39, 111));
    expect(f.publisher.states.at(-1)).toMatchObject({
      status: "live",
      pulseBpm: "out_of_range",
      beatWave: [],
    });
    expect(f.session.panelState).toMatchObject({
      phase: "out_of_range",
      pulse: null,
      pulseOutOfRange: true,
    });
  });

  it.each(["second face", "validation", "manual", "unusable input"] as const)(
    "clears both Numbers readings during %s and requires fresh eligible readings",
    async (pause) => {
      const f = fixture();
      f.clock.value = at(0);
      await f.session.startSession({ ...start, privacyMode: "numbers" });
      const breath = (seconds: number, value: number) =>
        f.session.ingestFrame({
          kind: "breathingRate",
          reading: { t: at(seconds), value, stable: true, confidence: 90 },
        });
      await f.session.ingestFrame(pulse(0, 78));
      await breath(0, 15);
      expect(f.publisher.states.at(-1)).toMatchObject({
        pulseBpm: 78,
        breathingRate: 15,
      });

      if (pause === "manual") await f.session.setPaused(true);
      else {
        await f.session.ingestFrame({
          kind: "validation",
          t: at(1),
          code: pause === "second face" ? "multipleFacesFound" : "tooDark",
          hint: "",
        });
        if (pause === "unusable input") {
          f.clock.value = at(60);
          await f.session.checkValidationTimeout();
        }
      }
      const firstPaused = f.publisher.states.length - 1;
      await breath(62, 24);
      await f.session.ingestFrame(pulse(63, 95));
      expect(f.publisher.states.at(-1)).toMatchObject({
        status: "paused",
        pulseBpm: null,
        breathingRate: null,
      });
      if (pause === "second face") {
        expect(f.session.panelState).toMatchObject({
          pulse: null,
          breathing: null,
          talking: null,
        });
      } else if (pause === "validation") {
        expect(f.session.panelState.breathing?.value).toBe(24);
      } else {
        await f.session.setPaused(false);
      }
      for (const state of f.publisher.states.slice(firstPaused)) {
        expect(state).toMatchObject({ pulseBpm: null, breathingRate: null });
      }
      await f.session.ingestFrame({
        kind: "validation",
        t: at(64),
        code: "ok",
        hint: "",
      });
      await breath(63, 25);
      expect(f.publisher.states.at(-1)).toMatchObject({
        pulseBpm: null,
        breathingRate: null,
      });
      await f.session.ingestFrame(pulse(76, 79));
      expect(f.publisher.states.at(-1)).toMatchObject({
        pulseBpm: 79,
        breathingRate: null,
      });
      await breath(77, 17);
      expect(f.publisher.states.at(-1)).toMatchObject({
        pulseBpm: 79,
        breathingRate: 17,
      });
    },
  );

  it("maintains separate rolling wave normalizers and fills successive fallback windows", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame(
      wave("pulseWave", [
        [0, 10],
        [0.2, 20],
      ]),
    );
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [{ atMs: 0, v: 0.5 }],
    });
    await f.session.ingestFrame(
      wave("breathingWave", [
        [0.1, -2],
        [0.4, 2],
      ]),
    );
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [
        { atMs: 200, v: 1 },
        { atMs: 350, v: expect.any(Number) },
      ],
      breathWave: [
        { atMs: 100, v: 0.5 },
        { atMs: 400, v: 1 },
      ],
    });
    await f.session.ingestFrame(wave("pulseWave", [[0.6, 15]]));
    await f.session.ingestFrame(pulse(1));
    const state = f.publisher.states.at(-1);
    expect(state).toMatchObject({ mode: "vibe" });
    if (state?.mode !== "vibe") throw new Error("Expected Vibe");
    expect(state.beatWave[0]).toEqual({ atMs: 600, v: 0.5 });
    expect(state.beatWave.some((point) => point.atMs === 750)).toBe(true);
    expect(
      state.beatWave.every((point) => point.atMs >= 600 && point.atMs < 1000),
    ).toBe(true);
    expect(state.breathWave).toEqual([]);
    expect(state.beatWave.every((point) => point.v >= 0 && point.v <= 1)).toBe(
      true,
    );
  });

  it("preserves the first wave batch's origin and boundary sample", async () => {
    const f = fixture();
    await f.session.startSession(start);
    await f.session.ingestFrame(
      wave("pulseWave", [
        [0, 10],
        [0.1, 20],
      ]),
    );
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [{ atMs: 0, v: 0.5 }],
    });
    await f.session.ingestFrame(pulse(0.2));
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [{ atMs: 100, v: 1 }],
    });
  });

  it("publishes real wave batches arriving after a rate with the same timestamp", async () => {
    const f = fixture();
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame(pulse(1));
    await f.session.ingestFrame(
      wave("pulseWave", [
        [0.8, 10],
        [0.9, 20],
        [1, 15],
      ]),
    );
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [
        { atMs: 800, v: 0.5 },
        { atMs: 900, v: 1 },
      ],
    });
    await f.session.ingestFrame(pulse(1.1));
    expect(f.publisher.states.at(-1)).toMatchObject({
      beatWave: [{ atMs: 1000, v: 0.5 }],
    });
  });

  it("keeps raw signal quality in the panel while publishing only a usable pulse", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, privacyMode: "numbers" });
    await f.session.ingestFrame(pulse(0, 70, { confidence: 0, stable: false }));
    expect(f.session.panelState.pulse).toMatchObject({
      value: 70,
      confidence: 0,
      stable: false,
    });
    expect(f.publisher.states.at(-1)).toMatchObject({ pulseBpm: null });
    await f.session.ingestFrame(pulse(1, 70));
    await f.session.ingestFrame(
      pulse(2, 75, { confidence: 20, stable: false }),
    );
    expect(f.session.panelState.pulse).toMatchObject({
      value: 75,
      confidence: 20,
      stable: false,
    });
    expect(f.publisher.states.at(-1)).toMatchObject({ pulseBpm: 70 });
  });

  it("logs publication failures, retries the missing window, and continues spikes and panel updates", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    f.publisher.fail = true;
    await pulses(f.session, 1, 2, 82);
    expect(f.highlights.items).toHaveLength(1);
    expect(f.session.panelState).toMatchObject({
      active: true,
      errors: [expect.objectContaining({ operation: "overlayPublish" })],
    });
    expect(f.logger.errors).toContain("Overlay state could not be published.");
    f.publisher.fail = false;
    await f.session.ingestFrame(pulse(3, 82));
    const state = f.publisher.states.at(-1);
    if (state?.mode !== "vibe") throw new Error("Expected Vibe");
    expect(state.beatWave[0]?.atMs).toBe(0);
    expect(state.beatWave.at(-1)?.atMs).toBe(2950);
    expect(f.panels.at(-1)?.pulse?.t).toBe(at(3));
  });

  it("uses frame time after the first frame even when command clock time differs", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    expect(f.session.panelState.t).toBe(at(-10_000));
    await f.session.setPaused(true);
    expect(f.session.panelState.t).toBe(at(-10_000));
    await f.session.setPaused(false);
    await f.session.ingestFrame(pulse(0));
    f.clock.value = at(100_000);
    await pulses(f.session, 1, 2, 82);
    await f.session.setPrivacyMode("numbers");
    await f.session.setPaused(true);
    await f.session.stopSession();
    expect(f.session.panelState.t).toBe(at(2));
    expect(f.highlights.items[0]?.sessionOffsetUs).toBe(2_000_000);
  });

  it("isolates panel listener failures and returns detached snapshots", async () => {
    const f = fixture({ policy: quickPolicy });
    const unsubscribe = f.session.subscribePanel(() => {
      throw new Error("Listener failure");
    });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    const snapshot = f.session.panelState;
    if (snapshot.pulse) Object.assign(snapshot.pulse, { value: 99 });
    expect(f.session.panelState.pulse?.value).toBe(70);
    expect(f.logger.errors).toContain("Panel state listener failed.");
    unsubscribe();
    const failures = f.logger.errors.length;
    await f.session.ingestFrame(pulse(1));
    expect(f.logger.errors).toHaveLength(failures);
    expect(f.panels.at(-1)?.pulse?.t).toBe(at(1));
  });
});

describe("spike receipts", () => {
  it.each(["End", "Delete all data"] as const)(
    "applies a late OBS answer in place after %s only if the highlight still exists",
    async (command) => {
      const f = fixture({ policy: quickPolicy });
      let reply!: () => void;
      f.marker.gate = new Promise<void>((resolve) => {
        reply = resolve;
      });
      await f.session.startSession(start);
      await f.session.ingestFrame(pulse(0));
      await f.session.ingestFrame(pulse(1, 82));
      const confirming = f.session.ingestFrame(pulse(2, 82));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.marker.labels).toEqual(["spike +12 vs baseline"]);
      const finishing =
        command === "End" ? f.session.stopSession() : f.session.deleteAllData();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.source.stops).toBe(1);
      await Promise.all([confirming, finishing]);
      const exists = command === "End";
      expect(f.highlights.items).toMatchObject(
        exists ? [{ t: at(2), recordingOffsetMs: null }] : [],
      );
      const publications = f.publisher.states.length;

      reply();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.session.whenIdle();
      expect(f.highlights.items).toMatchObject(
        exists ? [{ t: at(2), recordingOffsetMs: 20_000 }] : [],
      );
      expect(f.session.currentHighlights).toEqual(f.highlights.items);
      expect(f.publisher.states).toHaveLength(publications);
    },
  );

  it("ignores a deleted run's reply when replay reuses the same timestamps", async () => {
    const f = fixture({ replay: true, policy: quickPolicy });
    let reply!: () => void;
    f.marker.gate = new Promise<void>((resolve) => {
      reply = resolve;
    });
    const spike = async () => {
      await f.session.startSession(start);
      await f.session.ingestFrame(pulse(0));
      await pulses(f.session, 1, 2, 82);
    };
    await spike();
    await f.session.deleteAllData();
    f.marker.gate = new Promise<void>(() => {});
    await spike();
    reply();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.session.whenIdle();
    expect(f.highlights.items).toMatchObject([
      { sessionStartedAt: at(0), t: at(2), recordingOffsetMs: null },
    ]);
    expect(f.session.currentHighlights).toEqual(f.highlights.items);
  });

  it("records distinct OBS chapters and exports only the current run when replay repeats the same frames", async () => {
    const f = fixture({ replay: true, policy: quickPolicy });
    f.marker.results.push(
      { status: "created", recordingOffsetMs: 20_000 },
      { status: "created", recordingOffsetMs: 40_000 },
      { status: "created", recordingOffsetMs: 30_000 },
      { status: "created", recordingOffsetMs: 60_000 },
    );
    const replay = async () => {
      await f.session.startSession(start);
      await f.session.ingestFrame(pulse(0));
      await pulses(f.session, 1, 2, 82);
      await pulses(f.session, 3, 10);
      await pulses(f.session, 11, 12, 82);
      await f.session.stopSession();
      await f.session.whenIdle();
    };
    await replay();
    const firstRun = f.session.currentHighlights;
    expect(firstRun).toMatchObject([
      { sessionStartedAt: at(0), t: at(2), recordingOffsetMs: 20_000 },
      { sessionStartedAt: at(0), t: at(12), recordingOffsetMs: 40_000 },
    ]);

    let reply!: () => void;
    f.marker.gate = new Promise<void>((resolve) => {
      reply = resolve;
    });
    await replay();
    expect(f.marker.labels).toEqual(Array(4).fill("spike +12 vs baseline"));
    const secondRun = f.session.currentHighlights;
    expect(secondRun).toMatchObject([
      { sessionStartedAt: at(0), t: at(2), recordingOffsetMs: null },
      { sessionStartedAt: at(0), t: at(12), recordingOffsetMs: null },
    ]);
    expect(await f.highlights.list()).toEqual([...firstRun, ...secondRun]);
    const exportOptions = {
      sessionStartedAt: at(0),
      recordingDurationMs: 90_000,
    };
    const exporting = f.session.exportChapters(exportOptions);
    reply();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.session.whenIdle();
    const updatedSecondRun = f.session.panelState.highlights;
    expect(updatedSecondRun).toMatchObject([
      { t: at(2), recordingOffsetMs: 30_000 },
      { t: at(12), recordingOffsetMs: 60_000 },
    ]);
    expect(await f.highlights.list()).toEqual([
      ...firstRun,
      ...updatedSecondRun,
    ]);
    expect(await exporting).toEqual({
      ok: true,
      text: "00:00 Intro\n00:30 spike +12 vs baseline\n01:00 spike +12 vs baseline",
    });
  });

  it("does not apply an earlier replay's late reply to the newest matching receipt", async () => {
    const f = fixture({ replay: true, policy: quickPolicy });
    const replay = async () => {
      await f.session.startSession(start);
      await f.session.ingestFrame(pulse(0));
      await pulses(f.session, 1, 2, 82);
      await f.session.stopSession();
    };
    let firstReply!: () => void;
    f.marker.gate = new Promise<void>((resolve) => {
      firstReply = resolve;
    });
    await replay();
    let secondReply!: () => void;
    f.marker.gate = new Promise<void>((resolve) => {
      secondReply = resolve;
    });
    const started = deferred<void>();
    const hold = deferred<void>();
    const append = f.highlights.append.bind(f.highlights);
    f.highlights.append = async (receipt) => {
      started.resolve();
      await hold.promise;
      await append(receipt);
    };
    const secondRun = replay();
    await started.promise;
    try {
      firstReply();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.highlights.items).toMatchObject([
        { t: at(2), recordingOffsetMs: null },
      ]);
    } finally {
      hold.resolve();
      await secondRun;
    }
    expect(f.highlights.items).toMatchObject([
      { t: at(2), recordingOffsetMs: null },
      { t: at(2), recordingOffsetMs: null },
    ]);
    secondReply();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.session.whenIdle();
    expect(f.highlights.items).toMatchObject([
      { t: at(2), recordingOffsetMs: null },
      { t: at(2), recordingOffsetMs: 20_000 },
    ]);
    expect(f.marker.labels).toHaveLength(2);
  });

  it("shares a label between chapter and highlight with both offsets and talking metadata", async () => {
    const f = fixture({ policy: quickPolicy });
    f.marker.results.push({ status: "created", recordingOffsetMs: 0 });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame({
      kind: "talking",
      t: at(1),
      detected: true,
      stable: true,
    });
    await pulses(f.session, 1, 2, 87);
    expect(f.marker.labels).toEqual(["spike +17 vs baseline"]);
    await f.session.whenIdle();
    expect(f.highlights.items).toEqual([
      {
        t: at(2),
        sessionStartedAt: at(0),
        sessionOffsetUs: 2_000_000,
        recordingOffsetMs: 0,
        label: "spike +17 vs baseline",
        deltaBpm: 17,
        talkingRecent: true,
      },
    ]);
    expect(f.session.panelState.highlights).toEqual(f.highlights.items);
  });

  it("assigns each fresh session its frame-time origin on persisted highlights", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(
      wave("pulseWave", [
        [0, 10],
        [0.1, 20],
      ]),
    );
    await f.session.ingestFrame(pulse(1));
    await pulses(f.session, 2, 3, 82);
    await f.session.stopSession();
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(100));
    await pulses(f.session, 101, 102, 82);
    expect(f.highlights.items).toMatchObject([
      { sessionStartedAt: at(0), sessionOffsetUs: 3_000_000, t: at(3) },
      { sessionStartedAt: at(100), sessionOffsetUs: 2_000_000, t: at(102) },
    ]);
  });

  it.each(["disconnected", "notRecording", "unsupported", "rejected"] as const)(
    "keeps a local highlight and later detection when marker is %s",
    async (reason) => {
      const f = fixture({ policy: quickPolicy });
      f.marker.results.push(
        reason === "rejected"
          ? new Error("Marker failure")
          : { status: "unavailable", reason },
      );
      await f.session.startSession(start);
      await f.session.ingestFrame(pulse(0));
      await pulses(f.session, 1, 2, 82);
      expect(f.highlights.items[0]).toMatchObject({
        recordingOffsetMs: null,
        deltaBpm: 12,
      });
      expect(f.logger.errors.length + f.logger.warnings.length).toBeGreaterThan(
        0,
      );
      if (reason === "rejected") {
        expect(f.logger.errors).toEqual([
          "Recording chapter failed; keeping local highlight.",
        ]);
        expect(f.session.panelState.errors).toContainEqual({
          operation: "marker",
          message: "Recording chapter failed; keeping local highlight.",
        });
      }
      await pulses(f.session, 3, 4);
      await pulses(f.session, 5, 7, 82);
      expect(f.highlights.items).toHaveLength(2);
      expect(f.session.panelState.active).toBe(true);
    },
  );

  it("reports repository failure in the panel while retaining a transient receipt and measuring", async () => {
    const f = fixture({ policy: quickPolicy });
    f.highlights.failAppend = true;
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    expect(f.session.panelState.highlights).toHaveLength(1);
    expect(f.session.panelState.errors).toContainEqual(
      expect.objectContaining({ operation: "highlightAppend" }),
    );
    expect(f.logger.errors).toContain(
      "A highlight could not be saved locally.",
    );
    f.highlights.failAppend = false;
    await pulses(f.session, 3, 4);
    await pulses(f.session, 5, 7, 82);
    expect(f.highlights.items).toHaveLength(1);
    expect(f.session.panelState.active).toBe(true);
  });

  it("rejects late source callbacks from the old session", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.stopSession();
    await f.session.startSession(start);
    f.source.oldListeners[0]?.(pulse(100));
    const publications = f.publisher.states.length;
    f.source.oldListeners[0]?.({
      kind: "validation",
      t: at(101),
      code: "multipleFacesFound",
      hint: "",
    });
    await f.session.whenIdle();
    expect(f.session.panelState.pulse).toBeNull();
    expect(f.publisher.states).toHaveLength(publications);
    f.source.emit(pulse(200));
    await f.session.whenIdle();
    expect(f.session.panelState.pulse?.t).toBe(at(200));
    expect(f.source.listeners.size).toBe(1);
  });
});

describe("privacy, pause and stop", () => {
  it.each(["live", "replay"] as const)(
    "discards both audited breathing estimates in %s and trims late mixed batches",
    async (mode) => {
      const f = fixture({ replay: mode === "replay" });
      await f.session.startSession({ ...start, recordingEnabled: true });
      const intervals = [
        // Recovery sample line 30027 before the scrub.
        [
          1_795_019_696_954_400, 1_795_019_697_791_000, 1_795_019_700_624_400,
          19.19493293762207,
        ],
        // Recovery sample line 30738 before the scrub.
        [
          1_795_019_705_457_000, 1_795_019_705_657_300, 1_795_019_707_524_200,
          22.310638427734375,
        ],
      ] as const;
      const reading = (t: number, value: number) =>
        ({
          kind: "breathingRate",
          reading: { t, value, stable: true, confidence: 52 },
        }) as const;

      for (const [from, t, until, value] of intervals) {
        const previous = reading(from - 1, 15);
        await f.session.ingestFrame(previous);
        expect(f.session.panelState.breathing).toEqual(previous.reading);
        const warning = {
          kind: "validation",
          t: from,
          code: "multipleFacesFound",
          hint: "",
        } as const;
        const processing = {
          kind: "processing",
          t,
          status: "running",
        } as const;
        const audited = reading(t, value);
        const talking = {
          kind: "talking",
          t,
          detected: true,
          stable: true,
        } as const;
        const waveSample = { t, value: 0.5, stable: true };
        const during = [
          audited,
          pulse(0, 91, { t }),
          talking,
          { kind: "pulseWave", samples: [waveSample] },
          { kind: "breathingWave", samples: [waveSample] },
          reading(from - 1, 25),
        ] as const;
        const ok = {
          kind: "validation",
          t: until,
          code: "ok",
          hint: "",
        } as const;
        const recovered = { ...waveSample, t: until };
        const count = f.recorder.appends;
        await f.session.ingestFrame(warning);
        await f.session.ingestFrame(processing);
        for (const frame of during) {
          await f.session.ingestFrame(frame);
          expect.soft(f.session.panelState).toMatchObject({
            pulse: null,
            breathing: null,
            talking: null,
          });
        }
        await f.session.ingestFrame(ok);
        for (const frame of during.slice(0, 3))
          await f.session.ingestFrame(frame);
        for (const kind of ["pulseWave", "breathingWave"] as const) {
          await f.session.ingestFrame({
            kind,
            samples: [waveSample, recovered],
          });
        }
        expect.soft(f.session.panelState).toMatchObject({
          pulse: null,
          breathing: null,
          talking: null,
          validation: { code: "ok" },
          processing: "running",
        });
        expect
          .soft(f.recorder.files[0]?.slice(count))
          .toEqual([
            warning,
            processing,
            ok,
            { kind: "pulseWave", samples: [recovered] },
            { kind: "breathingWave", samples: [recovered] },
          ]);
        await f.session.ingestFrame(reading(until, 16));
        expect.soft(f.session.panelState.breathing?.value).toBe(16);
      }

      // The first interval is still blocked after the second one has closed.
      const [, earlierTimestamp] = intervals[0];
      await f.session.ingestFrame(reading(earlierTimestamp, 19));
      expect(f.recorder.files[0]).not.toContainEqual(
        reading(earlierTimestamp, 19),
      );
    },
  );

  it("keeps the drain, processing and end records when a second face arrives during End", async () => {
    const f = fixture();
    await f.session.startSession({ ...start, recordingEnabled: true });
    const first = pulse(0);
    await f.session.ingestFrame(first);
    await f.session.withdrawSharing("drain");
    const warning = {
      kind: "validation",
      t: at(1),
      code: "multipleFacesFound",
      hint: "",
    } as const;
    const processing = {
      kind: "processing",
      t: at(2),
      status: "stopping",
    } as const;
    await f.session.ingestFrame(warning);
    await f.session.ingestFrame(processing);
    await f.session.ingestFrame(pulse(3, 91));
    await f.session.stopSession();
    expect(f.recorder.files[0]).toEqual([
      first,
      { kind: "drain" },
      warning,
      processing,
      { kind: "end", durationUs: 3_000_000 },
    ]);
  });

  it.each(["multipleFacesFound", "tooDark"] as const)(
    "restricts delivered %s during a held recorder append until a newer OK is processed",
    async (code) => {
      const f = fixture({
        policy: { ...quickPolicy, validationSettleSeconds: 0 },
      });
      await f.session.startSession({
        ...start,
        privacyMode: "numbers",
        recordingEnabled: true,
      });
      const validate = (seconds: number, validationCode: typeof code | "ok") =>
        ({
          kind: "validation",
          t: at(seconds),
          code: validationCode,
          hint: "",
        }) as const;
      await f.session.ingestFrame(validate(0, "ok"));
      await f.session.ingestFrame(pulse(1, 82));
      expect(f.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

      const writing = deferred<void>();
      const release = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      f.recorder.append = async (frame) => {
        writing.resolve();
        await release.promise;
        await append(frame);
      };
      const heldFrame = pulse(2, 83);
      f.source.emit(heldFrame);
      await writing.promise;

      const queued = [
        validate(3, code),
        validate(4, "ok"),
        pulse(5, 84),
        validate(6, code),
      ];
      const restrictedPulse = pulse(6.5, 85);
      for (const frame of queued) f.source.emit(frame);
      if (code === "multipleFacesFound") f.source.emit(restrictedPulse);
      const viewer: OverlayState[] = [];
      f.publisher.connect((state) => viewer.push(state));
      expect(f.session.panelState.validation?.code).toBe("ok");
      expect(f.recorder.files[0]).toHaveLength(2);
      if (code === "multipleFacesFound") {
        expect.soft(f.panels.at(-1)?.pulse).toBeNull();
        expect.soft(f.session.panelState.pulse).toBeNull();
      }
      release.resolve();
      await f.session.whenIdle();

      expect(f.recorder.files[0]?.slice(2)).toEqual([heldFrame, ...queued]);
      expect(viewer.length).toBeGreaterThan(0);
      for (const state of viewer) {
        expect.soft(state).toMatchObject({
          status: code === "multipleFacesFound" ? "paused" : "live",
          pulseBpm: null,
          breathingRate: null,
          beatWave: [],
          breathWave: [],
        });
      }
      f.source.emit(validate(7, "ok"));
      f.source.emit(pulse(8, 86));
      await f.session.whenIdle();
      expect(viewer.at(-1)).toMatchObject({ status: "live", pulseBpm: 86 });
    },
  );

  it.each(["mode upgrade", "resume"] as const)(
    "keeps a newer withdrawal ahead of an earlier queued %s",
    async (change) => {
      const f = fixture({ policy: quickPolicy, replay: true });
      await f.session.startSession({
        ...start,
        privacyMode: change === "resume" ? "numbers" : "vibe",
        recordingEnabled: true,
      });
      await f.session.ingestFrame(pulse(0));
      if (change === "resume") await f.session.setPaused(true);
      const started = deferred<void>();
      const hold = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      f.recorder.append = async (frame) => {
        started.resolve();
        await hold.promise;
        await append(frame);
      };
      const frame = f.session.ingestFrame(pulse(1, 82));
      await started.promise;
      const before = f.publisher.states.length;
      const relax =
        change === "resume"
          ? f.session.setPaused(false)
          : f.session.setPrivacyMode("numbers");
      const withdraw =
        change === "resume"
          ? f.session.setPaused(true)
          : f.session.setPrivacyMode("vibe");
      hold.resolve();
      await Promise.all([frame, relax, withdraw]);
      expect(f.publisher.states.at(-1)).toMatchObject(
        change === "resume"
          ? { mode: "numbers", status: "paused", pulseBpm: null }
          : { mode: "vibe" },
      );
      for (const state of f.publisher.states.slice(before)) {
        if (change === "resume")
          expect(state).toMatchObject({ status: "paused", pulseBpm: null });
        else expect(state.mode).toBe("vibe");
      }
    },
  );

  const pendingWrites = ["highlight append", "offset write", "recorder append"];
  it.each(
    pendingWrites.flatMap((write) =>
      (["vibe", "highlightsOnly", "pause", "end"] as const).map((command) => ({
        write,
        command,
      })),
    ),
  )(
    "withdraws $command while a $write is pending",
    async ({ write, command }) => {
      const f = fixture({ policy: quickPolicy });
      await f.session.startSession({
        ...start,
        privacyMode: "numbers",
        recordingEnabled: true,
      });
      await f.session.ingestFrame(pulse(0));
      await f.session.ingestFrame({
        kind: "breathingRate",
        reading: { t: at(1), value: 14, confidence: 90, stable: true },
      });
      await f.session.ingestFrame(pulse(1, 82));
      expect(f.publisher.states.at(-1)).toMatchObject({
        pulseBpm: 82,
        breathingRate: 14,
      });

      const started = deferred<void>();
      const hold = deferred<void>();
      if (write === "highlight append") {
        const append = f.highlights.append.bind(f.highlights);
        f.highlights.append = async (receipt) => {
          started.resolve();
          await hold.promise;
          await append(receipt);
        };
      } else if (write === "offset write") {
        const update = f.highlights.updateRecordingOffset.bind(f.highlights);
        f.highlights.updateRecordingOffset = async (receipt, offset) => {
          started.resolve();
          await hold.promise;
          return update(receipt, offset);
        };
      } else {
        const append = f.recorder.append.bind(f.recorder);
        f.recorder.append = async (frame) => {
          started.resolve();
          await hold.promise;
          await append(frame);
        };
      }
      const confirming = f.session.ingestFrame(pulse(2, 82));
      await started.promise;
      const queued = f.session.ingestFrame(pulse(3, 82));
      const changing =
        command === "end"
          ? f.session.stopSession()
          : command === "pause"
            ? f.session.setPaused(true)
            : f.session.setPrivacyMode(command);
      const viewer: OverlayState[] = [];
      const check = (state: OverlayState | undefined) => {
        if (command === "pause") {
          expect(state).toMatchObject({
            mode: "numbers",
            status: "paused",
            pulseBpm: null,
            breathingRate: null,
            beatWave: [],
            breathWave: [],
          });
        } else {
          expect(state?.mode).toBe(command === "end" ? "off" : command);
          expect(state).not.toHaveProperty("pulseBpm");
          expect(state).not.toHaveProperty("breathingRate");
        }
      };
      try {
        f.publisher.connect((state) => viewer.push(state));
        expect(viewer).toHaveLength(1);
        check(viewer[0]);
        if (write === "offset write") {
          let finished = false;
          void Promise.all([queued, changing]).then(() => {
            finished = true;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(finished).toBe(true);
        }
      } finally {
        hold.resolve();
        await Promise.all([confirming, queued, changing]);
      }
      for (const state of viewer) check(state);
    },
  );

  it.each(["vibe", "highlightsOnly", "pause", "off", "end"] as const)(
    "persists the confirmed spike and applies %s while OBS never answers",
    async (command) => {
      const f = fixture({ policy: quickPolicy });
      f.marker.gate = new Promise<void>(() => {});
      await f.session.startSession({ ...start, privacyMode: "numbers" });
      await f.session.ingestFrame(pulse(0));
      await f.session.ingestFrame({
        kind: "breathingRate",
        reading: { t: at(1), value: 14, confidence: 90, stable: true },
      });
      await f.session.ingestFrame(pulse(1, 82));
      const connected: OverlayState[] = [];
      f.publisher.connect((state) => connected.push(state));
      expect(connected.at(-1)).toMatchObject({
        mode: "numbers",
        pulseBpm: 82,
        breathingRate: 14,
      });

      let frameCompleted = false;
      const confirming = f.session.ingestFrame(pulse(2, 82)).then(() => {
        frameCompleted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.marker.labels).toEqual(["spike +12 vs baseline"]);
      const changing =
        command === "end"
          ? f.session.stopSession()
          : command === "pause"
            ? f.session.setPaused(true)
            : f.session.setPrivacyMode(command);
      let commandCompleted = false;
      void changing.then(() => {
        commandCompleted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const late: OverlayState[] = [];
      f.publisher.connect((state) => late.push(state));
      expect(late).toEqual([connected.at(-1)]);
      if (command === "pause") {
        expect(late[0]).toMatchObject({
          mode: "numbers",
          status: "paused",
          pulseBpm: null,
          breathingRate: null,
        });
        expect(f.session.panelState.pauseReason).toBe("manual");
      } else {
        expect(late[0]?.mode).toBe(command === "end" ? "off" : command);
        expect(JSON.stringify(late)).not.toMatch(/pulseBpm|breathingRate/iu);
      }
      expect(f.session.panelState.active).toBe(
        command !== "off" && command !== "end",
      );
      expect(frameCompleted).toBe(true);
      expect(commandCompleted).toBe(true);
      expect(f.highlights.items).toMatchObject([
        { sessionStartedAt: at(0), t: at(2), recordingOffsetMs: null },
      ]);
      await Promise.all([confirming, changing]);
    },
  );

  const phases = [
    "live",
    "calibrating",
    "paused",
    "multipleFaces",
    "outOfRange",
  ] as const;
  it.each(
    phases.flatMap((phase) =>
      (["vibe", "highlightsOnly", "off"] as const).map((mode) => ({
        phase,
        mode,
      })),
    ),
  )(
    "immediately replaces Numbers with $mode while $phase for connected and late viewers, without later frames",
    async ({ phase, mode }) => {
      const f = fixture(phase === "calibrating" ? {} : { policy: quickPolicy });
      await f.session.startSession({ ...start, privacyMode: "numbers" });
      await f.session.ingestFrame(pulse(0));
      if (phase === "paused") await f.session.setPaused(true);
      if (phase === "multipleFaces")
        await f.session.ingestFrame({
          kind: "validation",
          t: at(1),
          code: "multipleFacesFound",
          hint: "One person only",
        });
      if (phase === "outOfRange") await f.session.ingestFrame(pulse(1, 150));
      const connected: OverlayState[] = [];
      f.publisher.connect((state) => connected.push(state));
      expect(connected.at(-1)?.mode).toBe("numbers");
      const published = f.publisher.states.length;
      await f.session.setPrivacyMode(mode);
      expect(f.publisher.states).toHaveLength(published + 1);
      expect(f.session.panelState.privacyMode).toBe(mode);
      expect(connected).toHaveLength(2);
      expect(connected.at(-1)?.mode).toBe(mode);
      const late: OverlayState[] = [];
      f.publisher.connect((state) => late.push(state));
      expect(late).toEqual([connected.at(-1)]);
      expect(JSON.stringify(late)).not.toMatch(
        /pulseBpm|breathingRate|confidence|stable|baseline|delta/iu,
      );
      expect(f.source.starts).toBe(1);
      expect(f.source.stops).toBe(mode === "off" ? 1 : 0);
    },
  );

  it("publishes every enabled transition, including returning to Numbers without frames", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    for (const mode of [
      "numbers",
      "highlightsOnly",
      "vibe",
      "numbers",
    ] as const) {
      const published = f.publisher.states.length;
      await f.session.setPrivacyMode(mode);
      expect(f.publisher.states).toHaveLength(published + 1);
      expect(f.publisher.states.at(-1)?.mode).toBe(mode);
    }
  });

  it("surfaces privacy publication failures to the panel", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({ ...start, privacyMode: "numbers" });
    f.publisher.fail = true;
    await f.session.setPrivacyMode("highlightsOnly");
    expect(f.publisher.attempts.at(-1)).toEqual({
      mode: "highlightsOnly",
      replay: false,
    });
    expect(f.panels.at(-1)?.errors).toContainEqual({
      operation: "overlayPublish",
      message: "Overlay state could not be published.",
    });
    expect(f.logger.errors).toContain("Overlay state could not be published.");
  });

  it("publishes pause, resume and stop immediately with no later frames", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    const published = f.publisher.states.length;
    await f.session.setPaused(true);
    expect(f.publisher.states).toHaveLength(published + 1);
    expect(f.publisher.states.at(-1)).toMatchObject({
      status: "paused",
      beatWave: [],
      breathWave: [],
    });
    await f.session.setPaused(false);
    expect(f.publisher.states).toHaveLength(published + 2);
    expect(f.publisher.states.at(-1)).toMatchObject({ status: "live" });
    await f.session.stopSession();
    expect(f.publisher.states).toHaveLength(published + 3);
    expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
  });

  it("Off stops capture/recording and refuses reactivation without a new start", async () => {
    const f = fixture({ replay: true });
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame(pulse(0));
    await f.session.setPrivacyMode("off");
    expect(f.source.stops).toBe(1);
    expect(f.recorder.stops).toBe(1);
    expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: true });
    expect(f.session.panelState.active).toBe(false);
    await expect(f.session.setPrivacyMode("vibe")).rejects.toThrow(
      "Start a new session",
    );
    const published = f.publisher.states.length;
    await f.session.setPaused(true);
    await f.session.ingestFrame(pulse(100));
    expect(f.publisher.states).toHaveLength(published);
    await f.session.startSession(start);
    expect(f.source.starts).toBe(2);
  });

  it("finishes a highlight confirmed before Off while the recorder append is held", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({
      ...start,
      privacyMode: "numbers",
      recordingEnabled: true,
    });
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame(pulse(1, 82));
    expect(f.publisher.states.at(-1)).toMatchObject({
      mode: "numbers",
      pulseBpm: 82,
    });

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append = f.recorder.append.bind(f.recorder);
    f.recorder.append = async (frame) => {
      entered();
      await gate;
      await append(frame);
    };
    const confirming = f.session.ingestFrame(pulse(2, 82));
    await appendStarted;
    const beforeOff = f.publisher.states.length;
    const stopping = f.session.setPrivacyMode("off");
    const viewer: OverlayState[] = [];
    try {
      f.publisher.connect((state) => viewer.push(state));
      expect(viewer).toEqual([{ mode: "off", replay: false }]);
      expect(f.highlights.items).toMatchObject([
        { t: at(2), recordingOffsetMs: null },
      ]);
      expect(f.recorder.stops).toBe(0);
    } finally {
      release();
    }
    await Promise.all([confirming, stopping]);
    await f.session.whenIdle();

    expect(f.marker.labels).toEqual(["spike +12 vs baseline"]);
    expect(f.highlights.items).toMatchObject([
      { t: at(2), recordingOffsetMs: 20_000 },
    ]);
    expect(f.session.panelState.highlights).toEqual(f.highlights.items);
    expect(f.panels).toContainEqual(
      expect.objectContaining({
        active: true,
        privacyMode: "off",
        highlights: [expect.objectContaining({ t: at(2) })],
      }),
    );
    expect(f.publisher.states.slice(beforeOff)).toEqual([
      { mode: "off", replay: false },
    ]);
  });

  it.each(["privacyOff", "stopSession"] as const)(
    "publishes Off before a slow source finishes stopping via %s",
    async (command) => {
      const f = fixture({ policy: quickPolicy });
      await f.session.startSession({ ...start, privacyMode: "numbers" });
      await f.session.ingestFrame(pulse(0));
      let release!: () => void;
      const stopped = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stopSource = f.source.stop.bind(f.source);
      f.source.stop = async () => {
        await stopped;
        await stopSource();
      };
      const stopping =
        command === "privacyOff"
          ? f.session.setPrivacyMode("off")
          : f.session.stopSession();
      await Promise.resolve();
      expect(f.source.stops).toBe(0);
      expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
      release();
      await stopping;
      expect(f.source.stops).toBe(1);
    },
  );

  it("keeps the baseline, highlights and recording through a long manual capture pause", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    expect(f.highlights.items).toHaveLength(1);
    const appends = f.recorder.appends;
    await f.session.setPaused(true);
    await pulses(f.session, 1, 10, 90);
    await f.session.ingestFrame(
      wave("pulseWave", [
        [10, 20],
        [10.1, 30],
      ]),
    );
    expect(f.publisher.states.at(-1)).toMatchObject({
      status: "paused",
      beatWave: [],
      breathWave: [],
    });
    expect(f.marker.labels).toHaveLength(1);
    expect(f.recorder.appends).toBe(appends + 1);
    expect(f.session.panelState).toMatchObject({
      active: true,
      pauseReason: "manual",
      baselineBpm: 70,
      recording: true,
      highlights: f.highlights.items,
    });
    await f.session.setPaused(false);
    await f.session.ingestFrame(pulse(200, 87));
    expect(f.publisher.states.at(-1)).toMatchObject({ beatWave: [] });
    await f.session.ingestFrame(pulse(201, 87));
    expect(f.highlights.items).toHaveLength(2);
    expect(f.highlights.items[1]?.sessionStartedAt).toBe(at(0));
    expect(f.session.panelState).toMatchObject({
      pauseReason: null,
      baselineBpm: 70,
      recording: true,
    });
    expect(f.source.starts).toBe(1);
    expect(f.source.stops).toBe(0);
    expect(f.recorder.starts).toBe(1);
    expect(f.recorder.stops).toBe(0);
    expect(f.recorder.appends).toBe(appends + 4);
    expect(f.publisher.states.at(-1)).toMatchObject({
      status: "live",
      intensity: "spike",
    });
  });

  it("does not override an automatic multi-face pause on manual resume", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame({
      kind: "validation",
      t: at(1),
      code: "multipleFacesFound",
      hint: "One person only",
    });
    await f.session.setPaused(true);
    await f.session.setPaused(false);
    expect(f.session.panelState).toMatchObject({
      phase: "paused",
      pauseReason: null,
    });
    await f.session.ingestFrame({
      kind: "validation",
      t: at(2),
      code: "ok",
      hint: "Ready",
    });
    expect(f.session.panelState.phase).toBe("live");
  });

  it("records a queued multi-face validation before Pause and requires fresh OK after Resume", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({
      ...start,
      privacyMode: "numbers",
      recordingEnabled: true,
    });
    await f.session.ingestFrame(pulse(0, 82));
    const writing = deferred<void>();
    const release = deferred<void>();
    const append = f.recorder.append.bind(f.recorder);
    f.recorder.append = async (frame) => {
      writing.resolve();
      await release.promise;
      await append(frame);
    };
    f.source.emit(pulse(1, 82));
    await writing.promise;
    const validation = {
      kind: "validation",
      t: at(2),
      code: "multipleFacesFound",
      hint: "One person only",
    } as const;
    f.source.emit(validation);
    f.clock.value = at(3);
    const pausing = f.session.setPaused(true);
    const viewer: OverlayState[] = [];
    f.publisher.connect((state) => viewer.push(state));
    release.resolve();
    await pausing;
    f.clock.value = at(4);
    await f.session.setPaused(false);
    await f.session.ingestFrame(pulse(5, 85));
    expect
      .soft(f.recorder.files[0]?.slice(2, 4))
      .toEqual([validation, { kind: "capture", state: "paused", t: at(3) }]);
    expect.soft(viewer[0]).toMatchObject({ status: "paused", pulseBpm: null });
    for (const state of viewer)
      expect.soft(state).toMatchObject({ status: "paused", pulseBpm: null });
    await f.session.ingestFrame({
      kind: "validation",
      t: at(6),
      code: "ok",
      hint: "Ready",
    });
    await f.session.ingestFrame(pulse(17, 85));
    expect(viewer.at(-1)).toMatchObject({ status: "live", pulseBpm: null });
    await f.session.ingestFrame(pulse(19, 86));
    expect(viewer.at(-1)).toMatchObject({ status: "live", pulseBpm: 86 });
  });

  it.each([
    "a dropped second-face callback",
    "a second-face callback superseded by Resume",
    "no warning",
  ] as const)(
    "requires fresh validation after Resume with %s",
    async (scenario) => {
      const f = fixture({ policy: quickPolicy });
      await f.session.startSession({
        ...start,
        privacyMode: "numbers",
        recordingEnabled: true,
      });
      const ok = (seconds: number) =>
        ({
          kind: "validation",
          t: at(seconds),
          code: "ok",
          hint: "Ready",
        }) as const;
      await f.session.ingestFrame(ok(0));
      await f.session.ingestFrame(pulse(1, 82));
      expect(f.publisher.states.at(-1)).toMatchObject({ pulseBpm: 82 });

      const writing = deferred<void>();
      const release = deferred<void>();
      const append = f.recorder.append.bind(f.recorder);
      f.recorder.append = async (frame) => {
        writing.resolve();
        await release.promise;
        await append(frame);
      };
      f.source.emit(pulse(2, 83));
      await writing.promise;
      f.clock.value = at(3);
      const pausing = f.session.setPaused(true);
      const warning = {
        kind: "validation",
        t: at(3),
        code: "multipleFacesFound",
        hint: "One person only",
      } as const;
      if (scenario === "a dropped second-face callback") f.source.emit(warning);
      release.resolve();
      await pausing;

      f.clock.value = at(4);
      const previousCapture = f.session.captureGeneration;
      const resuming = f.session.setPaused(false);
      if (scenario === "a second-face callback superseded by Resume")
        f.source.emit(warning, previousCapture);
      await resuming;
      expect(f.recorder.files[0]).not.toContainEqual(warning);
      const beforeOk = pulse(5, 85);
      f.source.emit(beforeOk);
      await f.session.whenIdle();
      if (scenario !== "no warning")
        expect.soft(f.recorder.files[0]).not.toContainEqual(beforeOk);
      const viewer: OverlayState[] = [];
      f.publisher.connect((state) => viewer.push(state));
      f.source.emit(ok(3)); // A delayed OK from before the capture resumed.
      f.source.emit(pulse(6, 85));
      f.source.emit({
        kind: "breathingRate",
        reading: { t: at(6), value: 16, stable: true, confidence: 90 },
      });
      f.source.emit(
        wave("pulseWave", [
          [6, 1],
          [6.5, 2],
        ]),
      );
      f.source.emit(
        wave("breathingWave", [
          [6, 1],
          [6.5, 2],
        ]),
      );
      await f.session.whenIdle();
      expect(viewer.length).toBeGreaterThan(0);
      for (const state of viewer) {
        expect.soft(state).toMatchObject({
          pulseBpm: null,
          breathingRate: null,
          beatWave: [],
          breathWave: [],
        });
      }

      f.source.emit(ok(7));
      await f.session.whenIdle();
      expect(viewer.at(-1)).toMatchObject({
        pulseBpm: null,
        breathingRate: null,
        beatWave: [],
        breathWave: [],
      });
      f.source.emit(pulse(19, 86));
      await f.session.whenIdle();
      expect(viewer.at(-1)).toMatchObject({ status: "live", pulseBpm: 86 });
      expect(f.session.panelState.pulse?.value).toBe(86);
    },
  );

  it("resumes warming from its previous progress after a gap without frames", async () => {
    const f = fixture();
    await f.session.startSession(start);
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame(pulse(7));
    await f.session.setPaused(true);
    await f.session.setPaused(false);
    await f.session.ingestFrame(pulse(100));
    expect(f.session.panelState).toMatchObject({
      phase: "warming",
      progress: { elapsedSeconds: 7 },
    });
    await f.session.ingestFrame(pulse(105));
    expect(f.session.panelState.phase).toBe("baselining");
  });

  it("auto-pauses at 60 seconds without further validation events and clears the reason on Resume", async () => {
    const f = fixture();
    f.clock.value = at(0);
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame({
      kind: "validation",
      t: at(0),
      code: "tooDark",
      hint: "More light",
    });
    f.clock.value = at(59.999999);
    await f.session.checkValidationTimeout();
    expect(f.session.panelState.pauseReason).toBeNull();
    f.clock.value = at(60);
    await f.session.checkValidationTimeout();
    expect(f.session.panelState).toMatchObject({
      pauseReason: "unusableInput",
      active: true,
      phase: "paused",
      recording: true,
    });
    expect(f.publisher.states.at(-1)).toMatchObject({ status: "paused" });
    await f.session.setPaused(false);
    f.clock.value = at(120);
    await f.session.checkValidationTimeout();
    expect(f.session.panelState.pauseReason).toBeNull();
    expect(f.source.starts).toBe(1);
    expect(f.recorder.stops).toBe(0);
  });

  it.each(["deadline first", "click first"] as const)(
    "keeps a displayed Pause click paused at the deadline (%s)",
    async (ordering) => {
      const f = fixture();
      f.clock.value = at(0);
      await f.session.startSession(start);
      await f.session.ingestFrame({
        kind: "validation",
        t: at(0),
        code: "tooDark",
        hint: "",
      });
      expect(f.session.panelState.pauseReason).toBeNull();
      f.clock.value = at(60);

      const pauseClick = () => f.session.setPaused(true);
      const deadline = () => f.session.checkValidationTimeout();
      await Promise.all(
        ordering === "deadline first"
          ? [deadline(), pauseClick()]
          : [pauseClick(), deadline()],
      );
      const reason = ordering === "deadline first" ? "unusableInput" : "manual";
      expect(f.session.panelState.pauseReason).toBe(reason);
      await pauseClick();
      expect(f.session.panelState.pauseReason).toBe(reason);
      expect(f.publisher.states.at(-1)).toMatchObject({ status: "paused" });
    },
  );

  it("requires continuous unusable input across changes of code and resets on OK", async () => {
    const f = fixture();
    await f.session.startSession(start);
    const validate = async (
      seconds: number,
      code: "tooDark" | "noFaceFound" | "ok",
    ) => {
      f.clock.value = at(seconds);
      await f.session.ingestFrame({
        kind: "validation",
        t: at(seconds),
        code,
        hint: "",
      });
    };
    await validate(0, "tooDark");
    await validate(45, "ok");
    await validate(50, "noFaceFound");
    await validate(60, "tooDark");
    expect(f.session.panelState.pauseReason).toBeNull();
    await validate(109, "noFaceFound");
    expect(f.session.panelState.pauseReason).toBeNull();
    await validate(110, "tooDark");
    expect(f.session.panelState.pauseReason).toBe("unusableInput");
  });

  it.each(["end", "off"] as const)(
    "ignores Resume once %s closes a paused session",
    async (command) => {
      const f = fixture();
      await f.session.startSession(start);
      await f.session.setPaused(true);
      if (command === "end") await f.session.stopSession();
      else await f.session.setPrivacyMode("off");
      await f.session.setPaused(false);
      await f.session.checkValidationTimeout();
      expect(f.session.panelState).toMatchObject({
        active: false,
        pauseReason: null,
      });
      expect(f.source.starts).toBe(1);
      expect(f.source.stops).toBe(1);
      expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
    },
  );

  it("stops idempotently, finalizes recording and retains highlights for export", async () => {
    const f = fixture({ policy: quickPolicy });
    await f.session.startSession({ ...start, recordingEnabled: true });
    await f.session.ingestFrame(pulse(0));
    await pulses(f.session, 1, 2, 82);
    await f.session.stopSession();
    await f.session.stopSession();
    expect(f.source.stops).toBe(1);
    expect(f.source.listeners.size).toBe(0);
    expect(f.recorder.stops).toBe(1);
    expect(f.recorder.files[0]).toHaveLength(4);
    expect(f.recorder.files[0]?.at(-1)).toEqual({
      kind: "end",
      durationUs: 2_000_000,
    });
    expect(f.session.panelState).toMatchObject({
      active: false,
      phase: null,
      recording: false,
      pulse: null,
    });
    expect(f.session.panelState.highlights).toEqual(f.highlights.items);
    expect(f.publisher.states.at(-1)).toEqual({ mode: "off", replay: false });
  });

  it("every Vibe publication has only animation fields despite complete streamer readings", async () => {
    const f = fixture({ policy: quickPolicy, replay: true });
    await f.session.startSession({ ...start, privacyMode: "numbers" });
    await f.session.ingestFrame(pulse(0));
    await f.session.ingestFrame({
      kind: "breathingRate",
      reading: { t: at(0), value: 16, confidence: 99, stable: true },
    });
    await f.session.setPrivacyMode("vibe");
    await f.session.ingestFrame(
      wave("pulseWave", [
        [0.1, -100],
        [0.2, 100],
      ]),
    );
    await f.session.ingestFrame(
      wave("breathingWave", [
        [0.1, 1000],
        [0.3, 1001],
      ]),
    );
    await pulses(f.session, 1, 2, 82);
    await f.session.setPaused(true);
    await f.session.setPaused(false);
    await f.session.ingestFrame(pulse(3, 150));
    await f.session.setPrivacyMode("highlightsOnly");
    await f.session.ingestFrame(pulse(4));
    await f.session.stopSession();
    const vibeStates = f.publisher.attempts.filter(
      (state) => state.mode === "vibe",
    );
    expect(vibeStates.length).toBeGreaterThan(5);
    for (const state of vibeStates) {
      expect(Object.keys(state).sort()).toEqual([
        "beatWave",
        "breathWave",
        "intensity",
        "mode",
        "replay",
        "status",
      ]);
      for (const point of [...state.beatWave, ...state.breathWave]) {
        expect(Object.keys(point).sort()).toEqual(["atMs", "v"]);
        expect(point.atMs).toBeGreaterThanOrEqual(0);
        expect(point.atMs).toBeLessThan(10_000);
        expect(point.v).toBeGreaterThanOrEqual(0);
        expect(point.v).toBeLessThanOrEqual(1);
      }
      expect(JSON.stringify(state)).not.toMatch(
        /pulse|bpm|breathingRate|confidence|stable|baseline|delta|talking/iu,
      );
    }
    expect(
      f.panels.some(
        (state) => state.baselineBpm === 70 && state.highlights.length > 0,
      ),
    ).toBe(true);
    expect(
      f.publisher.states.find((state) => state.mode === "highlightsOnly"),
    ).toEqual({ mode: "highlightsOnly", replay: true });
  });
});
