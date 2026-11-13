import type { AddressInfo, Socket } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

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

/** How long shutdown lets responses already in progress finish before cutting their connections. */
const CLOSE_GRACE_MS = 5000;

/**
 * Returns a function that stops `server` and resolves once it has closed; set it up right after
 * creating the server. server.close() alone waits for every connection without a request in progress
 * to end on its own, including one a browser opened speculatively and never used, and closes idle
 * keep-alive connections only once, so one whose response finishes later stays open. This closes
 * unused connections at once, lets responses in progress finish and then closes their connections,
 * and cuts off any still unfinished after `graceMs`.
 */
export function closer(server: Server, graceMs = CLOSE_GRACE_MS): () => Promise<void> {
  const unused = new Set<Socket>();
  let closing = false;
  server.on("connection", (socket: Socket) => {
    unused.add(socket);
    socket.once("close", () => unused.delete(socket));
  });
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    unused.delete(request.socket);
    // The connection only counts as idle once the response has detached from it.
    response.once("finish", () => {
      if (closing) setImmediate(() => server.closeIdleConnections());
    });
  });
  return () => {
    closing = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of unused) socket.destroy();
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    return closed.finally(() => clearTimeout(timer));
  };
}
