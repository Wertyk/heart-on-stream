import { resolve } from "node:path";

/** Replay argument errors are shown in the panel at startup. Options travel through Electron's lock as plain data. */
export interface LaunchOptions {
  readonly replay: boolean;
  readonly record: boolean;
  readonly file: string | null;
  readonly speed: number;
  readonly loop: boolean;
  readonly error: string;
}

/** Parses application arguments only (without the Electron executable/app path). */
export function parseLaunchOptions(args: readonly string[]): LaunchOptions {
  const replay = args.includes("--replay");
  let file: string | null = null;
  let speed = 1;
  let loop = false;
  let error = "";
  let speedSeen = false;
  for (const arg of args) {
    if (arg === "--" || arg === "--replay" || arg === "--record") continue;
    if (arg === "--loop") {
      loop = true;
      continue;
    }
    if (arg.startsWith("--speed=")) {
      const value = arg.slice("--speed=".length);
      if (
        speedSeen ||
        !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) ||
        !Number.isFinite(Number(value)) ||
        Number(value) < 0.25 ||
        Number(value) > 20
      )
        error =
          "Replay speed must be a number between 0.25 and 20 (--speed=2).";
      else speed = Number(value);
      speedSeen = true;
      continue;
    }
    if (arg.startsWith("--"))
      error = "Unknown replay option. Use --speed=<factor> or --loop.";
    else if (file !== null) error = "Provide exactly one replay file.";
    else file = arg;
  }
  if (replay && !file && !error)
    error = "Choose a replay file: pnpm replay -- <file.jsonl>.";
  return {
    replay,
    record: !replay && args.includes("--record"),
    file,
    speed,
    loop,
    error,
  };
}

/** Check the shape of the options delivered by Electron's lock. */
export function isLaunchOptions(
  additionalData: unknown,
): additionalData is LaunchOptions {
  if (typeof additionalData !== "object" || additionalData === null)
    return false;
  const { replay, record, file, speed, loop, error } =
    additionalData as Partial<Record<keyof LaunchOptions, unknown>>;
  return (
    typeof error === "string" &&
    typeof replay === "boolean" &&
    typeof record === "boolean" &&
    (file === null || typeof file === "string") &&
    typeof speed === "number" &&
    Number.isFinite(speed) &&
    typeof loop === "boolean"
  );
}

/** Compare effective options for a valid relaunch. */
export function hasDifferentLaunchOptions(
  running: LaunchOptions,
  requested: LaunchOptions,
  workingDirectory: string,
): boolean {
  if (running.replay !== requested.replay) return true;
  if (!requested.replay) return running.record !== requested.record;
  const runningFile = running.file === null ? null : resolve(running.file);
  const requestedFile =
    requested.file === null ? null : resolve(workingDirectory, requested.file);
  return (
    running.error !== "" ||
    runningFile !== requestedFile ||
    running.speed !== requested.speed ||
    running.loop !== requested.loop
  );
}
