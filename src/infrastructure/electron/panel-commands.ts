import { join } from "node:path";
import type { StreamSession } from "../../application/use-cases/stream-session";
import type { Highlight } from "../../domain/session/index";
import type { PanelCommandResult } from "../../shared/ipc-contract";
import {
  formatHighlightList,
  type RecordingDurationResult,
} from "./session-export";

function exportFilename(
  kind: "chapters" | "highlights",
  startedAtUs: number,
): string {
  const start = new Date(startedAtUs / 1_000);
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  const date = `${start.getFullYear()}-${twoDigits(start.getMonth() + 1)}-${twoDigits(start.getDate())}`;
  const time = `${twoDigits(start.getHours())}${twoDigits(start.getMinutes())}`;
  return `heart-on-stream-${kind}-${date}-${time}.txt`;
}

/** Keep native dialogs, clipboard and file writes outside the renderer and use cases. */
export function createPanelCommands(options: {
  stream: Pick<StreamSession, "exportChapters" | "deleteAllData">;
  session(): {
    readonly startedAt: number | null;
    readonly durationMs: number;
    readonly highlights: readonly Highlight[];
  };
  recordingDurationMs?(
    highlights: readonly Highlight[],
  ): Promise<RecordingDurationResult>;
  userData: string;
  overlayUrl: string;
  writeClipboard(text: string): void;
  saveDialog(
    defaultPath: string,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  writer: {
    write(
      text: string,
      options: { sessionStartedAt: number; path?: string },
    ): Promise<string>;
  };
}) {
  function session() {
    const current = options.session();
    return {
      ...current,
      highlights: current.highlights.filter(
        (highlight) => highlight.sessionStartedAt === current.startedAt,
      ),
    };
  }
  async function saveText(
    text: string,
    startedAt: number,
    kind: "chapters" | "highlights",
  ): Promise<PanelCommandResult> {
    const defaultPath = join(options.userData, exportFilename(kind, startedAt));
    const destination = await options.saveDialog(defaultPath);
    if (destination.canceled)
      return {
        ok: false,
        message:
          kind === "chapters"
            ? "Chapter export canceled."
            : "Highlight list save canceled.",
      };
    const path = await options.writer.write(text, {
      sessionStartedAt: startedAt,
      path: destination.filePath || defaultPath,
    });
    return {
      ok: true,
      path,
      message: `${kind === "chapters" ? "Chapters" : "Highlight list"} saved to ${path}`,
    };
  }
  return {
    async copyOverlayUrl(): Promise<PanelCommandResult> {
      if (!options.overlayUrl)
        return { ok: false, message: "The overlay URL is unavailable." };
      try {
        options.writeClipboard(options.overlayUrl);
        return { ok: true, message: "Overlay URL copied." };
      } catch {
        return { ok: false, message: "Unable to copy the overlay URL." };
      }
    },
    async exportChapters(): Promise<PanelCommandResult> {
      const current = session();
      if (current.startedAt === null || current.highlights.length === 0)
        return { ok: false, message: "No highlights in this session." };
      try {
        const duration = await options.recordingDurationMs?.(
          current.highlights,
        );
        if (duration && !duration.ok) {
          return {
            ok: false,
            message:
              duration.reason === "mixedRecordings"
                ? "Highlights span several OBS recordings. Save the highlight list to keep every timestamp."
                : "The OBS recording timeline was replaced. Save the highlight list to keep every timestamp.",
          };
        }
        const recordingDurationMs = duration?.durationMs;
        const result = await options.stream.exportChapters({
          sessionStartedAt: current.startedAt,
          sessionDurationMs: current.durationMs,
          ...(recordingDurationMs === undefined ? {} : { recordingDurationMs }),
        });
        if (!result.ok) {
          const messages = {
            no_highlights: "No highlights in this session.",
            insufficient_chapters:
              "Too few chapters. YouTube needs at least three chapters, including Intro, spaced at least 10 seconds apart. Save the highlight list to keep every timestamp.",
            invalid_duration:
              "Chapter duration could not be determined. Save the highlight list to keep every timestamp.",
            invalid_offset: "Chapter times could not be exported.",
            invalid_label: "Chapter labels could not be exported.",
          };
          return { ok: false, message: messages[result.reason] };
        }
        return await saveText(result.text, current.startedAt, "chapters");
      } catch {
        return {
          ok: false,
          message:
            "Unable to export chapters. Check the destination and file permissions.",
        };
      }
    },
    async saveHighlightList(): Promise<PanelCommandResult> {
      const current = session();
      if (current.startedAt === null || current.highlights.length === 0)
        return { ok: false, message: "No highlights in this session." };
      try {
        return await saveText(
          formatHighlightList(current.highlights),
          current.startedAt,
          "highlights",
        );
      } catch {
        return {
          ok: false,
          message:
            "Unable to save the highlight list. Check the destination and file permissions.",
        };
      }
    },
    async deleteAllData(): Promise<PanelCommandResult> {
      try {
        await options.stream.deleteAllData();
        return {
          ok: true,
          message:
            "All stored highlights and app session recordings deleted. Exported text files remain at your chosen destinations.",
        };
      } catch {
        return {
          ok: false,
          message:
            "Some stored data could not be deleted. Check file permissions and try again.",
        };
      }
    },
  };
}
