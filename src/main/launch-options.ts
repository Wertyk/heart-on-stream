/** Invalid replay arguments are panel messages, never process-startup exceptions. */
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
