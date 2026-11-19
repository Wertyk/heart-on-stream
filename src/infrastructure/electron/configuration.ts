import type { PublicConfiguration } from "../../shared/ipc-contract";

export interface MainConfiguration {
  readonly apiKey: string | null;
  readonly public: PublicConfiguration;
}

interface EnvironmentLoader {
  exists(): boolean;
  loadEnvFile(): void;
  environment(): Readonly<Record<string, string | undefined>>;
}

/** Injected file/environment access keeps tests away from local credentials. */
export function loadConfiguration(
  loader: EnvironmentLoader,
  replay: boolean,
  recordByDefault = false,
): MainConfiguration {
  if (replay) {
    return {
      apiKey: null,
      public: {
        canStart: true,
        recordByDefault: false,
        message:
          "REPLAY — Playback uses a saved session of numeric signal and status data. The camera and session recording stay off.",
      },
    };
  }

  try {
    if (loader.exists()) loader.loadEnvFile();
  } catch {
    return {
      apiKey: null,
      public: {
        canStart: false,
        recordByDefault,
        message: "Unable to load local configuration. Check .env and restart.",
      },
    };
  }

  const apiKey = loader.environment().SMARTSPECTRA_API_KEY?.trim() || null;
  return {
    apiKey,
    public: {
      canStart: apiKey !== null,
      recordByDefault,
      message: apiKey
        ? "Ready. Start requests camera access and begins measurement."
        : "SMARTSPECTRA_API_KEY is missing. Set it in .env and restart to enable Start. To try Heart on Stream without a key, run: pnpm replay -- samples/live-b-exertion-strong.jsonl",
    },
  };
}
