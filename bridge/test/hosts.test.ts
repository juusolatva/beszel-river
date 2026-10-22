import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SystemRecord, SystemStatsRecord } from "../src/beszel/types.js";
import { streamId } from "../src/pipeline/anonymize.js";
import { HostTable } from "../src/pipeline/hosts.js";
import { loadMixConfig } from "../src/pipeline/mix.js";

const salt = "0123456789abcdef-test";
const mix = loadMixConfig(fileURLToPath(new URL("../mix.example.json", import.meta.url)));
const now = new Date("2026-10-22T12:00:00Z");

const system = (id: string, status: SystemRecord["status"] = "up", info: SystemRecord["info"] = { t: 4, cpu: 10, mp: 20 }): SystemRecord => ({ id, name: `host-${id}`, status, info });
const stats = (systemId: string, created: string, cpu: number): SystemStatsRecord => ({ id: `${systemId}-${created}`, system: systemId, type: "1m", created, stats: { cpu, mp: 50, b: [1000, 1000] } });

describe("HostTable", () => {
  it("emits anonymized streams without names or system IDs", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("sysA"));
    const frame = table.frame(now);
    expect(frame.v).toBe(1);
    expect(frame.t).toBe(now.getTime());
    expect(frame.streams).toHaveLength(1);
    expect(frame.streams[0]?.id).toBe(streamId(salt, "sysA"));
    expect(JSON.stringify(frame)).not.toMatch(/sysA|host-/);
  });

  it("leaves paused hosts out and marks down and pending ones not alive", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("up"));
    table.upsertSystem(system("down", "down"));
    table.upsertSystem(system("pending", "pending"));
    table.upsertSystem(system("paused", "paused"));
    const alive = Object.fromEntries(table.frame(now).streams.map((s) => [s.id, s.alive]));
    expect(alive).toEqual({ [streamId(salt, "up")]: true, [streamId(salt, "down")]: false, [streamId(salt, "pending")]: false });
  });

  it("reports status changes and removal", () => {
    const table = new HostTable(salt, mix);
    expect(table.upsertSystem(system("a"))).toBe(true);
    expect(table.upsertSystem(system("a"))).toBe(false);
    expect(table.upsertSystem(system("a", "down"))).toBe(true);
    expect(table.removeSystem("a")).toBe(true);
    expect(table.frame(now).streams).toHaveLength(0);
  });

  it("mixes stats in time order and ignores older or unknown records", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", null));
    expect(table.addStats(stats("a", "2026-10-22 11:58:00.000Z", 100))).toBe(true);
    expect(table.frame(now).streams[0]?.flow).toBe(0.7);
    expect(table.addStats(stats("a", "2026-10-22 11:57:00.000Z", 0))).toBe(false);
    expect(table.addStats(stats("unknown", "2026-10-22 11:59:00.000Z", 0))).toBe(false);
    expect(table.addStats(stats("a", "2026-10-22 11:59:00.000Z", 0))).toBe(true);
    // CPU dropped to 0, so flow decays from 0.7 over the 60 s gap with the template's time constant.
    expect(table.frame(now).streams[0]?.flow).toBeCloseTo(0.7 * Math.exp(-60 / mix.channels.flow.tau), 3);
  });

  it("uses the info summary until the first stats record", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", { t: 4, cpu: 100, mp: 0 }));
    expect(table.frame(now).streams[0]?.flow).toBe(0.7);
  });

  it("treats Beszel's zero-filled info for unreachable hosts as unknown", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("big", "up", { t: 32 }));
    table.upsertSystem(system("small", "up", { t: 2 }));
    // As sent by Beszel 0.21.0 for a system it cannot reach.
    table.upsertSystem(system("unreachable", "down", { dt: 0, bb: 0, la: [0, 0, 0], t: 0, cpu: 0, mp: 0 }));
    const streams = new Map(table.frame(now).streams.map((s) => [s.id, s]));
    expect(streams.get(streamId(salt, "unreachable"))).toMatchObject({ alive: false, width: 0.5, heat: 0.5 });
    expect(streams.get(streamId(salt, "big"))?.width).toBe(1);
    expect(streams.get(streamId(salt, "small"))?.width).toBe(0);
  });

  it("rounds channels to three decimals", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", { t: 3, cpu: 33.3333, mp: 66.6666 }));
    for (const value of Object.values(table.frame(now).streams[0] ?? {})) {
      if (typeof value === "number") expect(Math.round(value * 1000) / 1000).toBe(value);
    }
  });
});
