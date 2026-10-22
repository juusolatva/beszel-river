import { describe, it, expect } from 'vitest';
import { ease, mulberry32, gaussian, hashString, lerp, clamp, fract } from './math';

describe('math utilities', () => {
  describe('mulberry32', () => {
    it('returns a random-looking sequence between 0 and 1', () => {
      const rand = mulberry32(12345);
      const v1 = rand();
      const v2 = rand();

      expect(v1).toBeGreaterThanOrEqual(0);
      expect(v1).toBeLessThan(1);

      expect(v2).toBeGreaterThanOrEqual(0);
      expect(v2).toBeLessThan(1);

      expect(v1).not.toBe(v2);
    });

    it('is deterministic based on seed', () => {
      const rand1 = mulberry32(42);
      const rand2 = mulberry32(42);
      expect(rand1()).toBe(rand2());
      expect(rand1()).toBe(rand2());
    });
  });

  describe('gaussian', () => {
    it('returns a number', () => {
      const rand = mulberry32(123);
      expect(typeof gaussian(rand)).toBe('number');
    });
  });

  describe('hashString', () => {
    it('returns deterministic value between 0 and 1 for string', () => {
      const v1 = hashString('hello');
      const v2 = hashString('hello');
      const v3 = hashString('world');

      expect(v1).toBe(v2);
      expect(v1).not.toBe(v3);

      expect(v1).toBeGreaterThanOrEqual(0);
      expect(v1).toBeLessThan(1);
    });
  });

  describe('ease', () => {
    it('returns current when dt is 0', () => {
      expect(ease(0, 10, 1, 0)).toBe(0);
      expect(ease(5, 10, 1, 0)).toBe(5);
    });

    it('moves halfway when dt equals tau * ln(2)', () => {
      const tau = 1;
      const dt = tau * Math.LN2;
      expect(ease(0, 10, tau, dt)).toBeCloseTo(5);
    });

    it('approaches target when dt is large relative to tau', () => {
      expect(ease(0, 10, 1, 100)).toBeCloseTo(10);
    });

    it('handles negative dt (extrapolation)', () => {
      expect(ease(0, 10, 1, -Math.LN2)).toBeCloseTo(-10);
    });

    it('handles negative current and target', () => {
      expect(ease(-10, -20, 1, Math.LN2)).toBeCloseTo(-15);
    });
  });

  describe('lerp', () => {
    it('interpolates between two values', () => {
      expect(lerp(0, 10, 0)).toBe(0);
      expect(lerp(0, 10, 0.5)).toBe(5);
      expect(lerp(0, 10, 1)).toBe(10);
      expect(lerp(10, 20, 0.25)).toBe(12.5);
    });
  });

  describe('clamp', () => {
    it('restricts value to given range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
      expect(clamp(10, 10, 10)).toBe(10);
    });
  });

  describe('fract', () => {
    it('returns fractional part of a positive number', () => {
      expect(fract(1.25)).toBe(0.25);
      expect(fract(0.5)).toBe(0.5);
      expect(fract(10)).toBe(0);
    });

    it('returns fractional part of a negative number', () => {
      // -1.25 - floor(-1.25) = -1.25 - (-2) = 0.75
      expect(fract(-1.25)).toBe(0.75);
    });
import { hashString, mulberry32, gaussian, ease, lerp, clamp, fract } from './math';

describe('hashString', () => {
  it('should return a number between 0 (inclusive) and 1 (exclusive)', () => {
    const result = hashString('test string');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(1);
  });

  it('should return consistent results for the same input', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('should return different results for different inputs', () => {
    expect(hashString('hello')).not.toBe(hashString('world'));
  });

  it('should handle empty strings', () => {
    const result = hashString('');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(1);
    expect(result).toBe((0x811c9dc5 >>> 0) / 4294967296);
  });

  it('should calculate the correct FNV-1a hash mapped to [0, 1)', () => {
    const resultA = hashString('a');
    let h = 0x811c9dc5;
    h ^= 97;
    h = Math.imul(h, 0x01000193);
    const expected = (h >>> 0) / 4294967296;
    expect(resultA).toBe(expected);
  });
});

describe('mulberry32', () => {
  it('should return a function that generates numbers between 0 and 1', () => {
    const random = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const val = random();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('should be deterministic based on the seed', () => {
    const rand1 = mulberry32(42);
    const rand2 = mulberry32(42);

    for (let i = 0; i < 10; i++) {
      expect(rand1()).toBe(rand2());
    }
  });
});

describe('gaussian', () => {
  it('should generate numbers using Box-Muller transform', () => {
    // We can mock the random function to control u and v
    // Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)

    // u = 1 - 0.5 = 0.5
    // v = 0
    // sqrt(-2 * ln(0.5)) * cos(0) ≈ 1.177 * 1 = 1.177
    let callCount = 0;
    const mockRandom = () => {
      callCount++;
      return callCount === 1 ? 0.5 : 0; // First call is u (1-random()), second is v
    };

    const val = gaussian(mockRandom);
    expect(val).toBeCloseTo(Math.sqrt(-2 * Math.log(0.5)) * Math.cos(0));
  });
});

describe('ease', () => {
  it('should move current towards target', () => {
    const result = ease(0, 100, 1, 0.5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(100);
    expect(result).toBeCloseTo(100 * (1 - Math.exp(-0.5/1)));
  });

  it('should reach target if dt is very large', () => {
    const result = ease(0, 100, 1, 1000);
    expect(result).toBeCloseTo(100);
  });

  it('should not move if current equals target', () => {
    const result = ease(50, 50, 1, 0.5);
    expect(result).toBe(50);
  });
});

describe('lerp', () => {
  it('should correctly interpolate between two values', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 20, 0.2)).toBe(12);
  });
});

describe('clamp', () => {
  it('should keep value within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('fract', () => {
  it('should return the fractional part of a number', () => {
    expect(fract(1.25)).toBeCloseTo(0.25);
    expect(fract(3.99)).toBeCloseTo(0.99);
    expect(fract(5)).toBeCloseTo(0);
    expect(fract(-1.25)).toBeCloseTo(0.75); // -1.25 - floor(-1.25) = -1.25 - (-2) = 0.75
  });
});
