import { describe, it, expect } from 'vitest';
import { readConfig } from '../src/config.js';

describe('readConfig', () => {
  it('should run crypto', () => {
    const config = readConfig("", () => false);
    expect(config.seed).toBeGreaterThanOrEqual(0);
  });
});
