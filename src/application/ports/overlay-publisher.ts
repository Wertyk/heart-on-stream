import type { OverlayState } from "../../domain/privacy/index";

/**
 * Publishes only the domain's privacy projection to the loopback overlay.
 * Disconnected viewers are normal. Transport failures may reject, but must not
 * stop measurement, highlight persistence or later publication attempts.
 */
export interface OverlayPublisher {
  /** Replace the cached projection synchronously before any transport awaits. */
  publish(state: OverlayState): Promise<void>;
}
