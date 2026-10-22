import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Features } from "../src/pipeline/features.js";
import { DEFAULT_FILAMENTS, DEFAULT_GLIDE, DEFAULT_PULSE_SCATTER, loadMixConfig, Mixer, parseMixConfig, TICK_S, type MixConfig } from "../src/pipeline/mix.js";

const zero: Features = { cpu: 0, mem: 0, net: 0, netChange: 0, disk: 0, diskChange: 0, load: 0, burst: 0, txShare: 0.5, temp: 0.5 };

const config: MixConfig = parseMixConfig({
  flow: { inputs: { cpu: 1 }, tau: 60 },
  density: { inputs: { mem: 2 } },
  turbulence: { inputs: { net: 0.5, disk: 0.5 } },
  pulse: { inputs: { burst: 1 } },
  heat: { bias: 0.5, center: 0.5, inputs: { txShare: 1 } },
  pulseDecay: 10,
});

describe("parseMixConfig", () => {
  const valid = { flow: { inputs: {} }, density: { inputs: {} }, turbulence: { inputs: {} }, pulse: { inputs: {} }, heat: { inputs: {} }, pulseDecay: 5 };

  it("accepts mix.example.json", () => {
    expect(() => loadMixConfig(fileURLToPath(new URL("../mix.example.json", import.meta.url)))).not.toThrow();
  });

  it("rejects unknown features, missing channels and bad numbers", () => {
    expect(() => parseMixConfig({ ...valid, flow: { inputs: { hostname: 1 } } })).toThrow(/not a feature/);
    expect(() => parseMixConfig({ ...valid, heat: undefined })).toThrow(/"heat" is missing/);
    expect(() => parseMixConfig({ ...valid, flow: { inputs: {}, tau: "slow" } })).toThrow(/flow.tau/);
    expect(() => parseMixConfig({ ...valid, pulseDecay: 0 })).toThrow(/pulseDecay/);
    expect(() => parseMixConfig({ ...valid, filaments: 1 })).toThrow(/filaments must be an object/);
    expect(() => parseMixConfig({ ...valid, filaments: { weight: "x" } })).toThrow(/filaments.weight/);
    expect(() => parseMixConfig({ ...valid, filaments: { tau: -1 } })).toThrow(/filaments.tau/);
    expect(() => parseMixConfig({ ...valid, glide: -1 })).toThrow(/glide/);
  });

  it("rejects pulse scattering that cannot fit before the next record", () => {
    expect(() => parseMixConfig({ ...valid, pulseScatter: [] })).toThrow(/pulseScatter must be an object/);
    expect(() => parseMixConfig({ ...valid, pulseScatter: { jitter: -1 } })).toThrow(/pulseScatter.jitter/);
    expect(() => parseMixConfig({ ...valid, pulseScatter: { rate: -1 } })).toThrow(/pulseScatter.rate/);
    expect(() => parseMixConfig({ ...valid, pulseScatter: { max: 1.5 } })).toThrow(/pulseScatter.max/);
    // Two later pulses need 2 × (pulseDecay + tick) = 14 s.
    expect(() => parseMixConfig({ ...valid, pulseScatter: { window: 13 } })).toThrow(/pulseScatter.window must be >= .* = 14/);
    expect(() => parseMixConfig({ ...valid, pulseScatter: { max: 0, window: 0 } })).not.toThrow();
    expect(() => parseMixConfig({ ...valid, pulseScatter: { window: 51 } })).toThrow(/jitter \+ pulseScatter.window must be <= 55/);
    expect(() => parseMixConfig({ ...valid, pulseScatter: { jitter: 0, window: 55 } })).not.toThrow();
  });

  it("defaults the optional entries, also for single missing fields", () => {
    const parsed = parseMixConfig(valid);
    expect(parsed.filaments).toEqual(DEFAULT_FILAMENTS);
    expect(parsed.pulseScatter).toEqual(DEFAULT_PULSE_SCATTER);
    expect(parsed.glide).toBe(DEFAULT_GLIDE);
    expect(parseMixConfig({ ...valid, filaments: { weight: 2 } }).filaments).toEqual({ ...DEFAULT_FILAMENTS, weight: 2 });
    expect(parseMixConfig({ ...valid, pulseScatter: { max: 0 } }).pulseScatter).toEqual({ ...DEFAULT_PULSE_SCATTER, max: 0 });
  });
});

