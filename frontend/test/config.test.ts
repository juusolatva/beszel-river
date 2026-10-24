import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";

const noMedia = () => false;

describe("readConfig", () => {
  it("applies defaults", () => {
    const config = readConfig("", noMedia);
    expect(config).toMatchObject({
      particles: 20000,
      particlesFixed: false,
      motion: 1,
      demo: false,
      demoStreams: 4,
      demoIntervalMs: 1000,
      debug: false,
    });
    expect(config.seed).toBeGreaterThanOrEqual(0);
    expect(config.seed).toBeLessThanOrEqual(2 ** 31);
  });

  it("scales budget and motion for coarse pointers and reduced motion", () => {
    expect(readConfig("", (q) => q === "(pointer: coarse)")).toMatchObject({ particles: 8000, motion: 1 });
    expect(readConfig("", (q) => q === "(prefers-reduced-motion: reduce)")).toMatchObject({ particles: 10000, motion: 0.5 });
    expect(readConfig("", () => true)).toMatchObject({ particles: 4000, motion: 0.5 });
  });

  it("parses flags, clamps integer parameters, and ignores non-numbers", () => {
    expect(readConfig("?demo&debug&particles=50000&streams=10&interval=5000&seed=123", noMedia)).toEqual({
      particles: 50000,
      particlesFixed: true,
      motion: 1,
      demo: true,
      demoStreams: 10,
      demoIntervalMs: 5000,
      seed: 123,
      debug: true,
    });
    expect(readConfig("?particles=10&streams=-5&interval=50&seed=-100", noMedia)).toMatchObject({
      particles: 100,
      demoStreams: 0,
      demoIntervalMs: 100,
      seed: 0,
    });
    expect(readConfig("?particles=1000000&streams=100&interval=9999999&seed=9999999999", noMedia)).toMatchObject({
      particles: 200000,
      demoStreams: 32,
      demoIntervalMs: 600000,
      seed: 2 ** 31,
    });
    expect(readConfig("?particles=abc&streams=def&interval=ghi&seed=jkl", noMedia)).toMatchObject({
      particles: 20000,
      particlesFixed: true,
      demoStreams: 4,
      demoIntervalMs: 1000,
    });
  });
});
