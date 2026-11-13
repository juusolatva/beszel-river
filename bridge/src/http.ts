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

/**
 * Stops `server` and resolves once it has closed. close() alone waits for every connection without a
 * request in progress to end on its own, including one a browser opened speculatively and never used,
 * which would hold up shutdown until the client gave up on it.
 */
export function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  return closed;
}
