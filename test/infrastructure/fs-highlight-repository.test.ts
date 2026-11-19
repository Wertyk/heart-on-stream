import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Highlight } from "../../src/domain/session/index";
import { FsHighlightRepository } from "../../src/infrastructure/storage/fs-highlight-repository";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const sessionStartedAt = 1_800_000_000_000_000;

function highlight(index: number): Highlight {
  return {
    t: sessionStartedAt + index * 1_000_000,
    sessionStartedAt,
    sessionOffsetUs: index * 1_000_000,
    recordingOffsetMs: index === 0 ? null : index * 1_000,
    label: `💓 spike +${10 + index} vs baseline`,
    deltaBpm: 10 + index,
    talkingRecent: index % 2 === 0,
  };
}

describe("FsHighlightRepository", () => {
  let directory: string;
  let path: string;
  let repository: FsHighlightRepository;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "heart-on-stream-highlights-"));
    path = join(directory, "highlights.json");
    repository = new FsHighlightRepository(directory);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("tolerates a missing file or directory without creating anything", async () => {
    expect(await repository.list()).toEqual([]);
    await repository.deleteAll();
    const absent = new FsHighlightRepository(join(directory, "not-created"));
    expect(await absent.list()).toEqual([]);
    await absent.deleteAll();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("round trips every highlight field across instances and sessions", async () => {
    const highlights: Highlight[] = [
      { ...highlight(2), recordingOffsetMs: 0 },
      highlight(0),
      {
        ...highlight(3),
        t: sessionStartedAt + 90_000_000,
        sessionStartedAt: sessionStartedAt + 80_000_000,
        sessionOffsetUs: 10_000_000,
        deltaBpm: 13.5,
      },
    ];
    for (const item of highlights) await repository.append(item);
    const restarted = new FsHighlightRepository(directory);
    expect(await restarted.list()).toEqual(highlights);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual(highlights);
    await restarted.append(highlight(4));
    expect(await repository.list()).toEqual([...highlights, highlight(4)]);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it("creates a missing userData directory only on append", async () => {
    const nested = join(directory, "nested", "userData");
    const adapter = new FsHighlightRepository(nested);
    expect(await fs.readdir(directory)).toEqual([]);
    await adapter.append(highlight(0));
    expect(await new FsHighlightRepository(nested).list()).toEqual([
      highlight(0),
    ]);
  });

  it("serializes concurrent appends in invocation order", async () => {
    const highlights = Array.from({ length: 30 }, (_, index) =>
      highlight(index),
    );
    await Promise.all(highlights.map((item) => repository.append(item)));
    expect(await repository.list()).toEqual(highlights);
  });

  it("fills only the newest matching receipt and never falls back to an older match", async () => {
    const original = highlight(0);
    const replayed = { ...original, label: "Replayed spike" };
    const otherSession = {
      ...original,
      sessionStartedAt: sessionStartedAt - 1_000_000,
      sessionOffsetUs: 1_000_000,
    };
    const results = await Promise.all([
      repository.append(original),
      repository.append(replayed),
      repository.append(otherSession),
      repository.updateRecordingOffset(original, 0),
      repository.updateRecordingOffset(original, 20_000),
    ]);
    expect(results).toEqual([undefined, undefined, undefined, true, false]);
    expect(await new FsHighlightRepository(directory).list()).toEqual([
      original,
      { ...replayed, recordingOffsetMs: 0 },
      otherSession,
    ]);
  });

  it("does not write a file for an offset update queued after deletion", async () => {
    const original = highlight(0);
    await repository.append(original);
    const deleted = repository.deleteAll();
    const updated = repository.updateRecordingOffset(original, 20_000);
    await deleted;
    expect(await updated).toBe(false);
    expect(await repository.list()).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("snapshots queued input and returns detached values", async () => {
    const item = { ...highlight(1) };
    const pending = repository.append(item);
    item.label = "Changed by caller";
    await pending;
    const stored = await repository.list();
    expect(stored).toEqual([highlight(1)]);
    Object.assign(stored[0] ?? {}, { label: "Changed by reader" });
    expect(await repository.list()).toEqual([highlight(1)]);
  });

  it("replaces the file atomically, leaving an open reader on the previous complete file", async () => {
    await repository.append(highlight(0));
    const previous = await fs.open(path, "r");
    try {
      await repository.append(highlight(1));
      expect(JSON.parse(await previous.readFile("utf8"))).toEqual([
        highlight(0),
      ]);
      expect(await repository.list()).toEqual([highlight(0), highlight(1)]);
      expect((await previous.stat()).ino).not.toBe((await fs.stat(path)).ino);
      expect(await fs.readdir(directory)).toEqual(["highlights.json"]);
    } finally {
      await previous.close();
    }
  });

  it("keeps previous receipts on failed rename, cleans temp data and permits retry", async () => {
    await repository.append(highlight(0));
    const before = await fs.readFile(path, "utf8");
    const error = new Error("Injected rename failure");
    vi.mocked(fs.rename).mockRejectedValueOnce(error);
    await expect(repository.append(highlight(1))).rejects.toBe(error);
    expect(await fs.readFile(path, "utf8")).toBe(before);
    expect(await fs.readdir(directory)).toEqual(["highlights.json"]);
    expect(await repository.list()).toEqual([highlight(0)]);
    await repository.append(highlight(2));
    expect(await repository.list()).toEqual([highlight(0), highlight(2)]);
  });

  it.each([
    "{",
    "{}",
    "[null]",
    JSON.stringify([[]]),
    JSON.stringify([{ ...highlight(0), t: -1 }]),
    JSON.stringify([{ ...highlight(0), t: 1.5 }]),
    JSON.stringify([{ ...highlight(0), sessionStartedAt: "invalid" }]),
    JSON.stringify([
      { ...highlight(0), sessionStartedAt: Number.MAX_SAFE_INTEGER + 1 },
    ]),
    JSON.stringify([{ ...highlight(0), sessionOffsetUs: -1 }]),
    JSON.stringify([{ ...highlight(0), recordingOffsetMs: "00:10" }]),
    JSON.stringify([{ ...highlight(0), recordingOffsetMs: -1 }]),
    JSON.stringify([{ ...highlight(0), label: "  " }]),
    JSON.stringify([{ ...highlight(0), deltaBpm: null }]),
    JSON.stringify([{ ...highlight(0), talkingRecent: "false" }]),
    JSON.stringify([{ ...highlight(0), sessionStartedAt: undefined }]),
    JSON.stringify([{ ...highlight(0), recordingOffsetMs: undefined }]),
    JSON.stringify([{ ...highlight(0), image: "unexpected extra field" }]),
  ])(
    "rejects corrupt or invalid stored data without overwriting it: %s",
    async (contents) => {
      await fs.writeFile(path, contents, "utf8");
      await expect(repository.list()).rejects.toThrow(
        `Invalid highlights file '${path}'`,
      );
      await expect(repository.append(highlight(1))).rejects.toThrow(
        "Invalid highlights file",
      );
      expect(await fs.readFile(path, "utf8")).toBe(contents);
      // Explicit deletion remains possible even if receipts cannot be decoded.
      await repository.deleteAll();
      expect(await repository.list()).toEqual([]);
    },
  );

  it("rejects invalid appended metadata and extra fields before writing", async () => {
    for (const item of [
      { ...highlight(0), deltaBpm: Number.NaN },
      { ...highlight(0), deltaBpm: Number.POSITIVE_INFINITY },
      { ...highlight(0), recordingOffsetMs: Number.POSITIVE_INFINITY },
      { ...highlight(0), video: "unexpected" },
    ]) {
      await expect(repository.append(item)).rejects.toThrow();
    }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("surfaces filesystem errors without treating them as missing data", async () => {
    await fs.mkdir(path);
    await expect(repository.list()).rejects.toThrow(
      "Could not read highlights file",
    );
    await expect(repository.append(highlight(0))).rejects.toThrow(
      "Could not read highlights file",
    );
    await expect(repository.deleteAll()).rejects.toThrow();
    await fs.rm(path, { recursive: true });
    await repository.append(highlight(0));
    expect(await repository.list()).toEqual([highlight(0)]);
  });

  it("deletes persisted receipts and interrupted temp files idempotently, retaining unrelated files", async () => {
    await repository.append(highlight(0));
    const orphan = `highlights.json.${randomUUID()}.tmp`;
    await fs.writeFile(join(directory, orphan), JSON.stringify([highlight(1)]));
    await fs.writeFile(join(directory, "session-unrelated.jsonl"), "unrelated");
    await fs.writeFile(join(directory, "chapters-unrelated.txt"), "unrelated");
    const restarted = new FsHighlightRepository(directory);
    await restarted.deleteAll();
    await restarted.deleteAll();
    expect(await fs.readdir(directory)).toEqual([
      "chapters-unrelated.txt",
      "session-unrelated.jsonl",
    ]);
    expect(await repository.list()).toEqual([]);
    await expect(fs.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("orders deletion with queued appends, reads and subsequent reuse", async () => {
    const [, before, , after] = await Promise.all([
      repository.append(highlight(0)),
      repository.list(),
      repository.deleteAll(),
      repository.list(),
      repository.append(highlight(1)),
    ]);
    expect(before).toEqual([highlight(0)]);
    expect(after).toEqual([]);
    expect(await repository.list()).toEqual([highlight(1)]);
  });

  it("preserves malformed temp names the atomic writer cannot generate", async () => {
    const names = [
      "highlights.json.00000000-0000-4000-8000-000000000000.tmp",
      "highlights.json.000000000000-4000-8000-0000000000000.tmp",
      "highlights.json.00000000-0000-3000-8000-000000000000.tmp",
      "highlights.json.00000000-0000-4000-7000-000000000000.tmp",
      "highlights.json.A0000000-0000-4000-8000-000000000000.tmp",
    ];
    await Promise.all(
      names.map((name) => fs.writeFile(join(directory, name), "unrelated")),
    );
    await repository.deleteAll();
    expect((await fs.readdir(directory)).sort()).toEqual(names.slice(1).sort());
  });
});
