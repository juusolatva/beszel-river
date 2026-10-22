import { describe, expect, it } from "vitest";
import { clamp, ease, fract, gaussian, hashString, lerp, mulberry32 } from "./math";

describe("mulberry32", () => {
  it("returns predictable sequences for a given seed", () => {
    const random1 = mulberry32(12345);
    const random2 = mulberry32(12345);

    expect(random1()).toBe(random2());
    expect(random1()).toBe(random2());
  });

  it("returns different values for different seeds", () => {
    const random1 = mulberry32(12345);
    const random2 = mulberry32(54321);

    expect(random1()).not.toBe(random2());
  });

  it("returns values between 0 and 1", () => {
    const random = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const val = random();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe("gaussian", () => {
  it("returns a number", () => {
    const random = mulberry32(12345);
    expect(typeof gaussian(random)).toBe("number");
  });
});

describe("hashString", () => {
  it("returns consistent hashes for the same string", () => {
    expect(hashString("test string")).toBe(hashString("test string"));
  });

  it("returns different hashes for different strings", () => {
    expect(hashString("test string 1")).not.toBe(hashString("test string 2"));
  });

  it("returns values between 0 and 1", () => {
    const hash = hashString("test");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(1);
  });
});

describe("ease", () => {
  it("moves current towards target", () => {
    expect(ease(0, 10, 1, 0.5)).toBeGreaterThan(0);
    expect(ease(0, 10, 1, 0.5)).toBeLessThan(10);
  });

  it("reaches target immediately if dt is very large", () => {
    expect(ease(0, 10, 1, 1000)).toBeCloseTo(10);
  });

  it("doesn't move if dt is 0", () => {
    expect(ease(0, 10, 1, 0)).toBe(0);
  });
});

describe("lerp", () => {
  it("interpolates between two values", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
  });
});

describe("clamp", () => {
  it("clamps a value to a range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("fract", () => {
  it("returns the fractional part of a number", () => {
    expect(fract(1.5)).toBe(0.5);
    expect(fract(-1.5)).toBe(0.5);
    expect(fract(1)).toBe(0);
  });
}
);
