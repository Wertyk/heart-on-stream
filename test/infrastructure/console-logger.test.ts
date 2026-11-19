import { afterEach, expect, it, vi } from "vitest";
import { ConsoleLogger } from "../../src/infrastructure/system/console-logger";

afterEach(() => vi.restoreAllMocks());
it("redacts known credentials and never throws when the console fails", () => {
  const logger = new ConsoleLogger(["fake-secret", ""]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  logger.warn("Unavailable fake-secret fake-secret");
  expect(warn).toHaveBeenCalledWith("Unavailable [redacted] [redacted]");
  warn.mockImplementation(() => {
    throw new Error("destination");
  });
  expect(() => logger.warn("message")).not.toThrow();
});
