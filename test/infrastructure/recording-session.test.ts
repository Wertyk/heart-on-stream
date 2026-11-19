import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJsonlSession } from "../../src/infrastructure/replay/jsonl-session";
import { PerSessionRecorder } from "../../src/infrastructure/replay/per-session-recorder";
import { shouldRecordSession } from "../../src/infrastructure/replay/recording-session";

describe("recording opt-in decision", () => {
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])("flag=%s, toggle=%s records=%s", (flag, toggle, expected) => {
    expect(shouldRecordSession(flag, toggle)).toBe(expected);
  });
});

describe("per-session recorder", () => {
  let directory: string;
  let recorder: PerSessionRecorder;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "hos-per-session-"));
  });
  afterEach(async () => {
    await recorder?.stop();
    await rm(directory, { recursive: true, force: true });
  });
  function fixture(output = join(directory, "recordings")) {
    let startTimeUs = 1_794_873_600_000_000;
    const metadata = vi.fn(() => ({
      appVersion: "test",
      metricConfig: "synthetic (development only)",
      startTimeUs: startTimeUs++,
    }));
    recorder = new PerSessionRecorder(output, metadata);
    return { output, metadata };
  }
  it("does no I/O before opt-in and rejects append before Start", async () => {
    const f = fixture();
    expect(recorder.filePath).toBeNull();
    expect(f.metadata).not.toHaveBeenCalled();
    await expect(
      recorder.append({ kind: "processing", status: "running", t: 1 }),
    ).rejects.toThrow("not started");
    await recorder.stop();
    await recorder.deleteAll();
    expect(await readdir(directory)).toEqual([]);
  });
  it("creates a fresh file and metadata per Start, queues frames, flushes Stop, and retains the last path", async () => {
    const f = fixture();
    const frames = Array.from(
      { length: 30 },
      (_, t) => ({ kind: "processing", status: "running", t }) as const,
    );
    await recorder.start();
    const first = recorder.filePath;
    await expect(recorder.start()).rejects.toThrow("already started");
    await Promise.all([
      ...frames.map((frame) => recorder.append(frame)),
      recorder.stop(),
      recorder.stop(),
    ]);
    expect(
      decodeJsonlSession(await readFile(first ?? "", "utf8")).frames,
    ).toEqual(frames);
    expect(recorder.filePath).toBe(first);
    await recorder.start();
    const second = recorder.filePath;
    expect(second).not.toBe(first);
    await recorder.stop();
    const a = decodeJsonlSession(await readFile(first ?? "", "utf8"));
    const b = decodeJsonlSession(await readFile(second ?? "", "utf8"));
    expect(b.header.startTimeUs).toBe(a.header.startTimeUs + 1);
    expect(b.header.metricConfig).toBe("synthetic (development only)");
    expect(b.frames).toEqual([]);
    expect(await readdir(f.output)).toHaveLength(2);
    expect(f.metadata).toHaveBeenCalledTimes(2);
  });
  it("deletes current and historical app recordings while preserving foreign files", async () => {
    const f = fixture();
    await mkdir(f.output);
    const uuid = "12345678-1234-4234-8234-123456789abc";
    await writeFile(join(f.output, `session-${uuid}.jsonl`), "historical");
    await writeFile(
      join(f.output, `session-2026-11-16T20-00-00.000Z-${uuid}.jsonl`),
      "earlier",
    );
    const foreign = [
      "notes.jsonl",
      "session-earlier.jsonl",
      "session-interview.jsonl",
      "session-keep.txt",
      `session-2026-02-30T20-00-00.000Z-${uuid}.jsonl`,
      `session-${uuid}-copy.jsonl`,
    ];
    for (const name of foreign) await writeFile(join(f.output, name), "keep");
    const matchingDirectory =
      "session-12345678-1234-4234-8234-123456789abd.jsonl";
    const matchingLink = "session-12345678-1234-4234-8234-123456789abe.jsonl";
    await mkdir(join(f.output, matchingDirectory));
    const outside = join(directory, "session-outside.jsonl");
    await writeFile(outside, "outside");
    await symlink(outside, join(f.output, matchingLink));
    await recorder.start();
    await recorder.append({ kind: "processing", status: "running", t: 1 });
    await recorder.deleteAll();
    await recorder.deleteAll();
    expect(recorder.filePath).toBeNull();
    expect((await readdir(f.output)).sort()).toEqual(
      [...foreign, matchingDirectory, matchingLink].sort(),
    );
    expect(await readFile(outside, "utf8")).toBe("outside");
    for (const name of foreign)
      expect(await readFile(join(f.output, name), "utf8")).toBe("keep");
    await recorder.start();
    await recorder.stop();
  });
  it("recovers after a failed Start without claiming an active file", async () => {
    const output = join(directory, "blocked");
    await writeFile(output, "keep");
    fixture(output);
    await expect(recorder.start()).rejects.toThrow();
    expect(recorder.filePath).toBeNull();
    await recorder.stop();
    await rm(output);
    await recorder.start();
    await recorder.stop();
    expect(recorder.filePath).not.toBeNull();
  });
});
