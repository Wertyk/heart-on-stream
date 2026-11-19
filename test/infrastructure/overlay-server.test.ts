import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import {
  createServer,
  Server as HttpServer,
  type IncomingHttpHeaders,
  request,
} from "node:http";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { OverlayPublisher } from "../../src/application/ports/overlay-publisher";
import {
  type PrivacyMode,
  type ProjectionInput,
  projectOverlay,
} from "../../src/domain/privacy/index";
import {
  OverlayServer,
  OverlayServerStartError,
} from "../../src/infrastructure/overlay/overlay-server";

const assets = {
  "index.html":
    '<!doctype html><link rel="stylesheet" href="/overlay/overlay.css"><script type="module" src="/overlay/overlay.js"></script>',
  "overlay.js": "export const overlay = true;",
  "overlay.css": "body { background: transparent; }",
  "overlay.js.map": '{"version":3,"sources":[],"mappings":""}',
  "nested/chunk.js": "export const chunk = true;",
};

const projectionInput: ProjectionInput = {
  status: "live",
  intensity: "elevated",
  pulse: { kind: "valid", bpm: 81.3 },
  breathingRate: 14.2,
  beatWave: [{ v: 0.75, atMs: 100 }],
  breathWave: [{ v: 0.2, atMs: 100 }],
  beatWindow: { fromMs: 100, toMs: 100 },
  replay: true,
};

