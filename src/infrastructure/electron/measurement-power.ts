interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** One blocker per window; repeated lifecycle notifications are harmless. */
export function measurementPower(blocker: PowerBlocker): {
  start(): void;
  stop(): void;
} {
  let id: number | null = null;
  return {
    start() {
      if (id === null) id = blocker.start("prevent-app-suspension");
    },
    stop() {
      if (id === null) return;
      blocker.stop(id);
      id = null;
    },
  };
}
