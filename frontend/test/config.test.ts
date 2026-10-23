import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config";

describe("readConfig", () => {
  it("should return default config when no params and no media matches", () => {
    const search = "";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(20000);
    expect(config.particlesFixed).toBe(false);
    expect(config.motion).toBe(1);
    expect(config.demo).toBe(false);
    expect(config.demoStreams).toBe(4);
    expect(config.demoIntervalMs).toBe(1000);
    expect(typeof config.seed).toBe("number");
    expect(config.debug).toBe(false);

    expect(matches).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(matches).toHaveBeenCalledWith("(pointer: coarse)");
  });

  it("should reduce budget and motion when reduced-motion is preferred", () => {
    const search = "";
    const matches = vi.fn((query: string) => query === "(prefers-reduced-motion: reduce)");

    const config = readConfig(search, matches);

    expect(config.particles).toBe(10000); // 20000 / 2
    expect(config.motion).toBe(0.5);
  });

  it("should reduce budget when coarse pointer is detected", () => {
    const search = "";
    const matches = vi.fn((query: string) => query === "(pointer: coarse)");

    const config = readConfig(search, matches);

    expect(config.particles).toBe(8000);
  });

  it("should apply both media queries correctly", () => {
    const search = "";
    const matches = vi.fn().mockReturnValue(true);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(4000); // 8000 / 2
    expect(config.motion).toBe(0.5);
  });

  it("should parse boolean flags from URL parameters", () => {
    const search = "?demo&debug";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.demo).toBe(true);
    expect(config.debug).toBe(true);
  });

  it("should parse and clamp integer URL parameters", () => {
    const search = "?particles=50000&streams=10&interval=5000&seed=123";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(50000);
    expect(config.particlesFixed).toBe(true);
    expect(config.demoStreams).toBe(10);
    expect(config.demoIntervalMs).toBe(5000);
    expect(config.seed).toBe(123);
  });

  it("should clamp values below minimum", () => {
    const search = "?particles=10&streams=-5&interval=50&seed=-100";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(100); // min 100
    expect(config.demoStreams).toBe(0); // min 0
    expect(config.demoIntervalMs).toBe(100); // min 100
    expect(config.seed).toBe(0); // min 0
  });

  it("should clamp values above maximum", () => {
    const search = "?particles=1000000&streams=100&interval=9999999&seed=9999999999";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(200000); // max 200000
    expect(config.demoStreams).toBe(32); // max 32
    expect(config.demoIntervalMs).toBe(600000); // max 600000
    expect(config.seed).toBe(2 ** 31); // max 2^31
  });

  it("should ignore invalid/NaN parameter values and use defaults", () => {
    const search = "?particles=abc&streams=def&interval=ghi&seed=jkl";
    const matches = vi.fn().mockReturnValue(false);

    const config = readConfig(search, matches);

    expect(config.particles).toBe(20000); // default
    expect(config.demoStreams).toBe(4); // default
    expect(config.demoIntervalMs).toBe(1000); // default
    // seed has a random default, we check it's within bounds
    expect(config.seed).toBeGreaterThanOrEqual(0);
    expect(config.seed).toBeLessThanOrEqual(2 ** 31);
  });
});
