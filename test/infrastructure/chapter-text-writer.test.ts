import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChapterTextWriter } from "../../src/infrastructure/storage/chapter-text-writer";
import { at, fixture, highlight } from "../application/fakes";

describe("ChapterTextWriter", () => {
  let directory: string;
  let writer: ChapterTextWriter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "heart-on-stream-chapters-"));
    writer = new ChapterTextWriter(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a successful application ExportChapters result to the default session path", async () => {
    const f = fixture();
    f.highlights.items = [highlight(20), highlight(40)];
    const result = await f.session.exportChapters({
      sessionDurationMs: 60_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected valid chapter export");
    expect(await readdir(directory)).toEqual([]);
    const path = await writer.write(result.text, { sessionStartedAt: at(0) });
    expect(path).toBe(join(directory, `chapters-${at(0)}.txt`));
    expect(await readFile(path, "utf8")).toBe(result.text);
  });

  it("preserves supplied text exactly at a user-chosen path, creating its parent directory", async () => {
    const path = join(directory, "chosen", "my-chapters.txt");
    const text =
      "00:00 Intro\r\n00:20 💓 spike +12 vs baseline\r\n00:40 Next\r\n";
    expect(await writer.write(text, { sessionStartedAt: 123, path })).toBe(
      path,
    );
    expect(await readFile(path, "utf8")).toBe(text);
    expect(await readdir(join(directory, "chosen"))).toEqual([
      "my-chapters.txt",
    ]);
  });

  it("uses a deterministic default path and atomically replaces an earlier export", async () => {
    const firstPath = await writer.write("first text", {
      sessionStartedAt: 123,
    });
    const nextPath = await writer.write("replacement\n", {
      sessionStartedAt: 123,
    });
    expect(nextPath).toBe(firstPath);
    expect(await readFile(firstPath, "utf8")).toBe("replacement\n");
    expect(await readdir(directory)).toEqual(["chapters-123.txt"]);
  });

  it("reports write errors and removes temporary export data", async () => {
    const path = join(directory, "occupied.txt");
    await mkdir(path);
    await expect(
      writer.write("text", { sessionStartedAt: 123, path }),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["occupied.txt"]);
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "rejects invalid session timestamps before creating a file: %s",
    async (sessionStartedAt) => {
      await expect(writer.write("text", { sessionStartedAt })).rejects.toThrow(
        "valid session start time",
      );
      expect(await readdir(directory)).toEqual([]);
    },
  );
});
