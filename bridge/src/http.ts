import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server } from "node:http";

/**
 * The request-target's path before `?`, exactly as sent. Not a URL parser's: a parser throws on some
 * targets ("//") and resolves "..", "\" and "//host" in ways the proxy that routed the request need
 * not share. Callers compare it with exact strings, which cannot throw and answer only what was asked.
 */
export function requestPath(request: IncomingMessage): string {
  return (request.url ?? "/").split("?", 1)[0];
}

/** Starts `server` listening; resolves with the bound port (useful with port 0). */
export function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}
