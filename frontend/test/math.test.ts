import { describe, it, expect } from 'vitest';
import { clamp, mulberry32, ease, lerp, fract, gaussian, hashString } from '../src/util/math.js';

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

describe('ease', () => {
  it('should return current when dt is 0', () => {
    expect(ease(0, 10, 1, 0)).toBe(0);
    expect(ease(5, 10, 1, 0)).toBe(5);
  });

  it('should return current when target is equal to current', () => {
    expect(ease(5, 5, 1, 0.5)).toBe(5);
    expect(ease(10, 10, 2, 1)).toBe(10);
  });

  it('should move towards target when dt > 0', () => {
    const result = ease(0, 10, 1, 0.5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(10);
  });

  it('should approach target closely for large dt', () => {
    const result = ease(0, 10, 1, 100);
    expect(result).toBeCloseTo(10, 4);
  });

  it('should move approximately 63.2% (1 - 1/e) to target when dt === tau', () => {
    const expectedProgress = 1 - Math.exp(-1);
    const result = ease(0, 100, 1, 1);
    expect(result).toBeCloseTo(100 * expectedProgress, 5);
  });

  it('should handle decreasing values (current > target)', () => {
    const result = ease(10, 0, 1, 1);
    const expectedProgress = 1 - Math.exp(-1);
    // starts at 10, target is 0, so it decreases by 10 * expectedProgress
    expect(result).toBeCloseTo(10 - 10 * expectedProgress, 5);
  });
});

describe('lerp', () => {
  it('should return a when t is 0', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(5, 10, 0)).toBe(5);
  });

  it('should return b when t is 1', () => {
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(5, -10, 1)).toBe(-10);
  });

  it('should return the midpoint when t is 0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(-10, 10, 0.5)).toBe(0);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it('should interpolate correctly for arbitrary t between 0 and 1', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(0, 100, 0.75)).toBe(75);
    expect(lerp(10, 20, 0.1)).toBe(11);
  });

  it('should extrapolate correctly for t outside [0, 1]', () => {
    expect(lerp(0, 10, -0.5)).toBe(-5);
    expect(lerp(0, 10, 1.5)).toBe(15);
    expect(lerp(10, 20, 2)).toBe(30);
    expect(lerp(10, 20, -1)).toBe(0);
  });

  it('should handle negative bounds', () => {
    expect(lerp(-10, -20, 0)).toBe(-10);
    expect(lerp(-10, -20, 1)).toBe(-20);
    expect(lerp(-10, -20, 0.5)).toBe(-15);
  });

  it('should handle floating point numbers properly', () => {
    expect(lerp(1.5, 2.5, 0.5)).toBeCloseTo(2.0);
    expect(lerp(0.1, 0.2, 0.5)).toBeCloseTo(0.15);
  });
});

describe('fract', () => {
  it('should return the fractional part of a positive number', () => {
    expect(fract(1.5)).toBe(0.5);
    expect(fract(2.25)).toBe(0.25);
    expect(fract(0.1)).toBeCloseTo(0.1);
  });

  it('should return the fractional part of a negative number', () => {
    expect(fract(-1.5)).toBe(0.5);
    expect(fract(-2.25)).toBe(0.75); // -2.25 - floor(-2.25) = -2.25 - (-3) = 0.75
    expect(fract(-0.1)).toBeCloseTo(0.9);
  });

  it('should return 0 for whole numbers', () => {
    expect(fract(0)).toBe(0);
    expect(fract(5)).toBe(0);
    expect(fract(-5)).toBe(0);
  });
});

describe('gaussian', () => {
  it('should return correct value for known inputs', () => {
    // When random() returns 1 - Math.exp(-0.5) (so u = Math.exp(-0.5))
    // and then 0 (so v = 0), the result should be:
    // Math.sqrt(-2 * Math.log(Math.exp(-0.5))) * Math.cos(0)
    // = Math.sqrt(-2 * -0.5) * 1 = Math.sqrt(1) = 1
    let calls = 0;
    const mockRandom = () => {
      calls++;
      if (calls === 1) return 1 - Math.exp(-0.5);
      return 0;
    };
    expect(gaussian(mockRandom)).toBeCloseTo(1);
  });

  it('should return correct value for another set of inputs', () => {
    // When random() returns 1 - Math.exp(-2) (so u = Math.exp(-2))
    // and then 0.25 (so v = 0.25), the result should be:
    // Math.sqrt(-2 * -2) * Math.cos(PI/2)
    // = 2 * 0 = 0
    let calls = 0;
    const mockRandom = () => {
      calls++;
      if (calls === 1) return 1 - Math.exp(-2);
      return 0.25;
    };
    expect(gaussian(mockRandom)).toBeCloseTo(0);
  });

  it('should handle edge case when random returns 0', () => {
    // u = 1 - 0 = 1, v = 0
    // Math.sqrt(-2 * Math.log(1)) * Math.cos(0)
    // = Math.sqrt(0) * 1 = 0
    let calls = 0;
    const mockRandom = () => {
      calls++;
      return 0;
    };
    expect(gaussian(mockRandom)).toBeCloseTo(0);
  });

  it('should handle values near 1', () => {
    // u = 1 - 0.999 = 0.001
    // v = 0.999
    // Math.sqrt(-2 * Math.log(0.001)) * Math.cos(2 * Math.PI * 0.999)
    let calls = 0;
    const mockRandom = () => {
      calls++;
      return 0.999;
    };
    const expected = Math.sqrt(-2 * Math.log(1 - 0.999)) * Math.cos(2 * Math.PI * 0.999);
    expect(gaussian(mockRandom)).toBeCloseTo(expected);
  });
});

describe('hashString', () => {
  it('should return a number between 0 (inclusive) and 1 (exclusive)', () => {
    const hash = hashString('test');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(1);
  });

  it('should be deterministic (same input produces same output)', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
    expect(hashString('')).toBe(hashString(''));
  });

  it('should produce different outputs for different strings', () => {
    const hash1 = hashString('foo');
    const hash2 = hashString('bar');
    expect(hash1).not.toBe(hash2);
  });

  it('should handle empty string correctly', () => {
    const hash = hashString('');
    // The FNV-1a offset basis is 0x811c9dc5, which is 2166136261.
    // 2166136261 / 4294967296 ≈ 0.5043429
    expect(hash).toBeCloseTo(0.5043429, 6);
  });

  it('should handle long strings and special characters', () => {
    const hash = hashString('abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThan(1);

    const hashUnicode = hashString('こんにちは世界'); // Hello World in Japanese
    expect(hashUnicode).toBeGreaterThanOrEqual(0);
    expect(hashUnicode).toBeLessThan(1);
  });
});
