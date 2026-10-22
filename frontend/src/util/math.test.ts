import { describe, expect, it, vi } from "vitest";
import { fract, lerp, clamp, mulberry32, gaussian, hashString, ease } from "./math.js";

describe("mulberry32", () => {
  it("returns a function that generates pseudo-random numbers", () => {
    const random = mulberry32(12345);
    const val1 = random();
    const val2 = random();
    expect(val1).toBeGreaterThanOrEqual(0);
    expect(val1).toBeLessThan(1);
    expect(val2).toBeGreaterThanOrEqual(0);
    expect(val2).toBeLessThan(1);
    expect(val1).not.toBe(val2);
  });

  it("is deterministic based on the seed", () => {
    const random1 = mulberry32(12345);
    const random2 = mulberry32(12345);
    expect(random1()).toBe(random2());
    expect(random1()).toBe(random2());
  });
});

describe("gaussian", () => {
  it("generates numbers that look like a normal distribution", () => {
    // This is hard to test deterministically without a fixed PRNG,
    // so we'll just check that it runs and returns numbers.
    const mockRandom = vi.fn().mockReturnValue(0.5);
    const result = gaussian(mockRandom);
    expect(typeof result).toBe("number");
  });
});

describe("hashString", () => {
  it("returns a number between 0 and 1", () => {
    const hash = hashString("hello world");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(1);
  });

  it("returns the same value for the same string", () => {
    expect(hashString("test")).toBe(hashString("test"));
  });

  it("returns different values for different strings", () => {
    expect(hashString("test1")).not.toBe(hashString("test2"));
  });
});

describe('gaussian', () => {
  it('should generate numbers using Box-Muller transform and call random twice', () => {
    let callCount = 0;
    const mockRandom = () => {
      callCount++;
      return callCount === 1 ? 0.5 : 0;
    };

    const val = gaussian(mockRandom);
    expect(callCount).toBe(2);
    expect(val).toBeCloseTo(Math.sqrt(-2 * Math.log(0.5)) * Math.cos(0));
  });
describe("ease", () => {
  it("moves current towards target based on time constant and delta time", () => {
    const current = 0;
    const target = 10;
    const tau = 1;
    const dt = 1;

    const result1 = ease(current, target, tau, dt);
    expect(result1).toBeGreaterThan(0);
    expect(result1).toBeLessThan(10);

    // With infinite time, it reaches the target
    expect(ease(current, target, tau, 1000)).toBeCloseTo(10);
  });

  it('should handle typical values for u and v', () => {
    // If random returns 0.2, u = 0.8. If second call returns 0.25, v = 0.25
    let callCount = 0;
    const mockRandom = () => {
      callCount++;
      return callCount === 1 ? 0.2 : 0.25;
    };

    const val = gaussian(mockRandom);
    expect(val).toBeCloseTo(Math.sqrt(-2 * Math.log(0.8)) * Math.cos(2 * Math.PI * 0.25));
  });

  it('should handle edge cases like 0', () => {
    let callCount = 0;
    const mockRandom = () => {
      callCount++;
      return 0; // First call u = 1, second call v = 0
    };

    const val = gaussian(mockRandom);
    // Math.sqrt(-2 * Math.log(1)) * Math.cos(0) = 0 * 1 = 0
    expect(val).toBeCloseTo(0);
  });

  it('should handle large results when random is close to 1', () => {
    let callCount = 0;
    const mockRandom = () => {
      callCount++;
      return callCount === 1 ? 0.999999 : 0; // First call u = 0.000001, second call v = 0
    };

    const val = gaussian(mockRandom);
    expect(val).toBeCloseTo(Math.sqrt(-2 * Math.log(0.000001)) * Math.cos(0));
  });
});

describe("fract", () => {
  it("returns the fractional part of a positive number", () => {
    expect(fract(1.25)).toBeCloseTo(0.25);
    expect(fract(0.5)).toBeCloseTo(0.5);
    expect(fract(42.99)).toBeCloseTo(0.99);
  });

  it("returns the fractional part of a negative number", () => {
    // Math.floor(-1.25) is -2, so -1.25 - (-2) = 0.75
    expect(fract(-1.25)).toBeCloseTo(0.75);
    expect(fract(-0.5)).toBeCloseTo(0.5);
    expect(fract(-42.99)).toBeCloseTo(0.01);
  });

  it("returns 0 for whole numbers", () => {
    expect(fract(1)).toBe(0);
    expect(fract(0)).toBe(0);
    expect(fract(-5)).toBe(0);
  });

  it("handles edge cases correctly", () => {
    expect(fract(0.000000000000001)).toBeCloseTo(0.000000000000001);
  });
});

describe("lerp", () => {
  it("interpolates between two values correctly", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(5, 15, 0.2)).toBe(7);
  });
});

describe("clamp", () => {
  it("clamps a value within the specified range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(10, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
  });
});
