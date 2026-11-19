import { describe, expect, it } from "vitest";
import { parseLaunchOptions } from "../src/main/launch-options";

describe("application CLI arguments", () => {
  it("defaults to live and accepts explicit live recording", () => {
    expect(parseLaunchOptions([])).toMatchObject({
      replay: false,
      record: false,
      speed: 1,
      loop: false,
      error: "",
    });
    expect(parseLaunchOptions(["--record"]).record).toBe(true);
  });
  it("accepts pnpm's separator, preserves paths, and always disables replay recording", () => {
    expect(
      parseLaunchOptions([
        "--replay",
        "--",
        "fixtures/a session.jsonl",
        "--speed=2.5",
        "--loop",
        "--record",
      ]),
    ).toEqual({
      replay: true,
      record: false,
      file: "fixtures/a session.jsonl",
      speed: 2.5,
      loop: true,
      error: "",
    });
  });
  it.each(["0.25", "20", "1", ".5"])("accepts speed %s", (speed) => {
    expect(
      parseLaunchOptions([
        "--replay",
        "/absolute/session.jsonl",
        `--speed=${speed}`,
      ]).error,
    ).toBe("");
  });
  it.each([
    "0",
    "0.24",
    "20.1",
    "-2",
    "NaN",
    "Infinity",
    "",
    " ",
    "0x2",
    "1junk",
  ])("reports invalid speed %j", (speed) => {
    expect(
      parseLaunchOptions(["--replay", "file", `--speed=${speed}`]).error,
    ).toContain("speed");
  });
  it("reports missing file, multiple files, duplicate speed and unknown flags", () => {
    expect(parseLaunchOptions(["--replay", "--"]).error).toContain(
      "Choose a replay file",
    );
    expect(parseLaunchOptions(["--replay", "a", "b"]).error).toContain(
      "exactly one",
    );
    expect(
      parseLaunchOptions(["--replay", "a", "--speed=1", "--speed=2"]).error,
    ).toContain("speed");
    expect(parseLaunchOptions(["--replay", "a", "--unknown"]).error).toContain(
      "Unknown replay option",
    );
  });
});
