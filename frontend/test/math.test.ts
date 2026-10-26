import { describe, expect, it } from "vitest";
import { clamp, ease, fract, gaussian, hashString, lerp, mulberry32 } from "../src/util/math";

describe("mulberry32", () => {
  it("is deterministic for a seed and stays in [0, 1)", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const other = mulberry32(12346);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(1)()).not.toBe(other());
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
  });
});

describe("gaussian", () => {
  it("transforms uniform pairs with Box-Muller", () => {
    const seq = (...values: number[]) => () => values.shift() ?? 0;
    expect(gaussian(seq(1 - Math.exp(-0.5), 0))).toBeCloseTo(1);
    expect(gaussian(seq(1 - Math.exp(-2), 0.25))).toBeCloseTo(0);
    expect(gaussian(seq(0, 0))).toBeCloseTo(0);
  });
});

describe("hashString", () => {
  it("hashes deterministically into [0, 1)", () => {
    expect(hashString("")).toBeCloseTo(0x811c9dc5 / 4294967296, 6);
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    for (const s of ["a", "stream-1", "こんにちは"]) {
      const h = hashString(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe("ease, lerp, clamp, fract", () => {
  it("eases exponentially toward the target", () => {
    expect(ease(5, 10, 1, 0)).toBe(5);
    expect(ease(0, 100, 2, 2)).toBeCloseTo(100 * (1 - Math.exp(-1)), 5);
    expect(ease(10, 0, 1, 100)).toBeCloseTo(0, 4);
  });

  it("interpolates, clamps and takes fractional parts", () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(-Infinity, 0, 10)).toBe(0);
    expect(fract(2.25)).toBe(0.25);
    expect(fract(-2.25)).toBe(0.75);
  });
});
