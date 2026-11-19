import type { SessionRecord } from "../../domain/session/index";

/**
 * Records normalized numeric/status frames for deterministic replay, never media.
 * Start is called only after explicit recording opt-in; append before start
 * rejects and must not write. Calls are awaited in delivery order. Stop flushes
 * and closes the output and is idempotent. I/O failures reject and are reported
 * without ending measurement. Delete removes recordings owned by this adapter.
 */
export interface SessionRecorder {
  start(): Promise<void>;
  append(record: SessionRecord): Promise<void>;
  stop(): Promise<void>;
  deleteAll(): Promise<void>;
}
