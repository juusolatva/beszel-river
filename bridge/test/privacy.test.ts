// What leaves the bridge, checked end to end through the pipeline and the server: the invariants in
// AGENTS.md, for hosts of every shape at once, so a regression in any one module shows here.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Frame } from "@beszel-river/shared";
import type { SystemRecord, SystemStats } from "../src/beszel/types.js";
import { HostTable } from "../src/pipeline/hosts.js";
import { loadMixConfig } from "../src/pipeline/mix.js";
import { StreamServer } from "../src/server.js";

const salt = "0123456789abcdef-test";
const mix = loadMixConfig(fileURLToPath(new URL("../mix.example.json", import.meta.url)));
const t0 = Date.parse("2026-10-26T12:00:00Z");

/** Every Beszel field name the bridge reads (see src/beszel/types.ts), and `name`; none may reach a frame. */
const BESZEL_FIELDS = ["cpum", "mp", "bb", "bm", "la", "dt", "ns", "nr", "dio", "dr", "dw", "cpus", "info", "stats", "status", "system", "name", "created"];
const STREAM_KEYS = ["id", "alive", "width", "flow", "density", "turbulence", "pulse", "heat", "filaments"];

// The records carry hostnames, as from a hub that ignored the fields filter.
const hosts: { record: SystemRecord & { name: string }; stats: SystemStats }[] = [
  { record: { id: "sysidsingle0001", name: "nas-single-core", status: "up", info: { cpu: 3, mp: 40, t: 1 } }, stats: { cpu: 3.14159, mp: 41.5, cpus: [3.14159] } },
  { record: { id: "sysiddual000002", name: "pi-dual.lan", status: "up", info: { cpu: 50, t: 2 } }, stats: { cpu: 50, b: [123456, 654321], cpus: [12.3456, 87.6543] } },
  { record: { id: "sysidmany000003", name: "build-server-64", status: "up", info: { cpu: 80, t: 128, la: [9, 8, 7] } }, stats: { cpu: 80.0001, dio: [1e7, 2e7], t: { cpu_temp: 71.25 }, cpus: Array.from({ length: 64 }, (_, i) => (i * 37.7) % 100) } },
  { record: { id: "sysidnocores004", name: "old-agent", status: "up", info: null }, stats: { cpu: 10, ns: 0.5, nr: 1.5, dr: 2, dw: 3 } },
  { record: { id: "sysiddown000005", name: "router-down", status: "down", info: { cpu: 0, mp: 0, t: 0 } }, stats: {} },
  { record: { id: "sysidpause00006", name: "paused-host", status: "paused", info: { cpu: 1, t: 8 } }, stats: { cpu: 1 } },
];

function buildTable(): HostTable {
  const table = new HostTable(salt, mix, () => 0.5);
  for (const { record } of hosts) table.upsertSystem(record);
  for (const { record, stats } of hosts) {
    table.addStats({ id: `${record.id}-1m`, system: record.id, type: "1m", created: "2026-10-26 12:00:00.000Z", stats }, t0);
    for (let s = 1; s <= 5; s++) table.addRealtime(record.id, stats, t0 + s * 1000);
  }
  table.tick(0.5, t0 + 5500);
  return table;
}

let server: StreamServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The snapshot event as a viewer receives it. */
async function snapshotText(table: HostTable, now = new Date(t0 + 6000)): Promise<string> {
  server = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => table.frame(now), healthy: () => true });
  const response = await fetch(`http://127.0.0.1:${await server.listen()}/stream`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!/event: snapshot\ndata: .*\n\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  return text;
}

describe("what leaves the bridge", () => {
  it("publishes no persistent stream IDs across UTC days", async () => {
    const table = buildTable();
    const first = await snapshotText(table, new Date("2026-10-26T23:59:59.999Z"));
    await server!.close();
    const second = await snapshotText(table, new Date("2026-10-27T00:00:00Z"));
    const ids = (text: string): string[] => [...text.matchAll(/"id":"([0-9a-f]{8})"/g)].map((match) => match[1]);
    expect(ids(first)).toHaveLength(hosts.length - 1);
    expect(ids(second)).toHaveLength(hosts.length - 1);
    for (const id of ids(first)) expect(ids(second)).not.toContain(id);
  });

  it("carries no system IDs, hostnames or Beszel field names", async () => {
    const text = await snapshotText(buildTable());
    expect(text).toContain("event: snapshot");
    for (const { record } of hosts) {
      expect(text).not.toContain(record.id);
      expect(text).not.toContain(record.name);
    }
    expect(text).not.toMatch(/sysid|host|lan|cpu_temp/);
    for (const field of BESZEL_FIELDS) expect(text).not.toContain(`"${field}"`);
  });

  it("has only the Stream channels, rounded to 3 decimals, and 6 filaments whatever the core count", async () => {
    const text = await snapshotText(buildTable());
    const frame = JSON.parse(/data: (.*)\n/.exec(text.slice(text.indexOf("event: snapshot")))![1]) as Frame;
    expect(Object.keys(frame).sort()).toEqual(["streams", "t", "v"]);
    // Paused hosts are left out.
    expect(frame.streams).toHaveLength(hosts.length - 1);
    let withFilaments = 0;
    for (const stream of frame.streams) {
      for (const key of Object.keys(stream)) expect(STREAM_KEYS).toContain(key);
      expect(stream.id).toMatch(/^[0-9a-f]{8}$/);
      const numbers = [stream.width, stream.flow, stream.density, stream.turbulence, stream.pulse, stream.heat, ...(stream.filaments ?? [])];
      for (const n of numbers) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
        expect(Math.round(n * 1000) / 1000).toBe(n);
      }
      if (stream.filaments) {
        withFilaments++;
        expect(stream.filaments).toHaveLength(6);
      }
    }
    // The 1-, 2- and 64-core hosts all send the same shape.
    expect(withFilaments).toBe(3);
    // Short stats keys that BESZEL_FIELDS leaves out ("t" is also the frame's own timestamp).
    expect(/"(cpu|b)":/.test(text)).toBe(false);
  });
});
