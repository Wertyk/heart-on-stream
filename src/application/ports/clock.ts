import type { TimestampUs } from "../../domain/signal/index";

/**
 * Supplies epoch microseconds for deadlines and intervals without source events.
 * Reads are synchronous and do not throw. Signal processing uses SDK timestamps.
 */
export interface Clock {
  now(): TimestampUs;
}
