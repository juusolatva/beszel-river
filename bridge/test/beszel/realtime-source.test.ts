import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type PocketBase from "pocketbase";
import { RealtimeSource } from "../../src/beszel/realtime-source.js";
import * as logModule from "../../src/log.js";
import type { RealtimeData } from "../../src/beszel/types.js";

vi.mock("../../src/log.js", () => ({
  log: vi.fn(),
}));

describe("RealtimeSource", () => {
  let pb: any;
  let onStats: any;
  let source: RealtimeSource;

  beforeEach(() => {
    pb = {
      realtime: {
        subscribe: vi.fn(),
        unsubscribeByPrefix: vi.fn().mockResolvedValue(undefined),
      },
    };
    onStats = vi.fn();
    source = new RealtimeSource(pb as unknown as PocketBase, onStats);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("subscribes and unsubscribes to systems", async () => {
    const unsubscribeSys1 = vi.fn();
    const unsubscribeSys2 = vi.fn();

    pb.realtime.subscribe.mockImplementation(async (topic: string, callback: any, options: any) => {
      if (options.query.system === "sys1") return unsubscribeSys1;
      if (options.query.system === "sys2") return unsubscribeSys2;
      return vi.fn();
    });

    source.sync(["sys1", "sys2"]);
    await vi.runAllTimersAsync();

    expect(pb.realtime.subscribe).toHaveBeenCalledTimes(2);
    expect(logModule.log).toHaveBeenCalledWith("info", "Realtime metrics on for 2 systems");

    // Test receiving stats
    const callbackSys1 = pb.realtime.subscribe.mock.calls[0][1];
    callbackSys1({ stats: { cpu: 10 } } as RealtimeData);
    expect(onStats).toHaveBeenCalledWith("sys1", { cpu: 10 });

    // Ignore updates without stats
    callbackSys1({} as RealtimeData);
    expect(onStats).toHaveBeenCalledTimes(1);

    // Unsubscribe sys1
    source.sync(["sys2"]);
    await vi.runAllTimersAsync();

    expect(unsubscribeSys1).toHaveBeenCalled();
    expect(unsubscribeSys2).not.toHaveBeenCalled();

    // Unsubscribe all
    source.sync([]);
    await vi.runAllTimersAsync();

    expect(unsubscribeSys2).toHaveBeenCalled();
    expect(logModule.log).toHaveBeenCalledWith("info", "Realtime metrics off");
  });

  it("handles subscription error", async () => {
    const error = new Error("Subscription failed");
    pb.realtime.subscribe.mockRejectedValueOnce(error);

    source.sync(["sys1"]);
    await vi.runAllTimersAsync();

    expect(pb.realtime.unsubscribeByPrefix).toHaveBeenCalledWith(
      'rt_metrics?options=%7B%22query%22%3A%7B%22system%22%3A%22sys1%22%7D%7D'
    );
    expect(logModule.log).toHaveBeenCalledWith("warn", "Realtime subscription refused, retrying every 60 s", error);

    // Test retry logic
    pb.realtime.subscribe.mockClear();

    // Sync before RETRY_MS shouldn't retry
    source.sync(["sys1"], Date.now() + 30000);
    await vi.runAllTimersAsync();
    expect(pb.realtime.subscribe).not.toHaveBeenCalled();

    // Sync after RETRY_MS should retry
    const unsubscribe = vi.fn();
    pb.realtime.subscribe.mockResolvedValueOnce(unsubscribe);

    source.sync(["sys1"], Date.now() + 65000);
    await vi.runAllTimersAsync();
    expect(pb.realtime.subscribe).toHaveBeenCalled();
  });

  it("handles unsubscribeByPrefix error when subscription fails", async () => {
    const error = new Error("Subscription failed");
    pb.realtime.subscribe.mockRejectedValueOnce(error);
    // Make unsubscribeByPrefix fail as well
    pb.realtime.unsubscribeByPrefix.mockRejectedValueOnce(new Error("Cleanup failed"));

    source.sync(["sys1"]);
    await vi.runAllTimersAsync();

    expect(pb.realtime.unsubscribeByPrefix).toHaveBeenCalledWith(
      'rt_metrics?options=%7B%22query%22%3A%7B%22system%22%3A%22sys1%22%7D%7D'
    );
    // Should still log the original subscription refusal warning
    expect(logModule.log).toHaveBeenCalledWith("warn", "Realtime subscription refused, retrying every 60 s", error);
  });

  it("does not log a warning if a system is already in the refused list when subscribe fails again", async () => {
    const error1 = new Error("Subscription failed first time");
    pb.realtime.subscribe.mockRejectedValueOnce(error1);

    source.sync(["sys1"]);
    await vi.runAllTimersAsync();

    expect(logModule.log).toHaveBeenCalledWith("warn", "Realtime subscription refused, retrying every 60 s", error1);
    vi.mocked(logModule.log).mockClear();

    // Fast-forward fake timers past RETRY_MS to allow retry
    vi.advanceTimersByTime(65000);

    const error2 = new Error("Subscription failed second time");
    pb.realtime.subscribe.mockRejectedValueOnce(error2);

    source.sync(["sys1"], Date.now() + 65000);
    await vi.runAllTimersAsync();

    // Shouldn't log the warning again because it was already in the refused list
    expect(logModule.log).not.toHaveBeenCalledWith("warn", "Realtime subscription refused, retrying every 60 s", expect.any(Error));
  });

  it("handles unsubscribe error", async () => {
    const unsubscribeSys1 = vi.fn().mockRejectedValue(new Error("Unsubscribe error"));

    pb.realtime.subscribe.mockResolvedValueOnce(unsubscribeSys1);

    source.sync(["sys1"]);
    await vi.runAllTimersAsync();

    source.sync([]);
    await vi.runAllTimersAsync();

    expect(logModule.log).toHaveBeenCalledWith("warn", "Realtime unsubscribe failed", expect.any(Error));
  });
});
