import { afterEach, describe, expect, it } from "vitest";
import type { Frame } from "@beszel-river/shared";
import { StreamServer } from "../src/server.js";

const frame = (t: number): Frame => ({ v: 1, t, streams: [] });

let server: StreamServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(healthy = true, maxClients?: number, onClients?: (count: number) => void): Promise<string> {
  server = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => frame(1), healthy: () => healthy, pingMs: 50, ...(maxClients ? { maxClients } : {}), ...(onClients ? { onClients } : {}) });
  return `http://127.0.0.1:${await server.listen()}`;
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

describe("StreamServer", () => {
  it("sends retry and a snapshot on connect, then broadcasts and pings", async () => {
    const base = await start();
    const response = await fetch(`${base}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

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
});
