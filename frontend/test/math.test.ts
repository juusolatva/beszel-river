import { describe, it, expect } from 'vitest';
import { clamp, mulberry32 } from '../src/util/math.js';

describe('clamp', () => {
  it('should return the value if it is within the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, -10, 0)).toBe(-5);
    expect(clamp(0, -10, 10)).toBe(0);
  });

  it('should return the minimum if the value is below the minimum', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(-15, -10, 0)).toBe(-10);
  });

  it('should return the maximum if the value is above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(5, -10, 0)).toBe(0);
  });

  it('should return the boundary value if the value is on the boundary', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('mulberry32', () => {
  it('should return a function that produces numbers between 0 (inclusive) and 1 (exclusive)', () => {
    const random = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const val = random();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('should produce the same sequence of numbers for the same seed', () => {
    const seed = 987654321;
    const random1 = mulberry32(seed);
    const random2 = mulberry32(seed);

    for (let i = 0; i < 100; i++) {
      expect(random1()).toBe(random2());
    }
  });

  it('should produce different sequences of numbers for different seeds', () => {
    const random1 = mulberry32(1);
    const random2 = mulberry32(2);

    let allMatch = true;
    for (let i = 0; i < 10; i++) {
      if (random1() !== random2()) {
        allMatch = false;
        break;
      }
    }
    expect(allMatch).toBe(false);
  });

  it('should handle negative and large seeds correctly due to >>> 0 cast', () => {
    // -1 >>> 0 is 4294967295
    const random1 = mulberry32(-1);
    const random2 = mulberry32(4294967295);

    for (let i = 0; i < 10; i++) {
      expect(random1()).toBe(random2());
    }
  });
});
