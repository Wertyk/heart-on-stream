import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { OverlayPublisher } from "../../application/ports/overlay-publisher";
import type { OverlayState } from "../../domain/privacy/index";
import { serveOverlay } from "./static-overlay";

const loopbackHosts = ["127.0.0.1", "localhost"];

function allowsHost(request: IncomingMessage, port: number): boolean {
  const hosts = request.headersDistinct.host;
  return (
    hosts?.length === 1 &&
    loopbackHosts.some(
      (host) =>
        hosts[0] === `${host}:${port}` || (port === 80 && hosts[0] === host),
    )
  );
}

/** Port 0 requests an ephemeral loopback port, useful for isolated hosts/tests. */
export interface OverlayServerOptions {
  readonly port?: number;
}

/** A startup failure the composition can present without exposing a Node error. */
export class OverlayServerStartError extends Error {
  readonly kind: "portInUse" | "other";

  constructor(
    readonly port: number,
    cause: unknown,
  ) {
    const busy =
      cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE";
    super(
      busy
        ? `Overlay port ${port} is already in use. Close the app using it or choose another overlay port.`
        : `Could not start the overlay server on 127.0.0.1:${port}. Check the overlay port and try again.`,
      { cause },
    );
    this.name = "OverlayServerStartError";
    this.kind = busy ? "portInUse" : "other";
  }
}

interface RunningServer {
  readonly http: Server;
  readonly websocket: WebSocketServer;
  readonly connections: Set<Socket>;
}

function address(server: Server): AddressInfo | null {
  const value = server.address();
  return typeof value === "object" ? value : null;
}

function send(client: WebSocket, json: string): void {
  if (client.readyState !== WebSocket.OPEN) return;
  try {
    client.send(json, { binary: false }, (error) => {
      if (error) client.terminate();
    });
  } catch {
    client.terminate();
  }
}

async function close(server: RunningServer): Promise<void> {
  const closedHttp = new Promise<void>((done) =>
    server.http.close(() => done()),
  );
  const closedWebsocket = new Promise<void>((done) =>
    server.websocket.close(() => done()),
  );
  // Do not wait for an unresponsive browser's close handshake or HTTP request.
  for (const client of server.websocket.clients) client.terminate();
  for (const connection of server.connections) connection.destroy();
  await Promise.all([closedHttp, closedWebsocket]);
}

/**
 * Loopback-only HTTP + WebSocket adapter, independent of Electron.
 * Pages: http://127.0.0.1:<port>/overlay (or /overlay/), assets: /overlay/<file>.
 * WebSocket: ws://127.0.0.1:<port>/ (the only accepted upgrade path).
 * Publish accepts an already privacy-projected state and adds no wire fields.
 */
export class OverlayServer implements OverlayPublisher {
  private readonly directory: string;
  private readonly port: number;
  private running: RunningServer | undefined;
  private operations: Promise<void> = Promise.resolve();
  private latestJson: string | undefined;

  constructor(directory: string, options: OverlayServerOptions = {}) {
    this.directory = resolve(directory);
    this.port = options.port ?? 7777;
  }

  /** Returns the underlying HTTP listener's address, shared by WebSocket upgrades. */
  address(): AddressInfo | null {
    return this.running ? address(this.running.http) : null;
  }

  /** Resolves only after listening; repeated/concurrent starts reuse the listener. */
  start(): Promise<AddressInfo> {
    return this.enqueue(async () => {
      const listening = this.address();
      if (listening) return listening;

      const http = createServer((request, response) => {
        const port = address(http)?.port ?? this.port;
        if (!allowsHost(request, port)) {
          response.writeHead(403, { "Content-Length": 0 }).end();
          return;
        }
        void serveOverlay(this.directory, port, request, response);
      });
      const websocket = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 1024,
      });
      const server: RunningServer = { http, websocket, connections: new Set() };
      http.on("connection", (connection) => {
        server.connections.add(connection);
        connection.once("close", () => server.connections.delete(connection));
      });
      http.on("upgrade", (request, socket, head) => {
        const port = address(http)?.port ?? this.port;
        const origin = request.headers.origin;
        // Browsers serialize the origin without the default HTTP port.
        const allowed =
          allowsHost(request, port) &&
          (origin === undefined ||
            loopbackHosts.some(
              (host) => origin === new URL(`http://${host}:${port}`).origin,
            ));
        const status = !allowed
          ? "403 Forbidden"
          : request.url !== "/"
            ? "404 Not Found"
            : undefined;
        if (status) {
          socket.end(
            `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        websocket.handleUpgrade(request, socket, head, (client) => {
          // ws handles protocol/transport closure; consume errors so one peer
          // cannot emit an unhandled EventEmitter error and stop the server.
          client.on("error", () => {});
          // No message listener: this is a receive-only projection stream.
          if (this.latestJson !== undefined) send(client, this.latestJson);
        });
      });

      try {
        await new Promise<void>((done, reject) => {
          http.once("error", reject);
          http.listen(this.port, "127.0.0.1", () => {
            http.off("error", reject);
            done();
          });
        });
        const bound = address(http);
        if (!bound) throw new Error("Overlay listener has no TCP address");
        this.running = server;
        return bound;
      } catch (error) {
        await close(server);
        throw new OverlayServerStartError(this.port, error);
      }
    });
  }

  /** Snapshots even with zero clients or while stopped, for the next connection. */
  async publish(state: OverlayState): Promise<void> {
    const json = JSON.stringify(state);
    this.latestJson = json;
    if (!this.running) return;
    for (const client of this.running.websocket.clients) send(client, json);
  }

  /** Idempotent; disconnects all peers and permits a later start on the same port. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      const server = this.running;
      this.running = undefined;
      if (server) await close(server);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
