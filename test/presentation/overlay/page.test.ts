import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../../src/presentation/overlay/index.html", import.meta.url),
  "utf8",
);

describe("overlay page hosting contract", () => {
  it.each(["/overlay", "/overlay/"])(
    "resolves its entry under the asset directory when opened at %s",
    (path) => {
      const source = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)?.[1];
      expect(source).toBeDefined();
      expect(
        new URL(source ?? "", `http://127.0.0.1:7777${path}`).pathname,
      ).toBe("/overlay/overlay.js");
    },
  );

  it("allows only loopback WebSocket connections in its additional CSP", () => {
    const csp = html.match(
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
    )?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp?.match(/connect-src ([^;]+)/)?.[1]).toBe(
      "ws://127.0.0.1:* ws://localhost:*",
    );
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<script\b[^>]*>\s*\S+\s*<\/script>/i);
  });
});
