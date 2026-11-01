import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Frame, FrameEvent } from "@beszel-river/shared";

export interface StreamServerOptions {
  host: string;
  port: number;
  snapshot: () => Frame;
  healthy: () => boolean;
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

/** `GET /stream` (Server-Sent Events) and `GET /healthz`. */
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
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve((this.server.address() as AddressInfo).port));
    });
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
    // The raw path, not a URL parser's: only two exact paths exist, a parser throws on some
    // client targets ("//") and resolves "..", "\" and "//host" in ways the proxy that routed
    // the request need not share. Exact matching cannot throw and answers only what was asked.
    const path = (request.url ?? "/").split("?", 1)[0];
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
    } else if (path === "/healthz") {
      const ok = this.options.healthy();
      response.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" }).end(ok ? "ok\n" : "unavailable\n");
    } else if (path !== "/stream") {
      response.writeHead(404).end();
    } else if (this.clients.size >= (this.options.maxClients ?? 500)) {
      response.writeHead(503, { "Retry-After": "30" }).end();
    } else {
      response.writeHead(200, {
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