describe("Mixer", () => {
  it("takes the first sample as is, then smooths with tau", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, cpu: 1 }, null, 60, "realtime", 0);
    expect(m.values.flow).toBe(1);
    m.apply({ ...zero, cpu: 0 }, null, 60, "realtime", 0);
    expect(m.values.flow).toBeCloseTo(Math.exp(-1), 6);
  });

  it("clamps to 0..1 and centers inputs", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, mem: 0.9 }, null, 60, "realtime", 0);
    expect(m.values.density).toBe(1);
    expect(m.values.heat).toBe(0.5);
    m.apply({ ...zero, txShare: 0.8 }, null, 60, "realtime", 0);
    expect(m.values.heat).toBeCloseTo(0.8, 6);
  });

  it("raises a realtime pulse immediately and lets it decay", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, burst: 0.8 }, null, 60, "realtime", 0);
    m.apply({ ...zero, burst: 0.2 }, null, 60, "realtime", 0);
    expect(m.values.pulse).toBe(0.8);
    expect(m.tick(10, 0)).toBe(true);
    expect(m.values.pulse).toBeCloseTo(0.8 * Math.exp(-1), 6);
    for (let i = 0; i < 20; i++) m.tick(10, 0);
    expect(m.values.pulse).toBe(0);
    expect(m.tick(10, 0)).toBe(false);
  });

  it("leaves the pulse of a seed sample out", () => {
    const m = new Mixer(config, () => 0.5);
    m.apply({ ...zero, burst: 1, cpu: 1 }, null, 60, "seed", 0);
    expect(m.values.flow).toBe(1);
    expect(m.values.pulse).toBe(0);
    expect(m.tick(0, 100_000)).toBe(false);
  });
});

describe("Mixer filaments", () => {
  const recipe = (filaments: MixConfig["filaments"]): MixConfig => ({ ...config, filaments });

  it("applies the recipe to the first profile, then smooths with tau", () => {
    const m = new Mixer(recipe({ bias: 0.1, center: 0.5, weight: 2, tau: 5 }));
    expect(m.filaments).toBeNull();
    m.apply(zero, [0, 0.5, 0.6, 0.9, 1, 1], 1, "realtime", 0);
    expect(m.filaments?.map((f) => +f.toFixed(6))).toEqual([0, 0.1, 0.3, 0.9, 1, 1]);
    m.apply(zero, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 5, "realtime", 0);
    expect(m.filaments?.[0]).toBeCloseTo(0.1 * (1 - Math.exp(-1)), 6);
    expect(m.filaments?.[5]).toBeCloseTo(0.1 + 0.9 * Math.exp(-1), 6);
  });

  it("takes each profile as is with tau 0, and drops the filaments without one", () => {
    const m = new Mixer(recipe({ ...DEFAULT_FILAMENTS, tau: 0 }));
    m.apply(zero, [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], 1, "realtime", 0);
    m.apply(zero, [0.7, 0.7, 0.7, 0.7, 0.7, 0.7], 1, "realtime", 0);
    expect(m.filaments).toEqual([0.7, 0.7, 0.7, 0.7, 0.7, 0.7]);
    m.apply(zero, null, 1, "realtime", 0);
    expect(m.filaments).toBeNull();
  });
});

