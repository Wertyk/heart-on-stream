import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionRecorder } from "../../src/application/ports/index";
import type { SignalFrame } from "../../src/domain/signal/index";
import { decodeJsonlSession } from "../../src/infrastructure/replay/jsonl-session";
import { JsonlSessionRecorder } from "../../src/infrastructure/replay/jsonl-session-recorder";
import {
  mapMetrics,
  mapProcessingEvent,
  mapValidationEvent,
} from "../../src/infrastructure/smartspectra/metrics-mapper";
import { decodedMetricsFixture, fixtureStartUs } from "./metrics-fixture";

const metadata = {
  appVersion: "0.1.0",
  metricConfig: "pulse-and-breathing",
  startTimeUs: fixtureStartUs,
};

describe("JsonlSessionRecorder", () => {
  let directory: string;
  let recorder: SessionRecorder;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "heart-on-stream-recorder-"));
    recorder = new JsonlSessionRecorder(directory, metadata);
  });

  afterEach(async () => {
    await recorder.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("performs no I/O before start and rejects append before start or after stop", async () => {
    const output = join(directory, "not-created");
    const disabled = new JsonlSessionRecorder(output, metadata);
    const frame = mapProcessingEvent(3, fixtureStartUs);
    await expect(disabled.append(frame)).rejects.toThrow("not been started");
    await disabled.stop();
    await disabled.deleteAll();
    expect(await readdir(directory)).toEqual([]);
    await recorder.start();
    await recorder.stop();
    const [filename] = await readdir(directory);
    const before = await readFile(join(directory, filename ?? ""), "utf8");
    await expect(recorder.append(frame)).rejects.toThrow("not been started");
    expect(await readFile(join(directory, filename ?? ""), "utf8")).toBe(
      before,
    );
    expect(decodeJsonlSession(before).frames).toEqual([]);
  });

  it("writes then reads equal SDK-derived frames of every kind", async () => {
    const frames = [
      mapProcessingEvent(3, fixtureStartUs),
      mapValidationEvent(0, fixtureStartUs, "Ready.\nKeep still."),
      ...mapMetrics(decodedMetricsFixture()),
    ];
    await recorder.start();
    for (const frame of frames) await recorder.append(frame);
    await recorder.stop();
    await recorder.stop();
    const filenames = await readdir(directory);
    expect(filenames).toHaveLength(1);
    const contents = await readFile(
      join(directory, filenames[0] ?? ""),
      "utf8",
    );
    expect(decodeJsonlSession(contents)).toEqual({
      header: { format: "heart-on-stream", version: 2, ...metadata },
      frames,
    });
  });

  it("serializes concurrent start, appends and stop in invocation order", async () => {
    const frames: SignalFrame[] = Array.from({ length: 100 }, (_, index) => ({
      kind: "talking",
      t: fixtureStartUs + index,
      detected: index % 2 === 0,
      stable: true,
    }));
    const records = [...frames, { kind: "end", durationUs: 100 } as const];
    await Promise.all([
      recorder.start(),
      ...records.map((record) => recorder.append(record)),
      expect(
        recorder.append({
          kind: "capture",
          t: fixtureStartUs,
          state: "paused",
        }),
      ).rejects.toThrow("end record has already been written"),
      recorder.stop(),
    ]);
    const [filename] = await readdir(directory);
    expect(
      decodeJsonlSession(
        await readFile(join(directory, filename ?? ""), "utf8"),
      ).frames,
    ).toEqual(records);
  });

  it("rejects invalid or media-bearing frames without writing and snapshots queued input", async () => {
    await recorder.start();
    const frame = {
      kind: "talking" as const,
      t: 1,
      detected: false,
      stable: true,
    };
    const append = recorder.append(frame);
    frame.t = 999;
    await append;
    await expect(
      recorder.append({ ...frame, image: "unexpected" } as SignalFrame),
    ).rejects.toThrow("unexpected field 'image'");
    await expect(
      recorder.append({ kind: "processing", status: "idle", t: Number.NaN }),
    ).rejects.toThrow("finite");
    await recorder.stop();
    const [filename] = await readdir(directory);
    expect(
      decodeJsonlSession(
        await readFile(join(directory, filename ?? ""), "utf8"),
      ).frames,
    ).toEqual([{ kind: "talking", t: 1, detected: false, stable: true }]);
  });

  it("enforces drain placement in append order and allows a new boundary after restart", async () => {
    const drain = { kind: "drain" } as const;
    const tail = mapProcessingEvent(1, fixtureStartUs);
    const end = { kind: "end", durationUs: 0 } as const;
    await Promise.all([
      recorder.start(),
      recorder.append(drain),
      expect(recorder.append(drain)).rejects.toThrow(
        "duplicate drain boundary",
      ),
      expect(
        recorder.append({
          kind: "capture",
          t: fixtureStartUs,
          state: "resumed",
        }),
      ).rejects.toThrow("capture record after drain boundary"),
      recorder.append(tail),
      recorder.append(end),
      expect(recorder.append(drain)).rejects.toThrow(
        "end record has already been written",
      ),
      recorder.stop(),
    ]);
    const [filename] = await readdir(directory);
    expect(
      decodeJsonlSession(
        await readFile(join(directory, filename ?? ""), "utf8"),
      ).frames,
    ).toEqual([drain, tail, end]);
    await recorder.start();
    await recorder.append(drain);
  });

  it("rejects duplicate start, permits restart, and deletes only files this instance created", async () => {
    const foreignPath = join(directory, "session-someone-else.jsonl");
    await writeFile(foreignPath, "unrelated contents", "utf8");
    const other = new JsonlSessionRecorder(directory, metadata);
    await other.start();
    await other.stop();
    await recorder.start();
    await expect(recorder.start()).rejects.toThrow("already started");
    await recorder.stop();
    await recorder.start();
    expect(await readdir(directory)).toHaveLength(4);
    // Deletion also flushes and closes the currently active recording.
    await recorder.deleteAll();
    await recorder.deleteAll();
    expect(await readdir(directory)).toHaveLength(2);
    expect(await readFile(foreignPath, "utf8")).toBe("unrelated contents");
    await expect(
      recorder.append(mapProcessingEvent(1, fixtureStartUs)),
    ).rejects.toThrow("not been started");
    await other.deleteAll();
    expect(await readdir(directory)).toEqual(["session-someone-else.jsonl"]);
  });

  it("reports filesystem failures and keeps cleanup and retry available", async () => {
    const blockedPath = join(directory, "file-instead-of-directory");
    await writeFile(blockedPath, "unrelated", "utf8");
    const failing = new JsonlSessionRecorder(blockedPath, metadata);
    await expect(failing.start()).rejects.toThrow();
    await failing.stop();
    await failing.deleteAll();
    expect(await readFile(blockedPath, "utf8")).toBe("unrelated");
    await rm(blockedPath);
    await failing.start();
    await failing.append(mapProcessingEvent(3, fixtureStartUs));
    await failing.stop();
    expect(await readdir(blockedPath)).toHaveLength(1);
    await failing.deleteAll();
    expect(await readdir(blockedPath)).toEqual([]);
  });
});
