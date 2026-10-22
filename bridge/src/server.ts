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
  /** Called with the new count whenever a stream opens or closes. */
  onClients?: (count: number) => void;
}

function event(name: FrameEvent, frame: Frame): string {
  return `event: ${name}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** `GET /stream` (Server-Sent Events) and `GET /healthz`. */
export class StreamServer {
  private readonly clients = new Set<ServerResponse>();
  private readonly server: Server;
  private pingTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: StreamServerOptions) {
    this.server = createServer((request, response) => this.handle(request, response));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Starts listening; resolves with the bound port (useful with port 0). */
  listen(): Promise<number> {
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) client.write(": ping\n\n");
    }, this.options.pingMs ?? 15_000);
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => resolve((this.server.address() as AddressInfo).port));
    });
  }

  broadcast(frame: Frame): void {
    const chunk = event("update", frame);
    for (const client of this.clients) client.write(chunk);
  }

  close(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const client of this.clients) client.end();
    this.clients.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
    } else if (path === "/healthz") {
      const ok = this.options.healthy();
      response.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" }).end(ok ? "ok\n" : "unavailable\n");
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
      });
      response.write(`retry: 5000\n\n${event("snapshot", this.options.snapshot())}`);
      this.clients.add(response);
      this.options.onClients?.(this.clients.size);
      request.on("close", () => {
        // close() has already cleared the set during shutdown.
        if (this.clients.delete(response)) this.options.onClients?.(this.clients.size);
      });
    }
  }
}
