import type { Stream } from "@beszel-river/shared";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { FlowField } from "../src/sim/noise";
import { INSTANCE_FLOATS, METADATA_FLOATS, ParticleSystem } from "../src/sim/particles";
import { DRAIN_PRESENCE, StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { calledStep } from "./cpu-benchmark.browser";

const ASPECT = 1.6;
const DT = 1 / 60;
const PIXEL_RATIO = 2;

/** The pool's private liveness flags, which the renderer never needs. */
const liveFlags = (particles: ParticleSystem): Uint8Array => (particles as unknown as { active: Uint8Array }).active;

/**
 * The live particles as the renderer draws them, in slot order, rebuilt into the former nine-float
 * records (tail.xy, head.xy, hue, chroma, lightness, intensity, half-width in device px), so the
 * hashes recorded with the compacted layout still check every value the shader receives.
 */
function drawn(particles: ParticleSystem, streams: StreamSet, pixelRatio = PIXEL_RATIO): Float32Array {
  const live = liveFlags(particles);
  const out = new Float32Array(particles.count * 9);
  let n = 0;
  for (let i = 0; i < particles.drawCount; i++) {
    if (!live[i]) continue;
    const d = i * INSTANCE_FLOATS, m = i * METADATA_FLOATS, o = n++ * 9;
    out.set(particles.instances.subarray(d, d + 4), o);
    out[o + 4] = particles.instances[d + 4];
    out[o + 5] = streams.chroma[particles.metadata[m]];
    out[o + 6] = LOOK.lightness;
    out[o + 7] = particles.instances[d + 5];
    out[o + 8] = particles.metadata[m + 1] * LOOK.sizePx * pixelRatio;
  }
  expect(n).toBe(particles.count);
  return out;
}

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
      particles.spawn(DT, set);
      // The field depends only on time/aspect; no particle can sample it while the pool is empty.
      if (particles.count > 0) field.update(t, ASPECT);
      n = particles.step(DT, set, field, ASPECT);
    }
    return n;
  };
  return { set, particles, run, drawn: () => drawn(particles, set) };
}