describe("Mixer glide", () => {
  const flat = { ...config, channels: { ...config.channels, flow: { ...config.channels.flow, tau: 0 } }, filaments: { ...DEFAULT_FILAMENTS, tau: 0 } };

  it("moves a minute record's channels and filaments to their new values over the glide", () => {
    const m = new Mixer(flat, () => 0.5);
    m.apply(zero, [0, 0, 0, 0, 0, 0], 60, "minute", 0);
    // The first sample has nothing to glide from.
    expect(m.values.flow).toBe(0);
    m.apply({ ...zero, cpu: 0.6 }, [0.6, 0.6, 0.6, 0.6, 0.6, 0.6], 60, "minute", 0);
    expect(m.values.flow).toBe(0);
    expect(m.filaments?.[0]).toBe(0);
    expect(m.tick(TICK_S, 2000)).toBe(true);
    expect(m.values.flow).toBeCloseTo(0.02, 6);
    expect(m.tick(TICK_S, 30_000)).toBe(true);
    expect(m.values.flow).toBeCloseTo(0.3, 6);
    expect(m.filaments?.[5]).toBeCloseTo(0.3, 6);
    m.tick(TICK_S, 60_000);
    expect(m.values.flow).toBeCloseTo(0.6, 6);
    expect(m.tick(TICK_S, 62_000)).toBe(false);
    expect(m.values.flow).toBeCloseTo(0.6, 6);
  });

  it("starts the next sample from where the glide is, and steps realtime samples at once", () => {
    const m = new Mixer(flat, () => 0.5);
    m.apply(zero, null, 60, "minute", 0);
    m.apply({ ...zero, cpu: 0.6 }, null, 60, "minute", 0);
    m.apply({ ...zero, cpu: 0 }, null, 60, "minute", 30_000);
    expect(m.values.flow).toBeCloseTo(0.3, 6);
    m.tick(TICK_S, 60_000);
    expect(m.values.flow).toBeCloseTo(0.15, 6);
    m.apply({ ...zero, cpu: 1 }, null, 1, "realtime", 60_000);
    expect(m.values.flow).toBe(1);
    expect(m.tick(TICK_S, 90_000)).toBe(false);
    expect(m.values.flow).toBe(1);
  });

  it("does not report moves too small to change a frame", () => {
    const m = new Mixer(flat, () => 0.5);
    m.apply(zero, null, 60, "minute", 0);
    m.apply({ ...zero, cpu: 0.01 }, null, 60, "minute", 0);
    expect(m.tick(TICK_S, 2000)).toBe(false);
    m.tick(TICK_S, 60_000);
    expect(m.values.flow).toBeCloseTo(0.01, 6);
  });

  it("switches filaments that start or stop at once, and applies everything at once with glide 0", () => {
    const m = new Mixer(flat, () => 0.5);
    m.apply(zero, null, 60, "minute", 0);
    m.apply(zero, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 60, "minute", 0);
    expect(m.filaments?.[0]).toBe(0.5);

    const steps = new Mixer({ ...flat, glide: 0 }, () => 0.5);
    steps.apply(zero, null, 60, "minute", 0);
    steps.apply({ ...zero, cpu: 0.6 }, null, 60, "minute", 0);
    expect(steps.values.flow).toBe(0.6);
  });
});

