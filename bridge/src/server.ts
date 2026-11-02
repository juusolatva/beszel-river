import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Frame, FrameEvent } from "@beszel-river/shared";
import { sendHealth } from "./health.js";
import { listen, requestPath } from "./http.js";
import { SECURITY_HEADERS, sendStatic, type StaticFiles } from "./static.js";

export interface StreamServerOptions {
  host: string;
  port: number;
  snapshot: () => Frame;
  /** Answers `GET /healthz`; omit when a `HealthServer` does, and `/healthz` is then 404 here. */
  healthy?: () => boolean;
  /** The frontend build (`STATIC_DIR`). When set, every response also carries `SECURITY_HEADERS`. */
  files?: StaticFiles;
  /** Comment line interval that keeps proxies from closing quiet streams, ms. */
  pingMs?: number;
  maxClients?: number;
  /** Maximum queued output per response, bytes (default 256 KiB). */
  maxBufferedBytes?: number;
  /** Longest wait for a blocked response to drain, ms (default 10 s). */
  drainTimeoutMs?: number;
  /** Called with the new count whenever a stream opens or closes. */
  onClients?: (count: number) => void;
}

interface Client {
  response: ServerResponse;
  blocked: NodeJS.Timeout | undefined;
  /** A full-state update was skipped while blocked; send the latest broadcast after drain. */
  pending: boolean;
}

function event(name: FrameEvent, frame: Frame): string {
  return `event: ${name}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** `GET /stream` (Server-Sent Events), optionally `GET /healthz` and the page's files. */
export class StreamServer {
  private readonly clients = new Set<Client>();
  private readonly server: Server;
  private pingTimer: NodeJS.Timeout | undefined;
  /** Shared by blocked clients rather than retaining a separate frame queue for each. */
  private latestUpdate = "";

  constructor(private readonly options: StreamServerOptions) {
    this.server = createServer((request, response) => this.handle(request, response));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Starts listening; resolves with the bound port (useful with port 0). */
  listen(): Promise<number> {
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) this.write(client, ": ping\n\n");
    }, this.options.pingMs ?? 15_000);
    return listen(this.server, this.options.port, this.options.host);
  }

  broadcast(frame: Frame): void {
    const chunk = event("update", frame);
    this.latestUpdate = chunk;
    for (const client of this.clients) this.write(client, chunk, true);
  }

  close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const client of this.clients) this.drop(client);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.blocked);
    this.options.onClients?.(this.clients.size);
  }

  private drop(client: Client): void {
    this.remove(client);
    // end() would wait for the very output this client cannot consume.
    client.response.destroy();
  }

  private write(client: Client, chunk: string, update = false): void {
    if (client.blocked) {
      if (update) client.pending = true;
      return;
    }
    const response = client.response;
    if (response.destroyed || response.writableEnded || response.writableLength + Buffer.byteLength(chunk) > (this.options.maxBufferedBytes ?? 256 * 1024)) {
      this.drop(client);
      return;
    }
    if (!response.write(chunk)) {
      // Keep no queued frames of our own: every event carries full state, so only the latest matters.
      client.blocked = setTimeout(() => this.drop(client), this.options.drainTimeoutMs ?? 10_000);
    }
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    // Exact matches on the raw path only (see requestPath); files were fixed at startup.
    const path = requestPath(request);
    const headers = this.options.files ? SECURITY_HEADERS : undefined;
    const file = this.options.files?.get(path);
    if (file) {
      if (request.method === "GET" || request.method === "HEAD") sendStatic(request, response, file);
      else response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
    } else if (request.method !== "GET") {
      response.writeHead(405, { ...headers, Allow: "GET" }).end();
    } else if (path === "/healthz" && this.options.healthy) {
      sendHealth(response, this.options.healthy(), headers);
    } else if (path !== "/stream") {
      response.writeHead(404, headers).end();
    } else if (this.clients.size >= (this.options.maxClients ?? 500)) {
      response.writeHead(503, { ...headers, "Retry-After": "30" }).end();
    } else {
      response.writeHead(200, {
        ...headers,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Tells nginx not to buffer this response, in case the proxy config forgets.
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      const client: Client = { response, blocked: undefined, pending: false };
      this.clients.add(client);
      response.on("close", () => this.remove(client));
      response.on("drain", () => {
        if (!client.blocked || !this.clients.has(client)) return;
        clearTimeout(client.blocked);
        client.blocked = undefined;
        if (client.pending) {
          client.pending = false;
          this.write(client, this.latestUpdate, true);
        }
      });
      this.options.onClients?.(this.clients.size);
      this.write(client, `retry: 5000\n\n${event("snapshot", this.options.snapshot())}`);
    }
  }
}
