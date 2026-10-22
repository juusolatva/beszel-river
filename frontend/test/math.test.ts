import { describe, it, expect } from 'vitest';
import { clamp } from '../src/util/math';

describe('clamp', () => {
  it('returns the value when it is within the min and max range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, -10, 0)).toBe(-5);
    expect(clamp(0, -1, 1)).toBe(0);
  });

  it('returns the min when the value is below the min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 10, 20)).toBe(10);
    expect(clamp(-20, -10, 0)).toBe(-10);
  });

  it('returns the max when the value is above the max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(25, 10, 20)).toBe(20);
    expect(clamp(5, -10, 0)).toBe(0);
  });

  it('returns the min/max when the value equals the min or max', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('handles cases where min equals max', () => {
    expect(clamp(5, 10, 10)).toBe(10);
    expect(clamp(15, 10, 10)).toBe(10);
    expect(clamp(10, 10, 10)).toBe(10);
  });
});
