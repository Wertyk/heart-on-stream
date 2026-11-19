import type { SessionRecord } from "../../domain/session/index";

/**
 * Supplies normalized frames from live IPC or replay, including replay's end record.
 * Subscribe before start; subscriptions survive stop/start until unsubscribed.
 * Start/stop reject on adapter failure; callers surface the failure to the panel.
 * Stop must release capture/playback resources and may be called repeatedly.
 */
export interface SignalSource {
  /**
   * Live sources pass the capture generation that produced each record, so the
   * session can ignore records from a capture it has already replaced. Replay omits it.
   */
  subscribe(
    onRecord: (record: SessionRecord, captureGeneration?: number) => void,
  ): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Replay can freeze and continue its timeline without emitting capture boundaries. */
  pause?(): void;
  resume?(): void;
}
