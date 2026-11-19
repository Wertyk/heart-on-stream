import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function isInside(directory: string, path: string): boolean {
  const fromRoot = relative(directory, path);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function respond(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

/** Serve only built overlay assets; the caller supplies the actual listening port. */
export async function serveOverlay(
  directory: string,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
      `connect-src ws://127.0.0.1:${port} ws://localhost:${port}; ` +
      "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    respond(request, response, 405, "Method not allowed");
    return;
  }

  // Inspect the request target before URL normalization can erase dot segments.
  let path: string;
  try {
    path = decodeURIComponent((request.url ?? "").split("?")[0] ?? "");
  } catch {
    respond(request, response, 400, "Invalid overlay path");
    return;
  }
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    respond(request, response, 400, "Invalid overlay path");
    return;
  }

  const asset =
    path === "/overlay" || path === "/overlay/"
      ? "index.html"
      : path.startsWith("/overlay/")
        ? path.slice("/overlay/".length)
        : undefined;
  if (!asset) {
    respond(request, response, 404, "Not found");
    return;
  }

  try {
    const root = await realpath(directory);
    const candidate = resolve(root, asset);
    if (!isInside(root, candidate)) {
      respond(request, response, 404, "Not found");
      return;
    }
    // Real paths also prevent a symlink in the asset directory escaping it.
    const file = await realpath(candidate);
    if (!isInside(root, file) || !(await stat(file)).isFile()) {
      respond(request, response, 404, "Not found");
      return;
    }
    const body = await readFile(file);
    respond(
      request,
      response,
      200,
      body,
      contentTypes[extname(file)] ?? "application/octet-stream",
    );
  } catch (error) {
    const missing =
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR");
    respond(
      request,
      response,
      missing ? 404 : 500,
      missing ? "Not found" : "Could not read overlay asset",
    );
  }
}
