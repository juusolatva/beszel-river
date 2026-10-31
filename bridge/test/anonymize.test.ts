import { describe, expect, it } from "vitest";
import { bandOrder, bandWidths, filamentOrder, streamId } from "../src/pipeline/anonymize.js";

const now = new Date("2026-10-22T00:00:00Z");
const salt = "0123456789abcdef-test";

describe("streamId", () => {
  it("is 8 hex characters, stable, and depends on the salt", () => {
    const id = streamId(salt, "abc123", now);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(streamId(salt, "abc123", now)).toBe(id);
    expect(streamId(`${salt}x`, "abc123", now)).not.toBe(id);
    expect(id).not.toContain("abc123");
    expect(streamId(salt, "other", now)).not.toBe(id);
    expect(streamId(salt, "abc123", new Date("2026-10-22T23:59:59.999Z"))).toBe(id);
    expect(streamId(salt, "abc123", new Date("2026-10-23T02:00:00+02:00"))).not.toBe(id);
  });
});

describe("bandOrder", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `system${i}`);

  it("is a permutation that is stable within a UTC day", () => {
    const morning = bandOrder(salt, ids, new Date("2026-10-22T01:00:00Z"));
    expect([...morning].sort()).toEqual(ids);
    expect(bandOrder(salt, [...ids].reverse(), new Date("2026-10-22T23:00:00Z"))).toEqual(morning);
  });

  it("keeps duplicate IDs", () => {
    expect(bandOrder(salt, ["system0", "system0", "system1"], new Date("2026-10-22T12:00:00Z")).sort()).toEqual(["system0", "system0", "system1"]);
  });

  it("changes across days", () => {
    const days = ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map((d) => bandOrder(salt, ids, new Date(`${d}T12:00:00Z`)).join());
    expect(new Set(days).size).toBeGreaterThan(1);
  });
});

describe("filamentOrder", () => {
  const day = (d: string) => new Date(`${d}T12:00:00Z`);

  it("is a permutation that is stable within a UTC day", () => {
    const order = filamentOrder(salt, "abc", 6, day("2026-10-22"));
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(filamentOrder(salt, "abc", 6, new Date("2026-10-22T23:59:00Z"))).toEqual(order);
  });

  it("differs between hosts and days", () => {
    const orders = (ids: string[], days: string[]) => new Set(ids.flatMap((id) => days.map((d) => filamentOrder(salt, id, 6, day(d)).join())));
    expect(orders(["a", "b", "c", "d"], ["2026-10-22"]).size).toBeGreaterThan(1);
    expect(orders(["a"], ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]).size).toBeGreaterThan(1);
  });
});

describe("bandWidths", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `system${i}`);
  const day = (d: string) => new Date(`${d}T12:00:00Z`);

  it("gives every host one of five steps, stable within a UTC day", () => {
    const widths = bandWidths(salt, ids, day("2026-10-22"));
    expect([...widths.keys()]).toEqual(ids);
    expect(new Set(widths.values())).toEqual(new Set([0, 0.25, 0.5, 0.75, 1]));
    expect(bandWidths(salt, ids, new Date("2026-10-22T23:59:00Z"))).toEqual(widths);
  });

  it("changes across days and with the salt", () => {
    const widths = (s: string, d: string) => [...bandWidths(s, ids, day(d)).values()].join();
    expect(widths(salt, "2026-10-23")).not.toBe(widths(salt, "2026-10-22"));
    expect(widths(`${salt}x`, "2026-10-22")).not.toBe(widths(salt, "2026-10-22"));
  });
});