describe("Mixer pulse scattering", () => {
  /** Returns the given values in turn, as `Math.random` would. */
  const sequence = (...values: number[]) => () => values.shift() ?? 0;
  const noGlide = { ...config, glide: 0 };

  it("fires the first pulse within the jitter and weaker ones after it, spaced by pulseDecay + tick", () => {
    // First at 0.2 × 5 s; Poisson(2 × 0.5) draws 0.9, 0.9 → 2 (the cap); offsets 0.5 and 0.1 of the 26 s
    // the two 12 s gaps leave of the window, sorted; then the strengths.
    const m = new Mixer(noGlide, sequence(0.2, 0.9, 0.9, 0.5, 0.1, 0.75, 0));
    m.apply({ ...zero, burst: 0.5 }, null, 60, "minute", 0);
    expect(m.values.pulse).toBe(0);
    expect(m.tick(1, 999)).toBe(false);
    expect(m.tick(1, 1000)).toBe(true);
    expect(m.values.pulse).toBe(0.5);
    // At 1 + 2.6 + 12 s, 0.5 × (0.4 + 0.4 × 0.75).
    m.tick(14, 15_599);
    expect(m.values.pulse).toBeCloseTo(0.5 * Math.exp(-1.4), 6);
    expect(m.tick(0, 15_600)).toBe(true);
    expect(m.values.pulse).toBeCloseTo(0.35, 6);
    // At 1 + 13 + 24 s, 0.5 × 0.4.
    m.tick(22, 37_999);
    expect(m.values.pulse).toBeCloseTo(0.35 * Math.exp(-2.2), 6);
    m.tick(0, 38_000);
    expect(m.values.pulse).toBeCloseTo(0.2, 6);
    m.tick(1000, 1_000_000);
    expect(m.values.pulse).toBe(0);
  });

  it("shows the weakest later pulse as a rise even when ticks round the gap down", () => {
    // pulseDecay 9 s is no multiple of the 2 s tick. First due at 4.995 s, fired at 6 s; Poisson(2) draws
    // 0.5, 0.01 → 1; that one is due a gap of 11 s after the first, at 15.995 s, fired at 16 s, at the
    // weakest strength.
    const m = new Mixer({ ...noGlide, pulseDecay: 9 }, sequence(0.999, 0.5, 0.01, 0, 0));
    m.apply({ ...zero, burst: 1 }, null, 60, "minute", 0);
    const rises: number[] = [];
    for (let t = TICK_S * 1000; t <= 60_000; t += TICK_S * 1000) {
      const decayed = m.values.pulse * Math.exp(-TICK_S / 9);
      m.tick(TICK_S, t);
      if (m.values.pulse > decayed + 1e-9) rises.push(t, m.values.pulse);
    }
    expect(rises).toEqual([6000, 1, 16_000, 0.4]);
  });

  it("schedules nothing invisible, and no later pulses at rate 0", () => {
    const quiet = new Mixer(noGlide, sequence(0));
    quiet.apply({ ...zero, burst: 0.004 }, null, 60, "minute", 0);
    expect(quiet.tick(1, 10_000)).toBe(false);

    // 0.01 is visible, but 0.4 × 0.01 would not be.
    const faint = new Mixer(noGlide, () => 0.5);
    faint.apply({ ...zero, burst: 0.01 }, null, 60, "minute", 0);
    expect(faint.tick(0, 5000)).toBe(true);
    expect(faint.values.pulse).toBe(0.01);
    expect(faint.tick(10, 15_000)).toBe(true);
    for (let t = 17_000; t <= 60_000; t += 2000) expect(faint.tick(2, t)).toBe(false);

    const once = new Mixer({ ...noGlide, pulseScatter: { ...DEFAULT_PULSE_SCATTER, rate: 0 } }, () => 0.5);
    once.apply({ ...zero, burst: 1 }, null, 60, "minute", 0);
    once.tick(0, 5000);
    expect(once.values.pulse).toBe(1);
    once.tick(1000, 100_000);
    expect(once.values.pulse).toBe(0);
  });

  it("raises the pulse at once with jitter 0, and only once with max 0", () => {
    const m = new Mixer({ ...noGlide, pulseScatter: { ...DEFAULT_PULSE_SCATTER, jitter: 0, max: 0 } }, () => 0.5);
    m.apply({ ...zero, burst: 0.7 }, null, 60, "minute", 0);
    expect(m.values.pulse).toBe(0.7);
    m.tick(1000, 1000);
    for (let t = 2000; t <= 60_000; t += 2000) expect(m.tick(2, t)).toBe(false);
  });

  it("raises a pending first pulse when the next sample comes first, and drops the later ones", () => {
    for (const kind of ["minute", "realtime", "seed"] as const) {
      const m = new Mixer(noGlide, () => 0.5);
      m.apply({ ...zero, burst: 1 }, null, 60, "minute", 0);
      m.apply(zero, null, 1, kind, 1000);
      expect(m.values.pulse).toBe(1);
      m.tick(1000, 1_000_000);
      expect(m.tick(0, 1_000_000)).toBe(false);
      expect(m.values.pulse).toBe(0);
    }
  });

  it("drops every pending pulse on request", () => {
    const m = new Mixer(noGlide, () => 0.5);
    m.apply({ ...zero, burst: 1 }, null, 60, "minute", 0);
    m.dropPulses();
    for (let t = 2000; t <= 60_000; t += 2000) expect(m.tick(2, t)).toBe(false);
    expect(m.values.pulse).toBe(0);
  });
});
