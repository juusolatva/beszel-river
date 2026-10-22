import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Features } from "../src/pipeline/features.js";
import { loadMixConfig, Mixer, parseMixConfig, type MixConfig } from "../src/pipeline/mix.js";

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
  it("accepts mix.example.json", () => {
    expect(() => loadMixConfig(fileURLToPath(new URL("../mix.example.json", import.meta.url)))).not.toThrow();
  });

  it("rejects unknown features, missing channels and bad numbers", () => {
    const valid = { flow: { inputs: {} }, density: { inputs: {} }, turbulence: { inputs: {} }, pulse: { inputs: {} }, heat: { inputs: {} }, pulseDecay: 5 };
    expect(() => parseMixConfig({ ...valid, flow: { inputs: { hostname: 1 } } })).toThrow(/not a feature/);
    expect(() => parseMixConfig({ ...valid, heat: undefined })).toThrow(/"heat" is missing/);
    expect(() => parseMixConfig({ ...valid, flow: { inputs: {}, tau: "slow" } })).toThrow(/flow.tau/);
    expect(() => parseMixConfig({ ...valid, pulseDecay: 0 })).toThrow(/pulseDecay/);
  });
});

describe("Mixer", () => {
  it("takes the first sample as is, then smooths with tau", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, cpu: 1 }, 60);
    expect(m.values.flow).toBe(1);
    m.apply({ ...zero, cpu: 0 }, 60);
    expect(m.values.flow).toBeCloseTo(Math.exp(-1), 6);
  });

  it("clamps to 0..1 and centers inputs", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, mem: 0.9 }, 60);
    expect(m.values.density).toBe(1);
    expect(m.values.heat).toBe(0.5);
    m.apply({ ...zero, txShare: 0.8 }, 60);
    expect(m.values.heat).toBeCloseTo(0.8, 6);
  });

  it("raises pulse immediately and lets it decay", () => {
    const m = new Mixer(config);
    m.apply({ ...zero, burst: 0.8 }, 60);
    m.apply({ ...zero, burst: 0.2 }, 60);
    expect(m.values.pulse).toBe(0.8);
    expect(m.decay(10)).toBe(true);
    expect(m.values.pulse).toBeCloseTo(0.8 * Math.exp(-1), 6);
    for (let i = 0; i < 20; i++) m.decay(10);
    expect(m.values.pulse).toBe(0);
    expect(m.decay(10)).toBe(false);
  });
});
