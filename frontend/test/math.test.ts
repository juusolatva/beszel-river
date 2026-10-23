import { describe, it, expect } from 'vitest';
import { clamp } from '../src/util/math.js';

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
