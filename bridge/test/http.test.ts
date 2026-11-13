import { Agent, createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closer } from "../src/http.js";
import { preconnect, within } from "./sockets.js";

let server: Server | undefined;
let agent: Agent | undefined;
afterEach(() => {
  agent?.destroy();
  server?.closeAllConnections();
  server?.close();
  server = agent = undefined;
});

/** A server whose responses end `delayMs` after the request, or never when `delayMs` is null. */
async function start(delayMs: number | null, graceMs?: number): Promise<{ base: string; close: () => Promise<void> }> {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("partial ");
    if (delayMs !== null) setTimeout(() => response.end("done"), delayMs);
  });
  const close = closer(server, graceMs);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
}

/** Resolves with the body once the response ends, or with what arrived and `aborted` if it is cut off. */
function fetchBody(base: string): Promise<{ body: string; aborted: boolean }> {
  agent ??= new Agent({ keepAlive: true });
  return new Promise((resolve, reject) => {
    get(base, { agent }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ body, aborted: false }));
      response.on("aborted", () => resolve({ body, aborted: true }));
      response.on("error", () => resolve({ body, aborted: true }));
    }).on("error", reject);
  });
}

describe("closer", () => {
  it("lets a response in progress finish, then closes its keep-alive connection", async () => {
    const { base, close } = await start(100);
    const response = fetchBody(base);
    // Wait until the response has started, so the request is in progress when close() runs.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const closed = close();
    await expect(response).resolves.toEqual({ body: "partial done", aborted: false });
    await expect(within(closed, 1000)).resolves.toBeUndefined();
  });

  it("closes connections that never sent a request at once", async () => {
    const { base, close } = await start(0);
    const socket = await preconnect(base);
    const socketClosed = new Promise<boolean>((resolve) => socket.once("close", resolve));
    await expect(within(close(), 500)).resolves.toBeUndefined();
    await expect(within(socketClosed, 500)).resolves.toBe(false);
  });

  it("does not wait for idle keep-alive connections", async () => {
    const { base, close } = await start(0);
    await expect(fetchBody(base)).resolves.toEqual({ body: "partial done", aborted: false });
    await expect(within(close(), 500)).resolves.toBeUndefined();
  });

  it("cuts off a response still unfinished after the grace period", async () => {
    const { base, close } = await start(null, 50);
    const response = fetchBody(base);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(within(close(), 1000)).resolves.toBeUndefined();
    await expect(response).resolves.toEqual({ body: "partial ", aborted: true });
  });
});
