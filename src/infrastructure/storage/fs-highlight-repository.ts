import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  HighlightIdentity,
  HighlightRepository,
} from "../../application/ports/highlight-repository";
import type { Highlight } from "../../domain/session/index";
import { atomicWriteText } from "./atomic-write";
import { decodeHighlights, parseHighlight } from "./highlight-json";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * One composition-owned writer per userData directory. Operations serialize in
 * invocation order; each reads disk so a new instance needs no hydration step.
 * No I/O occurs until a port method is called.
 */
export class FsHighlightRepository implements HighlightRepository {
  private readonly path: string;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {
    this.path = join(directory, "highlights.json");
  }

  async append(highlight: Highlight): Promise<void> {
    const snapshot = parseHighlight(highlight);
    return this.enqueue(async () => {
      const highlights = await this.read();
      highlights.push(snapshot);
      await this.write(highlights);
    });
  }

  updateRecordingOffset(
    { sessionStartedAt, t }: HighlightIdentity,
    recordingOffsetMs: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const highlights = await this.read();
      for (let index = highlights.length - 1; index >= 0; index--) {
        const receipt = highlights[index];
        if (receipt?.sessionStartedAt !== sessionStartedAt || receipt.t !== t)
          continue;
        if (receipt.recordingOffsetMs !== null) return false;
        highlights[index] = parseHighlight({ ...receipt, recordingOffsetMs });
        await this.write(highlights);
        return true;
      }
      return false;
    });
  }

  list(): Promise<readonly Highlight[]> {
    return this.enqueue(() => this.read());
  }

  deleteAll(): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.path, { force: true });
      let names: string[];
      try {
        names = await readdir(this.directory);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      // Interrupted atomic writes can leave receipts in sibling temp files.
      for (const name of names) {
        if (
          /^highlights\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u.test(
            name,
          )
        ) {
          await rm(join(this.directory, name), { force: true });
        }
      }
    });
  }

  private write(highlights: readonly Highlight[]): Promise<void> {
    return atomicWriteText(
      this.path,
      `${JSON.stringify(highlights, null, 2)}\n`,
    );
  }

  private async read(): Promise<Highlight[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw new Error(`Could not read highlights file '${this.path}'`, {
        cause: error,
      });
    }
    try {
      return decodeHighlights(text);
    } catch (error) {
      throw new Error(`Invalid highlights file '${this.path}'`, {
        cause: error,
      });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }
}
