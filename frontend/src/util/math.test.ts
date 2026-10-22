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
  });
});
