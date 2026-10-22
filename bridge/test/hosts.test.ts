import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SystemRecord, SystemStatsRecord } from "../src/beszel/types.js";
import { streamId } from "../src/pipeline/anonymize.js";
import { coreProfile } from "../src/pipeline/features.js";
import { HostTable, REALTIME_STALE_MS } from "../src/pipeline/hosts.js";
import { loadMixConfig, parseMixConfig } from "../src/pipeline/mix.js";

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

  it("scatters a minute record's pulse over the following minute", () => {
    const t0 = Date.parse("2026-10-22T12:00:00Z");
    const table = new HostTable(salt, mix, () => 0.5);
    table.upsertSystem(system("a", "up", null));
    table.addStats(stats("a", "2026-10-22 11:58:00.000Z", 0), t0);
    // A CPU rise of 80 points: burst 1, so pulse 1. First pulse at 2.5 s, two more at 25 s.
    table.addStats(stats("a", "2026-10-22 11:59:00.000Z", 80), t0);
    const pulseOf = () => table.frame(now).streams[0]?.pulse;
    expect(pulseOf()).toBe(0);
    expect(table.decay(2, t0 + 2000)).toBe(false);
    expect(table.decay(2, t0 + 4000)).toBe(true);
    expect(pulseOf()).toBe(1);
    for (let t = 6000; t <= 24_000; t += 2000) table.decay(2, t0 + t);
    expect(pulseOf()).toBeLessThan(0.1);
    expect(table.decay(2, t0 + 26_000)).toBe(true);
    expect(pulseOf()).toBe(0.6);
  });

  it("rounds channels to three decimals", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", { t: 3, cpu: 33.3333, mp: 66.6666 }));
    for (const value of Object.values(table.frame(now).streams[0] ?? {})) {
      if (typeof value === "number") expect(Math.round(value * 1000) / 1000).toBe(value);
    }
  });
});

describe("HostTable realtime", () => {
  const t0 = Date.parse("2026-10-22T12:00:00Z");
  const flowOf = (table: HostTable) => table.frame(now).streams[0]?.flow;

  it("mixes realtime samples and holds minute records back while they arrive", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", null));
    expect(table.addRealtime("a", { cpu: 100 }, t0)).toBe(true);
    expect(flowOf(table)).toBe(0.7);
    expect(table.addStats(stats("a", "2026-10-22 12:00:00.000Z", 0), t0 + REALTIME_STALE_MS - 1)).toBe(false);
    expect(flowOf(table)).toBe(0.7);
    // Realtime stopped: minute records count again.
    expect(table.addStats(stats("a", "2026-10-22 12:01:00.000Z", 0), t0 + REALTIME_STALE_MS)).toBe(true);
    expect(flowOf(table)).toBeCloseTo(0.7 * Math.exp(-60 / mix.channels.flow.tau), 3);
  });

  it("smooths realtime samples over the time between them", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", null));
    table.addRealtime("a", { cpu: 100 }, t0);
    table.addRealtime("a", { cpu: 0 }, t0 + 3000);
    expect(flowOf(table)).toBeCloseTo(0.7 * Math.exp(-3 / mix.channels.flow.tau), 3);
  });

  it("counts rises between realtime samples as bursts, but not the step from a minute average", () => {
    const fromRealtime = new HostTable(salt, mix);
    fromRealtime.upsertSystem(system("a", "up", null));
    fromRealtime.addRealtime("a", { cpu: 0 }, t0);
    fromRealtime.addRealtime("a", { cpu: 80 }, t0 + 1000);
    expect(fromRealtime.frame(now).streams[0]?.pulse).toBe(1);

    const fromMinute = new HostTable(salt, mix);
    fromMinute.upsertSystem(system("a", "up", null));
    fromMinute.addStats(stats("a", "2026-10-22 11:59:00.000Z", 0), t0);
    fromMinute.addRealtime("a", { cpu: 80, b: [1000, 1000] }, t0 + 1000);
    expect(fromMinute.frame(now).streams[0]?.pulse).toBe(0);
  });

  it("drops scattered pulses when realtime samples take over", () => {
    const table = new HostTable(salt, mix, () => 0.5);
    table.upsertSystem(system("a", "up", null));
    table.addStats(stats("a", "2026-10-22 11:58:00.000Z", 0), t0);
    table.addStats(stats("a", "2026-10-22 11:59:00.000Z", 80), t0);
    table.addRealtime("a", { cpu: 80 }, t0 + 1000);
    expect(table.decay(2, t0 + 60_000)).toBe(false);
    expect(table.frame(now).streams[0]?.pulse).toBe(0);
  });

  it("keeps realtime samples out of the 24 h baseline", () => {
    // flow follows the network level directly, to read the baseline's reference back.
    const byNet = parseMixConfig({ flow: { inputs: { net: 1 } }, density: { inputs: {} }, turbulence: { inputs: {} }, pulse: { inputs: {} }, heat: { inputs: {} }, pulseDecay: 8 });
    const table = new HostTable(salt, byNet);
    table.upsertSystem(system("a", "up", null));
    const MB = 1024 * 1024;
    table.addStats({ ...stats("a", "2026-10-22 11:59:00.000Z", 0), stats: { b: [MB / 2, MB / 2] } }, t0);
    for (let i = 0; i < 100; i++) table.addRealtime("a", { b: [50 * MB, 50 * MB] }, t0 + i * 1000);
    table.addRealtime("a", { b: [MB / 2, MB / 2] }, t0 + 100_000);
    // At the minute records' 1 MB/s reference; 100 MB/s would give 0.15.
    expect(flowOf(table)).toBe(1);
  });

  it("ignores realtime samples for unknown and paused hosts", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("paused", "paused"));
    expect(table.addRealtime("paused", { cpu: 50 }, t0)).toBe(false);
    expect(table.addRealtime("unknown", { cpu: 50 }, t0)).toBe(false);
  });

  it("targets only hosts that are up", () => {
    const table = new HostTable(salt, mix);
    for (const status of ["up", "down", "paused", "pending"] as const) table.upsertSystem(system(status, status));
    table.upsertSystem(system("up2"));
    expect(table.realtimeTargets().sort()).toEqual(["up", "up2"]);
  });

  it("sends six filaments from per-core usage, in a daily order, and none without it", () => {
    const table = new HostTable(salt, mix);
    table.upsertSystem(system("a", "up", null));
    table.upsertSystem(system("b", "up", null));
    table.addRealtime("a", { cpu: 50, cpus: [10, 90, 35, 70] }, t0);
    table.addRealtime("b", { cpu: 50 }, t0);
    const streams = new Map(table.frame(now).streams.map((s) => [s.id, s]));
    const filaments = streams.get(streamId(salt, "a"))?.filaments ?? [];
    expect(filaments).toHaveLength(6);
    const { bias, center, weight } = mix.filaments;
    const expected = (coreProfile([10, 90, 35, 70]) as number[]).map((v) => Math.round(Math.min(1, Math.max(0, bias + weight * (v - center))) * 1000) / 1000);
    expect([...filaments].sort()).toEqual([...expected].sort());
    expect(streams.get(streamId(salt, "b"))).not.toHaveProperty("filaments");
  });
});
