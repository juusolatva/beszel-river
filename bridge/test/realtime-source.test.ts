import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RealtimeSource } from "../src/beszel/realtime-source.js";
import type PocketBase from "pocketbase";
import type { SystemStats } from "../src/beszel/types.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

describe("RealtimeSource", () => {
  let pb: any;
  let onStats: (systemId: string, stats: SystemStats) => void;
  let source: RealtimeSource;

  beforeEach(() => {
    pb = {
      realtime: {
        subscribe: vi.fn(),
        unsubscribeByPrefix: vi.fn(),
      },
    };
    onStats = vi.fn();
    source = new RealtimeSource(pb as unknown as PocketBase, onStats);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to new systems successfully", async () => {
    const unsubscribeFunc = vi.fn();
    pb.realtime.subscribe.mockResolvedValue(unsubscribeFunc);

    source.sync(["sys1"]);

    await vi.runAllTimersAsync();

    expect(pb.realtime.subscribe).toHaveBeenCalledWith(
      "rt_metrics",
      expect.any(Function),
      { query: { system: "sys1" } }
    );
  });

  it("unsubscribes from removed systems", async () => {
    const unsubscribeFunc = vi.fn();
    pb.realtime.subscribe.mockResolvedValue(unsubscribeFunc);

    source.sync(["sys1"]);
    await vi.runAllTimersAsync();

    source.sync([]);
    await vi.runAllTimersAsync();

    expect(unsubscribeFunc).toHaveBeenCalled();
  });

  it("handles subscription failure and cleans up the refused topic", async () => {
    const error = new Error("Subscription failed");
    pb.realtime.subscribe.mockRejectedValue(error);
    pb.realtime.unsubscribeByPrefix.mockResolvedValue(undefined);

    const expectedTopicKey = `rt_metrics?options=${encodeURIComponent(JSON.stringify({ query: { system: "sys1" } }))}`;

    source.sync(["sys1"]);

    await vi.runAllTimersAsync();

    expect(pb.realtime.subscribe).toHaveBeenCalled();
    expect(pb.realtime.unsubscribeByPrefix).toHaveBeenCalledWith(expectedTopicKey);

    pb.realtime.subscribe.mockClear();
    source.sync(["sys1"]);
    await vi.runAllTimersAsync();
    expect(pb.realtime.subscribe).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    source.sync(["sys1"]);
    await vi.runAllTimersAsync();
    expect(pb.realtime.subscribe).toHaveBeenCalled();
  });
});
