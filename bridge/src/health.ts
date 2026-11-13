import { createServer, type Server, type ServerResponse } from "node:http";
import { closer, listen, requestPath } from "./http.js";

/** `/healthz`: 200 while the hub subscription is live, 503 otherwise. */
export function sendHealth(response: ServerResponse, ok: boolean, headers: Readonly<Record<string, string>> = {}): void {
  response
    .writeHead(ok ? 200 : 503, { ...headers, "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" })
    .end(ok ? "ok\n" : "unavailable\n");
}

export interface HealthServerOptions {
  /** Always a loopback address in practice; main.ts passes 127.0.0.1. */
  host: string;
  port: number;
  healthy: () => boolean;
}

/**
 * `GET /healthz` alone, on its own listener (`HEALTH_PORT`). A proxy that forwards every path of the
 * public listener then cannot expose it, and no proxy config has to remember to block it.
 */
export class HealthServer {
  private readonly server: Server;
  private readonly closeServer: () => Promise<void>;

  constructor(private readonly options: HealthServerOptions) {
    this.server = createServer((request, response) => {
      if (request.method !== "GET") response.writeHead(405, { Allow: "GET" }).end();
      else if (requestPath(request) === "/healthz") sendHealth(response, this.options.healthy());
      else response.writeHead(404).end();
    });
    this.closeServer = closer(this.server);
  }

  /** Starts listening; resolves with the bound port (useful with port 0). */
  listen(): Promise<number> {
    return listen(this.server, this.options.port, this.options.host);
  }

  close(): Promise<void> {
    return this.closeServer();
  }
}
