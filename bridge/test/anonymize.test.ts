import { describe, expect, it } from "vitest";
import { bandOrder, bandWidths, filamentOrder, streamId } from "../src/pipeline/anonymize.js";

const salt = "0123456789abcdef-test";

describe("streamId", () => {
  it("is 8 hex characters, stable, and depends on the salt", () => {
    const id = streamId(salt, "abc123");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(streamId(salt, "abc123")).toBe(id);
    expect(streamId(`${salt}x`, "abc123")).not.toBe(id);
    expect(id).not.toContain("abc123");
  });
});

describe("bandOrder", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `system${i}`);

  it("is a permutation that is stable within a UTC day", () => {
    const morning = bandOrder(salt, ids, new Date("2026-10-22T01:00:00Z"));
    expect([...morning].sort()).toEqual(ids);
    expect(bandOrder(salt, [...ids].reverse(), new Date("2026-10-22T23:00:00Z"))).toEqual(morning);
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
  it("quantizes a log scale between the smallest and largest host", () => {
    const widths = bandWidths(new Map([["a", 2], ["b", 4], ["c", 8], ["d", 32]]));
    expect([...widths.values()]).toEqual([0, 0.25, 0.5, 1]);
  });

  it("is 0.5 when all hosts are equal", () => {
    expect([...bandWidths(new Map([["a", 4], ["b", 4]])).values()]).toEqual([0.5, 0.5]);
  });
});
