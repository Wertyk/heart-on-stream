export type OverlayTheme = "neon" | "minimal";

function parsePort(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Prefer the serving loopback HTTP port so the socket matches the server CSP. */
export function parseOverlayOptions(
  search: string,
  location?: {
    readonly protocol: string;
    readonly hostname: string;
    readonly port: string;
  },
): {
  theme: OverlayTheme;
  port: number;
} {
  const params = new URLSearchParams(search);
  const servingPort =
    location?.protocol === "http:" &&
    (location.hostname === "127.0.0.1" || location.hostname === "localhost")
      ? parsePort(location.port || "80")
      : null;
  return {
    theme: params.get("theme") === "minimal" ? "minimal" : "neon",
    port: parsePort(params.get("port")) ?? servingPort ?? 7777,
  };
}

/** Failed attempts wait 0.5, 1, 2, 4, then 5 seconds until a connection opens. */
export function reconnectDelay(attempt: number): number {
  const exponent = Number.isNaN(attempt) ? 0 : Math.max(0, Math.floor(attempt));
  return Math.min(5_000, 500 * 2 ** Math.min(exponent, 4));
}
