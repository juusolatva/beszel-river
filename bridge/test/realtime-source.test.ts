import type PocketBase from "pocketbase";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeSource } from "../src/beszel/realtime-source.js";
import type { RealtimeData, SystemStats } from "../src/beszel/types.js";
import { log } from "../src/log.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

function createPb() {
  const subscribe = vi.fn<(topic: string, callback: (data: RealtimeData) => void, options?: { query?: { system?: string } }) => Promise<() => Promise<void>>>();
  const unsubscribeByPrefix = vi.fn<(prefix: string) => Promise<void>>().mockResolvedValue(undefined);
  return { pb: { realtime: { subscribe, unsubscribeByPrefix } } as unknown as PocketBase, subscribe, unsubscribeByPrefix };
}

describe("RealtimeSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes to wanted systems, forwards stats, and unsubscribes removed ones", async () => {
    const { pb, subscribe } = createPb();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    let callback: ((data: RealtimeData) => void) | undefined;
    subscribe.mockImplementation(async (_topic, cb) => {
      callback = cb;
      return unsubscribe;
    });

    const received: [string, SystemStats][] = [];
    const source = new RealtimeSource(pb, (id, stats) => received.push([id, stats]));

    source.sync(["sys1"]);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledWith("rt_metrics", expect.any(Function), { query: { system: "sys1" } }));

    callback?.({});
    callback?.({ stats: { cpu: 42 } });
    expect(received).toEqual([["sys1", { cpu: 42 }]]);

    source.sync([]);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("isolates a refused system, drops its topic, and retries after 60 s", async () => {
    const { pb, subscribe, unsubscribeByPrefix } = createPb();
    subscribe.mockImplementation(async (_topic, _cb, options) => {
      if (options?.query?.system === "bad") throw new Error("404");
      return async () => undefined;
    });

    const source = new RealtimeSource(pb, () => undefined);
    const t0 = 1_000_000;

    source.sync(["bad", "good"], t0);
    const badKey = `rt_metrics?options=${encodeURIComponent(JSON.stringify({ query: { system: "bad" } }))}`;
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    expect(unsubscribeByPrefix).toHaveBeenCalledWith(badKey);

    subscribe.mockClear();
    source.sync(["bad", "good"], t0 + 59_999);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscribe).not.toHaveBeenCalled();

    source.sync(["bad", "good"], t0 + 60_000);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledWith("rt_metrics", expect.any(Function), { query: { system: "bad" } }));
  });

  it("logs failed unsubscribes and tolerates a failed topic cleanup, and keeps going", async () => {
    const { pb, subscribe, unsubscribeByPrefix } = createPb();
    unsubscribeByPrefix.mockRejectedValue(new Error("gone"));
    subscribe.mockImplementation(async (_topic, _cb, options) => {
      if (options?.query?.system === "bad") throw new Error("404");
      return async () => {
        throw new Error("unsubscribe failed");
      };
    });

    const source = new RealtimeSource(pb, () => undefined);
    source.sync(["bad", "good"]);
    expect(log).toHaveBeenCalledWith("info", "Realtime metrics on for 2 systems");
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Realtime subscription refused"), expect.any(Error)));

    source.sync([]);
    expect(log).toHaveBeenCalledWith("info", "Realtime metrics off");
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("warn", "Realtime unsubscribe failed", expect.any(Error)));

    source.sync(["good"]);
    expect(log).toHaveBeenCalledWith("info", "Realtime metrics on for 1 system");
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(3));
  });
});
