import { request, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "@beszel-river/shared";
import { StreamServer, type StreamServerOptions } from "../src/server.js";

const frame = (t: number): Frame => ({ v: 1, t, streams: [] });

let server: StreamServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function start(healthy = true, maxClients?: number, onClients?: (count: number) => void, overrides: Partial<StreamServerOptions> = {}): Promise<string> {
  server = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => frame(1), healthy: () => healthy, pingMs: 50, ...(maxClients ? { maxClients } : {}), ...(onClients ? { onClients } : {}), ...overrides });
  return `http://127.0.0.1:${await server.listen()}`;
}

/** Signal a blocked socket deterministically, without filling OS buffers or slowing other readers. */
function stallWhen(matches: (chunk: string) => boolean) {
  const write = ServerResponse.prototype.write;
  let response: ServerResponse | undefined;
  let writes = 0;
  vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (this: ServerResponse, chunk: unknown) {
    const accepted = write.call(this, chunk, "utf8");
    if (!response && matches(String(chunk))) {
      response = this;
      writes++;
      return false;
    }
    if (this === response) writes++;
    return accepted;
  });
  return { get response() { return response; }, get writes() { return writes; } };
}

/** Reads the stream until `until` matches the accumulated text. */
async function read(response: Response, until: RegExp): Promise<string> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!until.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  return text;
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

describe("StreamServer", () => {
  it("sends retry and a snapshot on connect, then broadcasts and pings", async () => {
    const base = await start();
    const response = await fetch(`${base}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const text = read(response, /event: update[\s\S]*: ping/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    server!.broadcast(frame(2));
    expect(await text).toMatch(/^retry: 5000\n\nevent: snapshot\ndata: {"v":1,"t":1,"streams":\[\]}\n\n[\s\S]*event: update\ndata: {"v":1,"t":2,"streams":\[\]}\n\n/);
  });

  it("forgets clients that disconnect", async () => {
    const base = await start();
    const response = await fetch(`${base}/stream`);
    await read(response, /snapshot/);
    expect(server!.clientCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server!.clientCount).toBe(0);
  });

  it("reports the viewer count as streams open and close", async () => {
    const counts: number[] = [];
    const base = await start(true, undefined, (count) => counts.push(count));
    const first = await fetch(`${base}/stream`);
    const second = await fetch(`${base}/stream`);
    await Promise.all([read(first, /snapshot/), read(second, /snapshot/)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it("caps concurrent clients", async () => {
    const base = await start(true, 1);
    const first = await fetch(`${base}/stream`);
    expect((await fetch(`${base}/stream`)).status).toBe(503);
    await first.body!.cancel();
  });

  it.each(["snapshot", "update", "ping"])("evicts a %s that never drains and releases its client slot once", async (kind) => {
    const stalled = stallWhen((chunk) => kind === "ping" ? chunk === ": ping\n\n" : chunk.includes(`event: ${kind}`));
    const counts: number[] = [];
    const base = await start(true, 1, (n) => counts.push(n), { drainTimeoutMs: 100 });
    const response = await fetch(`${base}/stream`);
    if (kind === "update") server!.broadcast(frame(2));
    await vi.waitFor(() => expect(stalled.response).toBeDefined(), { interval: 5 });
    const before = stalled.writes;
    for (let i = 3; i < 100; i++) server!.broadcast(frame(i));
    expect(stalled.writes).toBe(before);
    expect((await fetch(`${base}/stream`)).status).toBe(503);
    await vi.waitFor(() => expect(server!.clientCount).toBe(0), { interval: 5 });
    expect(stalled.response!.destroyed).toBe(true);
    stalled.response!.emit("drain");
    expect(counts).toEqual([1, 0]);
    await response.body!.cancel().catch(() => undefined);
    const next = await fetch(`${base}/stream`);
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });

  it("coalesces blocked updates to the latest frame while healthy readers keep receiving", async () => {
    const stalled = stallWhen((chunk) => chunk.includes("event: snapshot"));
    const base = await start(true, undefined, undefined, { drainTimeoutMs: 1000 });
    const slow = await fetch(`${base}/stream`);
    const healthy = await fetch(`${base}/stream`);
    const received = read(healthy, /event: update/);
    server!.broadcast(frame(2));
    server!.broadcast(frame(3));
    expect(await received).toContain('"t":2');
    expect(stalled.writes).toBe(1);
    const latest = read(slow, /event: update/);
    stalled.response!.emit("drain");
    expect(await latest).toContain('"t":3');
    expect(stalled.writes).toBe(2);
  });

  it("resumes after drain without resending a frame when no update was skipped", async () => {
    const stalled = stallWhen((chunk) => chunk.includes("event: snapshot"));
    const base = await start(true, undefined, undefined, { drainTimeoutMs: 1000 });
    const response = await fetch(`${base}/stream`);
    stalled.response!.emit("drain");
    stalled.response!.emit("drain");
    expect(stalled.writes).toBe(1);
    const received = read(response, /event: update/);
    server!.broadcast(frame(2));
    expect(await received).toContain('"t":2');
  });

  it("bounds a snapshot before enqueueing it", async () => {
    const counts: number[] = [];
    const base = await start(true, undefined, (n) => counts.push(n), { maxBufferedBytes: 1 });
    await expect(fetch(`${base}/stream`)).rejects.toThrow();
    expect(server!.clientCount).toBe(0);
    expect(counts).toEqual([1, 0]);
  });

  it("counts UTF-8 bytes rather than characters when bounding updates", async () => {
    const base = await start(true, undefined, undefined, { maxBufferedBytes: 1024 });
    const response = await fetch(`${base}/stream`);
    const large: Frame = { ...frame(2), streams: [{ id: "🙂".repeat(300), alive: true, width: 0.5, flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 }] };
    expect(JSON.stringify(large).length).toBeLessThan(1024);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(1024);
    server!.broadcast(large);
    expect(server!.clientCount).toBe(0);
    await response.body!.cancel().catch(() => undefined);
  });

  it("destroys blocked output on shutdown instead of waiting for it to flush", async () => {
    const stalled = stallWhen((chunk) => chunk.includes("event: snapshot"));
    const counts: number[] = [];
    const base = await start(true, undefined, (n) => counts.push(n));
    const response = await fetch(`${base}/stream`);
    await server!.close();
    expect(stalled.response!.destroyed).toBe(true);
    expect(counts).toEqual([1, 0]);
    server = undefined;
    await response.body!.cancel().catch(() => undefined);
  });

  it("reports health", async () => {
    expect((await fetch(`${await start(true)}/healthz`)).status).toBe(200);
    await server!.close();
    expect((await fetch(`${await start(false)}/healthz`)).status).toBe(503);
  });

  it("rejects other paths and methods", async () => {
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/stream`, { method: "POST" })).status).toBe(405);
  });

  it("routes on the raw path only, so odd request-targets get 404 and the server keeps serving", async () => {
    const base = await start();
    // None is exactly /stream or /healthz; a URL parser throws on the first three and turns several others into /stream.
    const odd = ["//", "//:/x", "//x:abc/../stream", "//x/stream", "/x/../stream", "/%73tream", "/stream/..\\healthz\\x/..", "http://localhost/stream"];
    for (const path of odd) expect(await rawStatus(base, path)).toBe(404);
    expect(await rawStatus(base, "//", "POST")).toBe(405);
    expect(await rawStatus(base, "/healthz?probe=1")).toBe(200);
    expect(await rawStatus(base, "/stream?x=1")).toBe(200);
  });
});