describe("ParticleSystem", () => {
  it.each([undefined, [0.1, 0.2, 0.9, 0.3, 0.1, 0]])("keeps cached-centre trajectories close to the analytic reference (%s)", (filaments) => {
    const actual = setup(1000, stream("a", { filaments }));
    const reference = setup(1000, stream("a", { filaments }));
    // The production step reads the centre table inline; the reference steers every particle through
    // `centerAt`, overridden with the sine, so the comparison covers accumulated motion, not only spawns.
    let analyticCalls = 0;
    for (const slot of reference.set.slots) {
      slot.centerAt = (y) => {
        analyticCalls++;
        return slot.center + slot.half * LOOK.braid * Math.sin(2 * Math.PI * (y * LOOK.braidWaves + slot.phase) + slot.braidAngle);
      };
    }
    reference.particles.step = calledStep;
    const count = actual.run(2);
    expect(reference.run(2)).toBe(count);
    // Two seconds of steps, each steering every live particle: far more calls than spawns alone make.
    expect(analyticCalls).toBeGreaterThan(30 * count);
    // The centre approximation is bounded by 0.001*half; allow 0.001 world units for accumulated motion.
    const a = actual.drawn(), b = reference.drawn();
    for (let i = 0; i < count * 9; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.001);
  });

  // Recorded with the step that called `FlowField.sample` per particle (before inlined sampling) and
  // wrote nine compacted floats per live particle. The inlined interpolation keeps its arithmetic, and
  // `drawn` rebuilds those records from stable slots, so every drawn value must stay bit-identical,
  // through grid resizes from aspect changes.
  it.each([
    [undefined, 666, "938973b2"],
    [[0.1, 0.2, 0.9, 0.3, 0.1, 0], 629, "7b0724a4"],
  ])("reproduces the recorded trajectories exactly across aspect changes (%s)", (filaments, count, hash) => {
    const random = mulberry32(7);
    const set = new StreamSet(1);
    set.apply({ v: 1, t: 0, streams: [0.3, 0.6, 1].map((width, i) => stream("abc"[i], { width, flow: 0.6, density: 0.8, turbulence: 0.9, filaments })) });
    const field = new FlowField(random);
    const particles = new ParticleSystem(3000, random);
    let n = 0, t = 0;
    for (let frame = 0; frame < 480; frame++, t += DT) {
      const aspect = frame < 160 ? 1.6 : frame < 320 ? 2.4 : 0.6;
      set.update(DT, aspect);
      particles.spawn(DT, set);
      field.update(t, aspect);
      n = particles.step(DT, set, field, aspect);
    }
    let h = 0x811c9dc5;
    for (const word of new Uint32Array(drawn(particles, set).buffer)) h = Math.imul(h ^ word, 0x01000193) >>> 0;
    expect([n, h.toString(16)]).toEqual([count, hash]);
  });

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
    const { set, run, drawn } = setup(1000, stream("a", { filaments: [0.1, 0.2, 0.9, 0.3, 0.1, 0] }));
    const n = run(5);
    expect(n).toBeGreaterThan(0);
    const a = set.slots[0];
    const records = drawn();
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const values = Array.from(records.subarray(o, o + 9));
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

  it("drains the river when every stream leaves, and fades a later stream in", () => {
    const { set, particles, run } = setup(500, stream("a"), stream("b"));
    run(LOOK.turnoverSeconds * 3);

    set.apply({ v: 1, t: 0, streams: [] });
    run(LOOK.lifeRange[1] + 30);
    expect(particles.count).toBe(0);
    expect(set.slots.some((s) => s.used)).toBe(false);

    // A stream joining the empty river eases in, slower than one present from the first frame.
    const fromStart = setup(500, stream("c"));
    fromStart.run(1);
    set.apply({ v: 1, t: 0, streams: [stream("c")] });
    run(1);
    expect(particles.count).toBeGreaterThan(0);
    expect(particles.count).toBeLessThan(0.75 * fromStart.particles.count);
    run(LOOK.turnoverSeconds * 3);
    fromStart.run(LOOK.turnoverSeconds * 3);
    expect(particles.count).toBeGreaterThan(0.9 * fromStart.particles.count);
  });

  it("stops births from a removed stream once its presence falls below the drain presence", () => {
    const { set, particles, run } = setup(2000, stream("a"), stream("b"));
    run(LOOK.turnoverSeconds * 2);
    set.apply({ v: 1, t: 0, streams: [stream("b")] });
    const a = set.slots.find((s) => s.id === "a")!;
    while (a.presence >= DRAIN_PRESENCE) run(DT);
    // From here on its count only falls, and reaches zero within the longest lifetime.
    let previous = a.particles;
    for (let t = 0; t < LOOK.lifeRange[1] + 1 && a.used; t += DT) {
      run(DT);
      if (!a.used) break;
      expect(a.particles).toBeLessThanOrEqual(previous);
      previous = a.particles;
    }
    expect(a.used).toBe(false);
  });

  it("scales intensity with intensityScale", () => {
    const one = setup(200, stream("a"));
    const two = setup(200, stream("a"));
    two.particles.intensityScale = 2;
    const n = one.run(3);
    expect(two.run(3)).toBe(n);
    const intensity = (p: ParticleSystem): number => p.instances[5];
    expect(intensity(two.particles)).toBeCloseTo(2 * intensity(one.particles));
  });

  describe("stable slots", () => {
    /** Dirty metadata slots, from the flags the renderer reads. */
    const dirty = (p: ParticleSystem): number[] => {
      const out: number[] = [];
      for (let i = p.dirtyStart; i < p.dirtyEnd; i++) if (p.metadataDirty[i]) out.push(i);
      return out;
    };

    it("writes each spawn's stream and size once, marks only those slots dirty, and keeps them while it lives", () => {
      const { set, particles, run } = setup(400, stream("a"), stream("b"));
      run(DT);
      const spawned = dirty(particles);
      expect(spawned.length).toBe(particles.count);
      const live = liveFlags(particles);
      for (const i of spawned) {
        expect(live[i]).toBe(1);
        expect(set.slots[particles.metadata[i * METADATA_FLOATS]].used).toBe(true);
        expect(particles.metadata[i * METADATA_FLOATS + 1]).toBeGreaterThan(0);
      }
      particles.clearMetadataDirty();
      expect(dirty(particles)).toEqual([]);
      expect(particles.dirtyStart).toBeGreaterThanOrEqual(particles.dirtyEnd);

      // Survivors keep their slot and metadata; only births are dirty.
      const before = Float32Array.from(particles.metadata);
      const survivors = spawned.filter((i) => live[i]);
      run(0.5);
      const births = new Set(dirty(particles));
      for (const i of survivors) {
        if (!live[i] || births.has(i)) continue;
        expect(particles.metadata.subarray(i * METADATA_FLOATS, (i + 1) * METADATA_FLOATS)).toEqual(before.subarray(i * METADATA_FLOATS, (i + 1) * METADATA_FLOATS));
      }
      for (const i of births) expect(live[i]).toBe(1);
    });

    it("zeroes a dead slot's intensity, reuses freed slots and trims the draw count", () => {
      const { particles, run } = setup(300, stream("a", { density: 1 }));
      particles.limit = 150;
      run(LOOK.turnoverSeconds * 2);
      const live = liveFlags(particles);
      const check = (): void => {
        let highest = -1, count = 0;
        for (let i = 0; i < particles.capacity; i++) {
          if (live[i]) { highest = i; count++; } else if (i < particles.drawCount) expect(particles.instances[i * INSTANCE_FLOATS + 5]).toBe(0);
        }
        expect(particles.drawCount).toBe(highest + 1);
        expect(particles.count).toBe(count);
      };
      check();
      // Freed slots are taken again before untouched ones: the pool never holds more than `limit`, so
      // through many turnovers the drawn prefix stays within it rather than creeping up to capacity.
      for (let k = 0; k < 20; k++) {
        run(0.5);
        check();
        expect(particles.drawCount).toBeLessThanOrEqual(particles.limit);
      }
      // Lowering the limit leaves holes; draining every particle empties the drawn prefix.
      particles.limit = 20;
      run(LOOK.lifeRange[1] + 1);
      check();
      particles.limit = 0;
      run(LOOK.lifeRange[1] + 1);
      check();
      expect(particles.drawCount).toBe(0);
    });

    it("gives a slot taken by a new stream that stream's index", () => {
      const { set, particles, run } = setup(300, stream("a"), stream("b"));
      run(LOOK.turnoverSeconds);
      // Daily rotation: both IDs replaced; new streams claim slots once the old ones drain.
      set.apply({ v: 1, t: 0, streams: [stream("c"), stream("d")] });
      run(LOOK.lifeRange[1] + 30);
      const live = liveFlags(particles);
      const ids = new Set<string>();
      for (let i = 0; i < particles.drawCount; i++) {
        if (!live[i]) continue;
        const slot = set.slots[particles.metadata[i * METADATA_FLOATS]];
        expect(slot.used).toBe(true);
        ids.add(slot.id);
      }
      expect([...ids].sort()).toEqual(["c", "d"]);
    });
  });
});
