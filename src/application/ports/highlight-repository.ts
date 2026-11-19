import type { Highlight } from "../../domain/session/index";

export type HighlightIdentity = Pick<Highlight, "sessionStartedAt" | "t">;

/**
 * Owns local highlight receipts, serializing operations in invocation order.
 * I/O failures reject so the panel can report that a receipt was not persisted;
 * measurement continues. Delete is idempotent and removes all owned receipts.
 */
export interface HighlightRepository {
  /** Each run appends its own receipt, even when replay timestamps repeat. */
  append(highlight: Highlight): Promise<void>;
  /** Fills the newest matching receipt's unset offset. Returns true after a write. */
  updateRecordingOffset(
    identity: HighlightIdentity,
    recordingOffsetMs: number,
  ): Promise<boolean>;
  list(): Promise<readonly Highlight[]>;
  deleteAll(): Promise<void>;
}
