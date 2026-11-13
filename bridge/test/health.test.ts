import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HealthServer } from "../src/health.js";
import { StreamServer } from "../src/server.js";
import { preconnect, within } from "./sockets.js";

let health: HealthServer | undefined;
let stream: StreamServer | undefined;
afterEach(async () => {
  await Promise.all([health?.close(), stream?.close()]);
  health = undefined;
  stream = undefined;
});

async function start(isHealthy: () => boolean): Promise<string> {
  health = new HealthServer({ host: "127.0.0.1", port: 0, healthy: isHealthy });
  return `http://127.0.0.1:${await health.listen()}`;
}

/** Sends `path` as the request-target as is; fetch would normalize it first. */
function rawStatus(base: string, path: string, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    request(base, { path, method }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    }).on("error", reject).end();
  });
}

describe("HealthServer", () => {
  it("answers 200 while healthy and 503 otherwise, read on every request", async () => {
    let ok = true;
    const base = await start(() => ok);
    const up = await fetch(`${base}/healthz`);
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("ok\n");
    expect(up.headers.get("content-type")).toBe("text/plain");
    expect(up.headers.get("x-content-type-options")).toBe("nosniff");
    ok = false;
    const down = await fetch(`${base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("unavailable\n");
  });

  it("answers nothing else", async () => {
    const base = await start(() => true);
    for (const path of ["/", "/stream", "/healthz/", "//healthz", "/x/../healthz"]) expect(await rawStatus(base, path)).toBe(404);
    expect(await rawStatus(base, "/healthz?probe=1")).toBe(200);
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
  });

  it("leaves /healthz to itself when the stream server has no health check", async () => {
    stream = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => ({ v: 1, t: 1, streams: [] }) });
    const base = `http://127.0.0.1:${await stream.listen()}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
    const response = await fetch(`${base}/stream`);
    expect(response.status).toBe(200);
    await response.body!.cancel();
  });

  it("closes connections that never sent a request, so shutdown does not wait for the client", async () => {
    const base = await start(() => true);
    const socket = await preconnect(base);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await within(health!.close(), 1000);
    health = undefined;
    await within(closed, 1000);
  });

  it("rejects listen when the port is taken", async () => {
    const base = await start(() => true);
    const second = new HealthServer({ host: "127.0.0.1", port: Number(new URL(base).port), healthy: () => true });
    await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
