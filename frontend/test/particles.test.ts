import type { Stream } from "@beszel-river/shared";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { FlowField } from "../src/sim/noise";
import { INSTANCE_FLOATS, ParticleSystem } from "../src/sim/particles";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";

const ASPECT = 1.6;
const DT = 1 / 60;

function stream(id: string, overrides: Partial<Stream> = {}): Stream {
  return { id, alive: true, width: 0.5, flow: 0.5, density: 0.5, turbulence: 0.5, pulse: 0, heat: 0.5, ...overrides };
}

function setup(capacity: number, ...streams: Stream[]) {
  const random = mulberry32(1);
  const set = new StreamSet(1);
  set.apply({ v: 1, t: 0, streams });
  const field = new FlowField(random);
  const particles = new ParticleSystem(capacity, random);
  let t = 0;
  /** Runs the frame loop as `main.ts` does; returns the last instance count. */
  const run = (seconds: number): number => {
    let n = 0;
    for (let end = t + seconds; t < end; t += DT) {
      set.update(DT, ASPECT);
      field.update(t, ASPECT);
      particles.spawn(DT, set);
      n = particles.step(DT, set, field, ASPECT, 2);
    }
    return n;
  };
  return { set, particles, run };
}

describe("ParticleSystem", () => {
  it("starts empty and spawns nothing without streams", () => {
    const { particles, run } = setup(100);
    expect(particles.count).toBe(0);
    expect(run(1)).toBe(0);
    expect(particles.count).toBe(0);
  });

  it("fills up to the limit, never beyond it, and writes every live particle", () => {
    const { particles, run } = setup(2000, stream("a"), stream("b", { density: 1 }));
    particles.limit = 1500;
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      const n = run(1);
      expect(n).toBe(particles.count);
      peak = Math.max(peak, n);
    }
    expect(peak).toBeLessThanOrEqual(1500);
    expect(peak).toBeGreaterThan(1000);
  });

  it("keeps per-stream particle counts in step with the pool", () => {
    const { set, particles, run } = setup(1000, stream("a"), stream("b"), stream("c", { alive: false }));
    run(LOOK.turnoverSeconds * 2);
    const used = set.slots.filter((s) => s.used);
    expect(used.reduce((sum, s) => sum + s.particles, 0)).toBe(particles.count);
    for (const s of used) expect(s.particles).toBeGreaterThan(0);
  });

  it("writes finite instances on screen, moving upwards within the stream's band", () => {
    const { set, particles, run } = setup(1000, stream("a", { filaments: [0.1, 0.2, 0.9, 0.3, 0.1, 0] }));
    const n = run(5);
    expect(n).toBeGreaterThan(0);
    const a = set.slots[0];
    for (let i = 0; i < n; i++) {
      const o = i * INSTANCE_FLOATS;
      const values = Array.from(particles.instances.subarray(o, o + INSTANCE_FLOATS));
      expect(values.every(Number.isFinite)).toBe(true);
      const [tailX, tailY, x, y, hue, chroma, lightness, intensity, size] = values;
      expect(y).toBeGreaterThanOrEqual(tailY);
      // The clamp holds sideways speed to maxSlope of the stream's upward speed; vertical speed can dip
      // a little below that with the field, so the heading can lean slightly further.
      expect(Math.abs(x - tailX)).toBeLessThanOrEqual(1.5 * LOOK.maxSlope * (y - tailY) + 1e-6);
      expect(x).toBeGreaterThan(-0.1);
      expect(x).toBeLessThan(ASPECT + 0.1);
      expect(Math.abs(x - a.center)).toBeLessThan(4 * a.half);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(1);
      // Float32 instance data.
      expect(chroma).toBeCloseTo(a.chroma, 6);
      expect(lightness).toBeCloseTo(LOOK.lightness, 6);
      expect(intensity).toBeGreaterThanOrEqual(0);
      expect(size).toBeGreaterThan(0);
    }
  });

  it("frees a removed stream's particles as they die, so its slot is released", () => {
    const { set, particles, run } = setup(500, stream("a"), stream("b"));
    run(LOOK.turnoverSeconds * 3);
    const [a, b] = set.slots;
    expect(a.particles).toBeGreaterThan(0);

    set.apply({ v: 1, t: 0, streams: [stream("b")] });
    run(LOOK.lifeRange[1] + 30);
    expect(a.used).toBe(false);
    expect(b.particles).toBe(particles.count);
  });

  it("scales intensity with intensityScale", () => {
    const one = setup(200, stream("a"));
    const two = setup(200, stream("a"));
    two.particles.intensityScale = 2;
    const n = one.run(3);
    expect(two.run(3)).toBe(n);
    const intensity = (p: ParticleSystem): number => p.instances[7];
    expect(intensity(two.particles)).toBeCloseTo(2 * intensity(one.particles));
  });
});
