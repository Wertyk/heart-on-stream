import { describe, expect, it } from "vitest";
import {
  parseOverlayOptions,
  reconnectDelay,
} from "../../../src/presentation/overlay/options";

describe("overlay URL options", () => {
  it.each(["", "?theme=unknown", "?theme=NEON"])(
    "uses the default theme for %s",
    (query) => {
      expect(parseOverlayOptions(query)).toEqual({ theme: "neon", port: 7777 });
    },
  );

  it("selects either theme and an optional loopback port", () => {
    expect(parseOverlayOptions("?theme=minimal&port=8123")).toEqual({
      theme: "minimal",
      port: 8123,
    });
    expect(parseOverlayOptions("?theme=neon&port=65535")).toEqual({
      theme: "neon",
      port: 65535,
    });
    expect(parseOverlayOptions("?port=1").port).toBe(1);
  });

  it.each([
    "0",
    "65536",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "",
    "localhost:8888",
    "123/",
    " 42",
  ])("rejects invalid port %s", (port) => {
    expect(parseOverlayOptions(`?port=${encodeURIComponent(port)}`).port).toBe(
      7777,
    );
  });

  it.each(["127.0.0.1", "localhost"])(
    "defaults to the serving HTTP port on %s for missing or invalid query ports",
    (hostname) => {
      const location = { protocol: "http:", hostname, port: "8123" };
      for (const search of [
        "",
        "?theme=minimal",
        "?port=",
        "?port=0",
        "?port=65536",
        "?port=invalid",
        "?port=1.5",
      ]) {
        expect(parseOverlayOptions(search, location).port).toBe(8123);
      }
      expect(parseOverlayOptions("?theme=minimal", location).theme).toBe(
        "minimal",
      );
    },
  );

  it("lets a valid query port override the serving port", () => {
    expect(
      parseOverlayOptions("?port=9000", {
        protocol: "http:",
        hostname: "localhost",
        port: "8123",
      }).port,
    ).toBe(9000);
  });

  it.each([
    ["http://127.0.0.1:80/overlay", 80],
    ["http://localhost/overlay", 80],
    ["http://127.0.0.1:7777/overlay", 7777],
    ["http://localhost:7777/overlay", 7777],
  ])("uses the effective port of %s", (url, port) => {
    const location = new URL(url);
    expect(parseOverlayOptions("", location).port).toBe(port);
    expect(parseOverlayOptions("?port=invalid", location).port).toBe(port);
  });

  it.each([
    { protocol: "https:", hostname: "127.0.0.1", port: "8123" },
    { protocol: "https:", hostname: "localhost", port: "8123" },
    { protocol: "http:", hostname: "example.com", port: "8123" },
    { protocol: "http:", hostname: "localhost.example.com", port: "8123" },
    { protocol: "file:", hostname: "", port: "" },
    { protocol: "http:", hostname: "localhost", port: "65536" },
  ])(
    "uses 7777 when the serving location cannot supply a port: %j",
    (location) => {
      expect(parseOverlayOptions("", location).port).toBe(7777);
      expect(parseOverlayOptions("?port=invalid", location).port).toBe(7777);
    },
  );
});

describe("reconnect backoff", () => {
  it("doubles from 500 ms to a 5 s cap", () => {
    expect(
      Array.from({ length: 9 }, (_, index) => reconnectDelay(index)),
    ).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("handles a reset and extreme attempt counters", () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(-1)).toBe(500);
    expect(reconnectDelay(Number.NaN)).toBe(500);
    expect(reconnectDelay(Number.POSITIVE_INFINITY)).toBe(5_000);
  });
});
