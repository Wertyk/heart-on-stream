import { describe, expect, it, vi } from "vitest";
import { loadConfiguration } from "../../src/infrastructure/electron/configuration";
import { measurementPower } from "../../src/infrastructure/electron/measurement-power";
import {
  allowsVideo,
  isAppPage,
} from "../../src/infrastructure/electron/permission-policy";

const pages = ["file:///app/dist/presentation/panel/index.html"];
const page = `${pages[0]}?replay=0`;

describe("application camera permission policy", () => {
  it("grants video-only access to the exact app document, including query/hash", () => {
    expect(allowsVideo("media", `${page}#setup`, ["video"], pages)).toBe(true);
  });

  it.each([
    undefined,
    [],
    ["audio"],
    ["video", "audio"],
    ["audio", "video"],
    ["video", "video"],
    ["unknown"],
  ])("denies missing, mixed, or non-video media types: %j", (types) => {
    expect(allowsVideo("media", page, types, pages)).toBe(false);
  });

  it.each([
    "geolocation",
    "display-capture",
    "notifications",
    "clipboard-read",
  ])("denies %s even from the app page", (permission) => {
    expect(allowsVideo(permission, page, ["video"], pages)).toBe(false);
  });

  it.each([
    undefined,
    "",
    "file://",
    "file:///other/index.html",
    "file:///app/dist/presentation/panel/index.html.evil",
    "file://remote/app/dist/presentation/panel/index.html",
    "https://example.com/index.html",
    "https://example.com/?file:///app/dist/presentation/panel/index.html",
    "data:text/html,test",
    "not a URL",
  ])("denies other documents and malformed URLs: %j", (url) => {
    expect(isAppPage(url, pages)).toBe(false);
    expect(allowsVideo("media", url, ["video"], pages)).toBe(false);
  });

  it("uses the same video-only decision for permission checks and requests", () => {
    for (const type of ["video", "audio", "unknown"]) {
      expect(allowsVideo("media", page, [type], pages)).toBe(type === "video");
    }
  });
});

describe("main-process configuration loading", () => {
  function loader(exists = false) {
    return {
      exists: vi.fn(() => exists),
      loadEnvFile: vi.fn(),
      environment: vi.fn((): Record<string, string | undefined> => ({})),
    };
  }

  it("does not load an absent .env and disables Start with a clear message", () => {
    const source = loader();
    const config = loadConfiguration(source, false);
    expect(source.loadEnvFile).not.toHaveBeenCalled();
    expect(config.apiKey).toBeNull();
    expect(config.public.canStart).toBe(false);
    expect(config.public.message).toContain("SMARTSPECTRA_API_KEY is missing");
    // Judges without a key are pointed at the bundled replay sample.
    expect(config.public.message).toContain(
      "pnpm replay -- samples/live-b-exertion-strong.jsonl",
    );
  });

  it("loads an existing file before resolving environment configuration", () => {
    const source = loader(true);
    let loaded = false;
    source.loadEnvFile.mockImplementation(() => {
      loaded = true;
    });
    source.environment.mockImplementation(() => {
      expect(loaded).toBe(true);
      return { SMARTSPECTRA_API_KEY: "  test-credential  " };
    });
    const config = loadConfiguration(source, false);
    expect(source.loadEnvFile).toHaveBeenCalledExactlyOnceWith();
    expect(config.apiKey).toBe("test-credential");
    expect(config.public.canStart).toBe(true);
    expect(config.public).not.toHaveProperty("apiKey");
    expect(JSON.stringify(config.public)).not.toContain("test-credential");
  });

  it("supports an inherited key without a .env file", () => {
    const source = loader();
    source.environment.mockReturnValue({
      SMARTSPECTRA_API_KEY: "test-credential",
    });
    expect(loadConfiguration(source, false).public.canStart).toBe(true);
  });

  it("exposes the recording launch preference to the panel and keeps replay recording off", () => {
    expect(loadConfiguration(loader(), false).public.recordByDefault).toBe(
      false,
    );
    expect(
      loadConfiguration(loader(), false, true).public.recordByDefault,
    ).toBe(true);
    expect(loadConfiguration(loader(), true, true).public.recordByDefault).toBe(
      false,
    );
  });

  it.each([undefined, "", " \t "])(
    "treats a blank key as absent: %j",
    (key) => {
      const source = loader();
      source.environment.mockReturnValue({ SMARTSPECTRA_API_KEY: key });
      expect(loadConfiguration(source, false).apiKey).toBeNull();
    },
  );

  it("reports load errors without echoing file contents or crashing", () => {
    const source = loader(true);
    source.loadEnvFile.mockImplementation(() => {
      throw new Error("private contents");
    });
    const config = loadConfiguration(source, false);
    expect(config.public.canStart).toBe(false);
    expect(config.public.message).toContain(
      "Unable to load local configuration",
    );
    expect(config.public.message).not.toContain("private contents");
    expect(source.environment).not.toHaveBeenCalled();
  });

  it("enables replay without consulting files or environment", () => {
    const source = loader(true);
    const config = loadConfiguration(source, true);
    expect(source.exists).not.toHaveBeenCalled();
    expect(source.loadEnvFile).not.toHaveBeenCalled();
    expect(source.environment).not.toHaveBeenCalled();
    expect(config.apiKey).toBeNull();
    expect(config.public.canStart).toBe(true);
    expect(config.public.message).toBe(
      "REPLAY — Playback uses a saved session of numeric signal and status data. The camera and session recording stay off.",
    );
    expect(config.public.message).not.toMatch(/synthetic|fixture|fake/iu);
  });
});

describe("measurement power lifecycle", () => {
  it("blocks suspension only between Start and Stop, and supports repeated sessions", () => {
    const blocker = { start: vi.fn(() => 42), stop: vi.fn() };
    const power = measurementPower(blocker);
    power.stop();
    expect(blocker.stop).not.toHaveBeenCalled();
    power.start();
    power.start();
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith(
      "prevent-app-suspension",
    );
    power.stop();
    power.stop();
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(42);
    power.start();
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
