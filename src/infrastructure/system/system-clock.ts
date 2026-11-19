import type { Clock } from "../../application/ports/clock";

/** Epoch microseconds match the live SDK's measurement timestamps. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now() * 1000;
  }
}
