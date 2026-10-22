import { describe, it, expect } from "vitest";
import { mulberry32, gaussian, hashString, ease, lerp, clamp, fract } from "../src/util/math.js";

describe("mulberry32", () => {
  it("returns values between 0 (inclusive) and 1 (exclusive)", () => {
    const random = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const val = random();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it("is deterministic (same seed produces same sequence)", () => {
    const random1 = mulberry32(42);
    const random2 = mulberry32(42);

    for (let i = 0; i < 100; i++) {
      expect(random1()).toBe(random2());
    }
  });

  it("produces different sequences for different seeds", () => {
    const random1 = mulberry32(1);
    const random2 = mulberry32(2);

    // Check first few values are different
    let allSame = true;
    for (let i = 0; i < 10; i++) {
      if (random1() !== random2()) {
        allSame = false;
        break;
      }
    }
    expect(allSame).toBe(false);
  });

  it("advances internal state on each call", () => {
    const random = mulberry32(100);
    const val1 = random();
    const val2 = random();
    const val3 = random();

    // Very unlikely for 3 consecutive random numbers to be exactly equal
    expect(val1).not.toBe(val2);
    expect(val2).not.toBe(val3);
  });
});

describe("gaussian", () => {
  it("returns standard normal samples", () => {
    const random = mulberry32(12345);
    const samples = [];
    for (let i = 0; i < 1000; i++) {
      samples.push(gaussian(random));
    }
    // Very basic check that we get positive and negative numbers
    const hasPositive = samples.some(s => s > 0);
    const hasNegative = samples.some(s => s < 0);
    expect(hasPositive).toBe(true);
    expect(hasNegative).toBe(true);
  });
});

describe("hashString", () => {
  it("returns deterministic hashes in [0, 1)", () => {
    const h1 = hashString("hello");
    const h2 = hashString("hello");
    const h3 = hashString("world");

    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThan(1);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("ease", () => {
  it("moves current towards target over time", () => {
    // current=0, target=10, tau=1, dt=1
    // expected = 0 + (10 - 0) * (1 - e^-1) = 10 * (1 - 0.3678) = 6.32
    const result1 = ease(0, 10, 1, 1);
    expect(result1).toBeGreaterThan(0);
    expect(result1).toBeLessThan(10);

    // As dt increases, it approaches target
    const result2 = ease(0, 10, 1, 10); // 10 time constants
    expect(result2).toBeCloseTo(10, 3);
  });
});

describe("lerp", () => {
  it("interpolates between two values linearly", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe("clamp", () => {
  it("constrains a value within bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("fract", () => {
  it("returns the fractional part of a number", () => {
    expect(fract(1.25)).toBeCloseTo(0.25);
    expect(fract(-1.25)).toBeCloseTo(0.75); // -1.25 - floor(-1.25) = -1.25 - (-2) = 0.75
    expect(fract(5)).toBeCloseTo(0);
  });
});
