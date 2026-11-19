import { resolve } from "node:path";
import { atomicWriteText } from "./atomic-write";

export interface ChapterTextWriteOptions {
  readonly sessionStartedAt: number;
  /** A save-dialog destination; otherwise use the composition's userData path. */
  readonly path?: string;
}

/** Persists only the successful ExportChapters result's text, without transforming it. */
export class ChapterTextWriter {
  constructor(private readonly directory: string) {}

  async write(text: string, options: ChapterTextWriteOptions): Promise<string> {
    if (
      !Number.isSafeInteger(options.sessionStartedAt) ||
      options.sessionStartedAt < 0
    ) {
      throw new Error("Chapter export requires a valid session start time");
    }
    const path =
      options.path === undefined
        ? resolve(this.directory, `chapters-${options.sessionStartedAt}.txt`)
        : resolve(options.path);
    await atomicWriteText(path, text);
    return path;
  }
}