interface HttpResult {
  readonly status: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

// node:http preserves raw dot segments, unlike fetch's URL normalization.
function get(port: number, path: string, method = "GET"): Promise<HttpResult> {
  return new Promise((done, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path, method, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          done({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

interface Viewer {
  readonly socket: WebSocket;
  readonly messages: { readonly json: string; readonly binary: boolean }[];
}

async function received(
  viewer: Viewer,
  payloads: readonly string[],
): Promise<void> {
  await expect
    .poll(() => viewer.messages)
    .toEqual(payloads.map((json) => ({ json, binary: false })));
}

// Exercise Node's HTTP parser and the ws handshake without binding a TCP port.
function exchange(
  server: HttpServer,
  path: string,
  headers: string[],
): Promise<string> {
  return new Promise((done, reject) => {
    let response = "";
    const socket = Object.assign(
      new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, next) {
          response += chunk.toString();
          next();
          if (response.includes("\r\n\r\n")) {
            done(response);
            queueMicrotask(() => socket.destroy());
          }
        },
      }),
      { setTimeout() {}, setNoDelay() {} },
    );
    socket.once("error", reject);
    server.emit("connection", socket);
    socket.push([`GET ${path} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
  });
}

const upgradeHeaders = [
  "Connection: Upgrade",
  "Upgrade: websocket",
  "Sec-WebSocket-Version: 13",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
];

describe("OverlayServer", () => {
  let directory: string;
  let overlayDirectory: string;
  let server: OverlayServer;
  const servers = new Set<OverlayServer>();
  const viewers = new Set<WebSocket>();

  function makeServer(port = 0): OverlayServer {
    const adapter = new OverlayServer(overlayDirectory, { port });
    servers.add(adapter);
    return adapter;
  }

  async function startWithoutSocket(port: number): Promise<HttpServer> {
    let listener: HttpServer | undefined;
    const listen = vi.spyOn(HttpServer.prototype, "listen");
    listen.mockImplementationOnce(function (
      this: HttpServer,
      ...args: unknown[]
    ) {
      listener = this;
      const callback = args.at(-1);
      if (typeof callback === "function") callback();
      return this;
    });
    vi.spyOn(HttpServer.prototype, "address").mockReturnValue({
      address: "127.0.0.1",
      family: "IPv4",
      port,
    });
    await makeServer(port).start();
    expect(listen).toHaveBeenCalledWith(
      port,
      "127.0.0.1",
      expect.any(Function),
    );
    if (!listener) throw new Error("Missing HTTP listener");
    return listener;
  }

  async function viewer(
    port: number,
    options: { readonly origin?: string; readonly path?: string } = {},
  ): Promise<Viewer> {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${options.path ?? "/"}`,
      options.origin === undefined ? {} : { origin: options.origin },
    );
    viewers.add(socket);
    const messages: Viewer["messages"] = [];
    socket.on("message", (data, binary) => {
      messages.push({ json: data.toString(), binary });
    });
    socket.on("error", () => {});
    await once(socket, "open");
    return { socket, messages };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "heart-on-stream-overlay-"));
    overlayDirectory = join(directory, "overlay");
    await mkdir(join(overlayDirectory, "nested"), { recursive: true });
    await Promise.all(
      Object.entries(assets).map(([file, body]) =>
        writeFile(join(overlayDirectory, file), body, "utf8"),
      ),
    );
    await writeFile(
      join(directory, "outside.txt"),
      "Outside the overlay",
      "utf8",
    );
    server = makeServer();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of viewers) socket.terminate();
    viewers.clear();
    await Promise.all([...servers].map((adapter) => adapter.stop()));
    servers.clear();
    await rm(directory, { recursive: true, force: true });
  });

  it("binds the shared HTTP/WebSocket listener to IPv4 loopback on a configurable port", async () => {
    expect(server.address()).toBeNull();
    const bound = await server.start();
    expect(bound).toEqual({
      address: "127.0.0.1",
      family: "IPv4",
      port: expect.any(Number),
    });
    expect(bound.port).toBeGreaterThan(0);
    expect(server.address()).toEqual(bound);
    const client = await viewer(bound.port);
    const pong = once(client.socket, "pong");
    client.socket.ping();
    await pong;
    expect((await get(bound.port, "/overlay")).status).toBe(200);
    await server.stop();
    const configured = makeServer(bound.port);
    expect((await configured.start()).port).toBe(bound.port);
  });

  it("defaults to port 7777 without opening a listener at construction", async () => {
    const adapter = new OverlayServer(overlayDirectory);
    servers.add(adapter);
    const listen = vi.spyOn(
      (await import("node:net")).Server.prototype,
      "listen",
    );
    listen.mockImplementationOnce(() => {
      throw new Error("Intercepted listen");
    });
    await expect(adapter.start()).rejects.toMatchObject({
      kind: "other",
      port: 7777,
    });
    expect(listen).toHaveBeenCalledWith(
      7777,
      "127.0.0.1",
      expect.any(Function),
    );
    expect(adapter.address()).toBeNull();
  });

  it("serves both overlay page URLs, nested assets, and query strings with the correct content types", async () => {
    const { port } = await server.start();
    for (const path of ["/overlay", "/overlay/", "/overlay?replay=1"]) {
      const result = await get(port, path);
      expect(result).toMatchObject({ status: 200, body: assets["index.html"] });
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
    for (const [file, contentType] of [
      ["overlay.js", "text/javascript; charset=utf-8"],
      ["overlay.css", "text/css; charset=utf-8"],
      ["overlay.js.map", "application/json; charset=utf-8"],
      ["nested/chunk.js", "text/javascript; charset=utf-8"],
    ] as const) {
      const result = await get(port, `/overlay/${file}?v=1`);
      expect(result).toMatchObject({ status: 200, body: assets[file] });
      expect(result.headers["content-type"]).toBe(contentType);
    }
    const encoded = await get(port, "/overlay/%6fverlay.js");
    expect(encoded).toMatchObject({ status: 200, body: assets["overlay.js"] });
  });

  it("applies restrictive headers, serves HEAD without a body, and accepts only GET/HEAD", async () => {
    const { port } = await server.start();
    for (const [path, method, status] of [
      ["/overlay", "GET", 200],
      ["/overlay/overlay.js", "HEAD", 200],
      ["/overlay/missing.js", "HEAD", 404],
      ["/", "GET", 404],
      ["/overlay", "POST", 405],
      ["/overlay", "OPTIONS", 405],
      ["/overlay", "PUT", 405],
    ] as const) {
      const result = await get(port, path, method);
      expect(result.status).toBe(status);
      expect(result.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
          `connect-src ws://127.0.0.1:${port} ws://localhost:${port}; ` +
          "base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
      );
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(
        Object.keys(result.headers).some((header) =>
          header.startsWith("access-control-"),
        ),
      ).toBe(false);
      if (method === "HEAD") expect(result.body).toBe("");
      if (status === 405) expect(result.headers.allow).toBe("GET, HEAD");
      if (path === "/overlay/overlay.js" && method === "HEAD") {
        expect(Number(result.headers["content-length"])).toBe(
          Buffer.byteLength(assets["overlay.js"]),
        );
      }
    }
  });

  it.each([
    "/overlay/../outside.txt",
    "/overlay/%2e%2e/outside.txt",
    "/overlay/.%2e/outside.txt",
    "/overlay/%2E%2E%2Foutside.txt",
    "/overlay/nested/../../outside.txt",
    "/overlay/%5c..%5coutside.txt",
    "/overlay/%00",
    "/overlay/%not-encoded",
  ])(
    "rejects traversal and malformed paths before normalization: %s",
    async (path) => {
      const { port } = await server.start();
      expect((await get(port, path)).status).toBe(400);
    },
  );

  it("returns 404 outside /overlay, for missing files/directories, and for symlinks escaping the asset root", async () => {
    await symlink(
      join(directory, "outside.txt"),
      join(overlayDirectory, "linked.txt"),
    );
    await mkdir(join(directory, "overlay-sibling"));
    await writeFile(
      join(directory, "overlay-sibling", "chunk.js"),
      "Outside",
      "utf8",
    );
    await symlink(
      join(directory, "overlay-sibling"),
      join(overlayDirectory, "linked-dir"),
    );
    const { port } = await server.start();
    for (const path of [
      "/",
      "/outside.txt",
      "/overlay.js",
      "/overlay-other/index.html",
      "/overlay/missing.js",
      "/overlay/nested",
      "/overlay//outside.txt",
      "/overlay/linked.txt",
      "/overlay/linked-dir/chunk.js",
      "/overlay/%252e%252e/outside.txt",
    ]) {
      expect((await get(port, path)).status).toBe(404);
    }
  });

  it.each<PrivacyMode>(["off", "vibe", "numbers", "highlightsOnly"])(
    "sends exactly the published %s projection, with no envelope or initial message",
    async (mode) => {
      const { port } = await server.start();
      const client = await viewer(port);
      const state = projectOverlay(projectionInput, mode);
      const publisher: OverlayPublisher = server;
      await publisher.publish(state);
      await received(client, [JSON.stringify(state)]);
      expect(JSON.parse(client.messages[0]?.json ?? "")).toEqual(state);
    },
  );

  it("resolves without viewers and immediately sends only the latest snapshot to a late joiner", async () => {
    const state = projectOverlay(projectionInput, "vibe");
    await expect(
      server.publish({ mode: "off", replay: false }),
    ).resolves.toBeUndefined();
    await server.publish(state);
    const snapshot = JSON.stringify(state);
    // Mutating a caller-owned object cannot alter the cached wire snapshot.
    Object.assign(state, { replay: false });
    const { port } = await server.start();
    const first = await viewer(port);
    await received(first, [snapshot]);
    const latest = projectOverlay(projectionInput, "highlightsOnly");
    await server.publish(latest);
    await received(first, [snapshot, JSON.stringify(latest)]);
    const late = await viewer(port);
    await received(late, [JSON.stringify(latest)]);
  });

  it("broadcasts to multiple clients and allows a disconnected viewer to reconnect", async () => {
    const { port } = await server.start();
    const first = await viewer(port);
    const second = await viewer(port);
    const state = projectOverlay(projectionInput, "vibe");
    await server.publish(state);
    await Promise.all(
      [first, second].map((client) =>
        received(client, [JSON.stringify(state)]),
      ),
    );
    const closed = once(first.socket, "close");
    first.socket.terminate();
    await closed;
    const latest = projectOverlay(projectionInput, "off");
    await server.publish(latest);
    await received(second, [JSON.stringify(state), JSON.stringify(latest)]);
    await received(await viewer(port), [JSON.stringify(latest)]);
  });

  it.each(["throw", "callback"])(
    "isolates a client's send %s failure from healthy viewers and future publications",
    async (failure) => {
      const { port } = await server.start();
      const failing = await viewer(port);
      const healthy = await viewer(port);
      const closed = once(failing.socket, "close");
      // Real sockets, with a deterministic transport fault for the first server send.
      vi.spyOn(WebSocket.prototype, "send").mockImplementationOnce(
        (_data, _options, callback) => {
          if (failure === "throw") throw new Error("Disconnected viewer");
          callback?.(new Error("Failed write"));
        },
      );
      const state = projectOverlay(projectionInput, "vibe");
      await expect(server.publish(state)).resolves.toBeUndefined();
      await closed;
      await received(healthy, [JSON.stringify(state)]);
      const next = projectOverlay(projectionInput, "numbers");
      await server.publish(next);
      await received(healthy, [JSON.stringify(state), JSON.stringify(next)]);
      await received(await viewer(port), [JSON.stringify(next)]);
    },
  );

  it("accepts OBS without an Origin and pages served by either loopback hostname", async () => {
    const { port } = await server.start();
    const clients = [
      await viewer(port),
      await viewer(port, { origin: `http://127.0.0.1:${port}` }),
      await viewer(port, { origin: `http://localhost:${port}` }),
    ];
    const state = { mode: "off", replay: false } as const;
    await server.publish(state);
    await Promise.all(
      clients.map((client) => received(client, [JSON.stringify(state)])),
    );
  });

  it.each([80, 7777])("accepts browser origins on port %i", async (port) => {
    const listener = await startWithoutSocket(port);
    for (const host of ["127.0.0.1", "localhost"]) {
      const page = new URL(`http://${host}:${port}/overlay`);
      const response = await exchange(listener, "/", [
        `Host: ${page.host}`,
        `Origin: ${page.origin}`,
        ...upgradeHeaders,
      ]);
      expect(response).toMatch(/^HTTP\/1\.1 101 /u);
    }
    expect(
      await exchange(listener, "/", [
        `Host: 127.0.0.1:${port}`,
        `Origin: http://attacker.example:${port}`,
        ...upgradeHeaders,
      ]),
    ).toMatch(/^HTTP\/1\.1 403 /u);
  });

  it.each([
    ["HTTP", 80],
    ["WebSocket", 80],
    ["HTTP", 7777],
    ["WebSocket", 7777],
  ])(
    "requires the exact loopback Host for %s on port %i",
    async (protocol, port) => {
      const listener = await startWithoutSocket(port);
      const request = (headers: string[]) =>
        protocol === "HTTP"
          ? exchange(listener, "/overlay", headers)
          : exchange(listener, "/", [...headers, ...upgradeHeaders]);
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (port === 80) allowed.push("127.0.0.1", "localhost");
      for (const host of allowed) {
        expect(await request([`Host: ${host}`])).toMatch(
          protocol === "HTTP" ? /^HTTP\/1\.1 200 /u : /^HTTP\/1\.1 101 /u,
        );
      }

      const denied = [
        [`Host: attacker.example:${port}`],
        ["Host: localhost:1"],
        [`Host: LOCALHOST:${port}`],
        [`Host: 127.0.0.1:${port}`, `Host: attacker.example:${port}`],
      ];
      if (port !== 80) denied.push(["Host: localhost"], ["Host: 127.0.0.1"]);
      for (const headers of denied) {
        expect(await request(headers)).toMatch(/^HTTP\/1\.1 403 /u);
      }
    },
  );

  it.each([
    "https://example.com",
    "null",
    "http://localhost:1",
    "http://127.0.0.1:1",
    "http://localhost.evil.example:7777",
    "http://127.0.0.1:7777.evil.example",
  ])("rejects an untrusted WebSocket Origin: %s", async (origin) => {
    const { port } = await server.start();
    await expect(viewer(port, { origin })).rejects.toThrow(
      "Unexpected server response: 403",
    );
  });

  it.each(["/ws", "/overlay", "/overlay/", "/other", "/?command=start"])(
    "rejects upgrades outside the documented root path: %s",
    async (path) => {
      const { port } = await server.start();
      await expect(viewer(port, { path })).rejects.toThrow(
        "Unexpected server response: 404",
      );
    },
  );

  it("ignores commands, closes oversized messages, and keeps other clients usable", async () => {
    const { port } = await server.start();
    const sender = await viewer(port);
    const healthy = await viewer(port);
    sender.socket.send('{"command":"start","mode":"numbers"}');
    sender.socket.send(Buffer.from([1, 2, 3]));
    const pong = once(sender.socket, "pong");
    sender.socket.ping();
    await pong;
    expect(sender.messages).toEqual([]);
    expect(healthy.messages).toEqual([]);
    const closed = once(sender.socket, "close");
    sender.socket.send("x".repeat(1025));
    expect((await closed)[0]).toBe(1009);
    const latest = { mode: "off", replay: true } as const;
    await server.publish(latest);
    await received(healthy, [JSON.stringify(latest)]);
    await received(await viewer(port), [JSON.stringify(latest)]);
  });

  it("rejects a busy port with a typed descriptive error, then supports cleanup and retry", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const bound = blocker.address();
    if (!bound || typeof bound === "string")
      throw new Error("Missing TCP address");
    const blocked = makeServer(bound.port);
    try {
      await expect(blocked.start()).rejects.toBeInstanceOf(
        OverlayServerStartError,
      );
      await expect(blocked.start()).rejects.toMatchObject({
        kind: "portInUse",
        port: bound.port,
        message: `Overlay port ${bound.port} is already in use. Close the app using it or choose another overlay port.`,
      });
      expect(blocked.address()).toBeNull();
      await blocked.stop();
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
    expect((await blocked.start()).port).toBe(bound.port);
    expect((await get(bound.port, "/overlay")).status).toBe(200);
  });

  it("types other startup errors and leaves stop available", async () => {
    const invalid = makeServer(-1);
    await expect(invalid.start()).rejects.toMatchObject({
      kind: "other",
      port: -1,
    });
    expect(invalid.address()).toBeNull();
    await invalid.stop();
  });

  it("closes clients and HTTP sockets idempotently and supports stop/start and a replacement app instance", async () => {
    await server.stop();
    const { port } = await server.start();
    await server.stop();
    const restartable = makeServer(port);
    await Promise.all([restartable.start(), restartable.start()]);
    const state = projectOverlay(projectionInput, "vibe");
    await restartable.publish(state);
    const first = await viewer(port);
    await received(first, [JSON.stringify(state)]);
    // events.once rejects on "error"; a reset during shutdown is expected here.
    const wsClosed = new Promise<void>((resolve) =>
      first.socket.once("close", () => resolve()),
    );
    const httpSocket = connectTcp({ port, host: "127.0.0.1" });
    // Stopping destroys the half-open request; the client sees a reset, which is expected.
    const httpErrors: NodeJS.ErrnoException[] = [];
    httpSocket.on("error", (error: NodeJS.ErrnoException) =>
      httpErrors.push(error),
    );
    await once(httpSocket, "connect");
    httpSocket.write("GET /overlay HTTP/1.1\r\n"); // Incomplete HTTP request.
    const httpClosed = new Promise<void>((resolve) =>
      httpSocket.once("close", () => resolve()),
    );
    await Promise.all([
      restartable.stop(),
      restartable.stop(),
      wsClosed,
      httpClosed,
    ]);
    expect(restartable.address()).toBeNull();
    expect(httpErrors.every((error) => error.code === "ECONNRESET")).toBe(true);
    await expect(get(port, "/overlay")).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    await restartable.start();
    await received(await viewer(port), [JSON.stringify(state)]);
    expect((await get(port, "/overlay/")).body).toBe(assets["index.html"]);
    await restartable.stop();
    const replacement = makeServer(port);
    await replacement.start();
    const reconnected = await viewer(port);
    const next = projectOverlay(projectionInput, "off");
    await replacement.publish(next);
    await received(reconnected, [JSON.stringify(next)]);
  });

  it("serializes overlapping start, stop and start calls", async () => {
    const started = server.start();
    const stopped = server.stop();
    const restarted = server.start();
    await Promise.all([started, stopped, restarted]);
    const address = await restarted;
    expect(server.address()).toEqual(address);
    expect((await get(address.port, "/overlay")).status).toBe(200);
  });
});
