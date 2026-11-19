import type { Logger } from "../../application/ports/logger";

/** Never forwards error objects; known credentials are redacted even in messages. */
export class ConsoleLogger implements Logger {
  constructor(private readonly secrets: readonly string[] = []) {}
  info(message: string): void {
    this.write("info", message);
  }
  warn(message: string): void {
    this.write("warn", message);
  }
  error(message: string): void {
    this.write("error", message);
  }
  private write(level: "info" | "warn" | "error", message: string): void {
    try {
      let safe = message;
      for (const secret of this.secrets)
        if (secret) safe = safe.replaceAll(secret, "[redacted]");
      console[level](safe);
    } catch {
      /* Logging must never change session behaviour. */
    }
  }
}
