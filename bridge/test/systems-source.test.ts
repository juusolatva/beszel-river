import type PocketBase from "pocketbase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemsSource, type SystemsHandlers } from "../src/beszel/systems-source.js";
import type { SystemRecord, SystemStatsRecord } from "../src/beszel/types.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

type Event<T> = { action: string; record: T };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Fake PocketBase whose list requests stay pending until the test resolves them. */
function createPb() {
  const callbacks = new Map<string, (event: Event<never>) => void>();
  const lists = { systems: deferred<SystemRecord[]>(), system_stats: deferred<SystemStatsRecord[]>() };
  const subscribe = vi.fn<(topic: string, callback: (event: Event<never>) => void, options: object) => Promise<void>>().mockResolvedValue(undefined);
  const getFullList = vi.fn();
  const filter = vi.fn((expression: string, params: object) => ({ expression, params }));
  const pb = {
    filter,
    collection: (name: keyof typeof lists) => ({
      subscribe: async (topic: string, callback: (event: Event<never>) => void, options: object) => {
        callbacks.set(name, callback);
        return subscribe(topic, callback, options);
      },
      getFullList: (options: object) => {
        getFullList(name, options);
        return lists[name].promise;
      },
    }),
  } as unknown as PocketBase;
  const emit = <T>(name: keyof typeof lists, event: Event<T>): void => callbacks.get(name)?.(event as Event<never>);
  return { pb, lists, emit, subscribe, getFullList, filter };
}

const system = (id: string, status: SystemRecord["status"] = "up"): SystemRecord => ({ id, status, info: null });
const record = (id: string, created: string): SystemStatsRecord => ({ id, system: "a", type: "1m", created, stats: {} });

function recorder(): { calls: string[]; handlers: SystemsHandlers } {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      system: (r) => calls.push(`system ${r.id} ${r.status}`),
      removed: (id) => calls.push(`removed ${id}`),
      history: (r) => calls.push(`history ${r.id}`),
      stats: (r) => calls.push(`stats ${r.id}`),
    },
  };
}

/** Lets the awaits inside `start` run up to its next pending request. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("SystemsSource", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds back changes during loading and applies them after the lists, live stats in time order", async () => {
    const { pb, lists, emit } = createPb();
    const { calls, handlers } = recorder();
    const started = new SystemsSource(pb, handlers).start();

    await settle();
    emit("systems", { action: "update", record: system("a", "down") });
    lists.systems.resolve([system("a"), system("b")]);
    await settle();
    emit("systems", { action: "delete", record: system("b") });
    emit("system_stats", { action: "create", record: record("live2", "2026-10-26 12:00:02") });
    emit("system_stats", { action: "create", record: record("live1", "2026-10-26 12:00:01") });
    expect(calls).toEqual([]);

    lists.system_stats.resolve([record("h1", "2026-10-26 11:00:00"), record("h2", "2026-10-26 11:01:00")]);
    await started;
    expect(calls).toEqual(["system a up", "system b up", "system a down", "removed b", "history h1", "history h2", "stats live1", "stats live2"]);
  });

  it("passes changes straight through once loaded, and ignores stats updates and deletes", async () => {
    const { pb, lists, emit } = createPb();
    const { calls, handlers } = recorder();
    lists.systems.resolve([]);
    lists.system_stats.resolve([]);
    await new SystemsSource(pb, handlers).start();

    emit("systems", { action: "create", record: system("c") });
    emit("systems", { action: "delete", record: system("c") });
    emit("system_stats", { action: "update", record: record("x", "2026-10-26 12:00:00") });
    emit("system_stats", { action: "delete", record: record("y", "2026-10-26 12:00:00") });
    emit("system_stats", { action: "create", record: record("z", "2026-10-26 12:00:00") });
    expect(calls).toEqual(["system c up", "removed c", "stats z"]);
  });

  it("subscribes to 1m records only and loads the last historyHours, oldest first", async () => {
    const { pb, lists, subscribe, getFullList, filter } = createPb();
    lists.systems.resolve([]);
    lists.system_stats.resolve([]);
    await new SystemsSource(pb, recorder().handlers).start(2);

    expect(subscribe).toHaveBeenCalledWith("*", expect.any(Function), { fields: "id,status,info" });
    expect(subscribe).toHaveBeenCalledWith("*", expect.any(Function), { filter: 'type = "1m"', fields: "id,system,type,created,stats" });
    expect(filter).toHaveBeenCalledWith("type = '1m' && created >= {:since}", { since: new Date("2026-10-26T10:00:00Z") });
    expect(getFullList).toHaveBeenCalledWith("system_stats", expect.objectContaining({ sort: "created", batch: 1000 }));
    expect(getFullList).toHaveBeenCalledWith("systems", { fields: "id,status,info" });
  });

  it("fails when loading fails, so the caller can retry", async () => {
    const { pb } = createPb();
    pb.collection = (() => ({
      subscribe: vi.fn().mockResolvedValue(undefined),
      getFullList: vi.fn().mockRejectedValue(new Error("403")),
    })) as unknown as PocketBase["collection"];
    await expect(new SystemsSource(pb, recorder().handlers).start()).rejects.toThrow("403");
  });
});
