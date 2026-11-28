import type { Stream } from "@beszel-river/shared";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { FlowField } from "../src/sim/noise";
import { INSTANCE_FLOATS, ParticleSystem } from "../src/sim/particles";
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
    const d = i * INSTANCE_FLOATS, o = n++ * 9;
    out.set(particles.instances.subarray(d, d + 4), o);
    out[o + 4] = particles.instances[d + 4];
    out[o + 5] = streams.chroma[particles.instances[d + 6]];
    out[o + 6] = LOOK.lightness;
    out[o + 7] = particles.instances[d + 5];
    out[o + 8] = particles.instances[d + 7] * LOOK.sizePx * pixelRatio;
  }
  expect(n).toBe(particles.count);
  return out;
}

/**
 * FNV-1a over the nine-float records sorted by their bits, so it checks every drawn value but not
 * which slot holds which particle: the pool's slot assignment is free to change.
 */
function hashRecords(records: Float32Array): string {
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const order = Array.from({ length: records.length / 9 }, (_, i) => i);
  order.sort((a, b) => {
    for (let k = 0; k < 9; k++) if (words[a * 9 + k] !== words[b * 9 + k]) return words[a * 9 + k] - words[b * 9 + k];
    return 0;
  });
  let h = 0x811c9dc5;
  for (const i of order) for (let k = 0; k < 9; k++) h = Math.imul(h ^ words[i * 9 + k], 0x01000193) >>> 0;
  return h.toString(16);
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

  // Every drawn value must stay bit-identical through grid resizes from aspect changes. First recorded
  // (slot order, 938973b2 and 7b0724a4) with the step that called `FlowField.sample` per particle and
  // wrote nine compacted floats per live particle; `drawn` rebuilds those records from stable slots.
  // Re-recorded order-independently on 2026-11-28 with the LIFO free stack, before lowest-free-slot
  // allocation, which moves particles between slots but must not change one of them.
  it.each([
    [undefined, 666, "d8ea4b22"],
    [[0.1, 0.2, 0.9, 0.3, 0.1, 0], 629, "6347784e"],
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
    expect([n, hashRecords(drawn(particles, set))]).toEqual([count, hash]);
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
    /** The pool's private particle ages, which tell a survivor from a newborn in the same slot. */
    const ages = (p: ParticleSystem): Float32Array => (p as unknown as { age: Float32Array }).age;
    /** A slot's spawn-time floats: stream slot index and size jitter. */
    const spawnFloats = (p: ParticleSystem, i: number): number[] => [p.instances[i * INSTANCE_FLOATS + 6], p.instances[i * INSTANCE_FLOATS + 7]];

    it("writes each spawn's stream and size into its record and keeps them while it lives", () => {
      const { set, particles, run } = setup(400, stream("a"), stream("b"));
      run(1);
      const live = liveFlags(particles);
      const spawned: number[] = [];
      for (let i = 0; i < particles.drawCount; i++) if (live[i]) spawned.push(i);
      expect(spawned).toHaveLength(particles.count);
      expect(spawned.length).toBeGreaterThan(0);
      for (const i of spawned) {
        const [slotIndex, size] = spawnFloats(particles, i);
        expect(set.slots[slotIndex].used).toBe(true);
        expect(size).toBeGreaterThanOrEqual(LOOK.sizeJitter[0]);
        expect(size).toBeLessThanOrEqual(LOOK.sizeJitter[1]);
      }

      // Steps rewrite only the dynamic floats: a particle that lived through them keeps its stream and size.
      const before = spawned.map((i) => spawnFloats(particles, i));
      run(0.5);
      let kept = 0;
      spawned.forEach((i, k) => {
        if (!live[i] || ages(particles)[i] < 0.5) return;
        expect(spawnFloats(particles, i)).toEqual(before[k]);
        kept++;
      });
      expect(kept).toBeGreaterThan(0);
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

    it("draws only up to the lowered limit within one lifetime after the budget drops", () => {
      // As on the page: the budget starts at the full pool and lowers the limit once it is populated.
      const { particles, run } = setup(1000, stream("a", { density: 1 }), stream("b", { density: 1 }));
      run(LOOK.turnoverSeconds * 2);
      expect(particles.drawCount).toBeGreaterThan(800);
      particles.limit = 250;
      // Births take the lowest free slot, which lies below the limit while fewer than `limit` live, so
      // once the particles from before the drop have died nothing is drawn past it.
      run(LOOK.lifeRange[1] + 0.5);
      expect(particles.count).toBeLessThanOrEqual(250);
      expect(particles.count).toBeGreaterThan(200);
      expect(particles.drawCount).toBeLessThanOrEqual(250);
      for (let k = 0; k < 10; k++) {
        run(0.5);
        expect(particles.drawCount).toBeLessThanOrEqual(250);
      }
    });

    it("never hands out a slot past the capacity, including in a partly used last bitset word", () => {
      for (const capacity of [1, 31, 33, 100]) {
        const { particles, run } = setup(capacity, stream("a", { density: 1 }));
        for (let k = 0; k < 40; k++) {
          run(0.25);
          expect(particles.drawCount).toBeLessThanOrEqual(capacity);
          expect(particles.count).toBeLessThanOrEqual(capacity);
        }
        // Draining the free set directly: every slot once, lowest first, none past the capacity.
        const fresh = new ParticleSystem(capacity, mulberry32(1)) as unknown as { takeLowestFree(): number; count: number };
        const taken = Array.from({ length: capacity }, () => fresh.takeLowestFree());
        expect(taken).toEqual(Array.from({ length: capacity }, (_, i) => i));
        expect(fresh.count).toBe(capacity);
      }
    });

    it("rebuilds the free slots and live count from directly written state", () => {
      const { set, particles, run } = setup(64, stream("a", { density: 1 }));
      // Let the stream ease in, so it has a share to spawn with.
      run(1);
      const live = liveFlags(particles);
      // Slots 0-9 and 40 live, written by hand as fixtures do; nothing else.
      live.fill(0);
      for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40]) live[i] = 1;
      particles.resync();
      expect(particles.count).toBe(11);
      expect(particles.drawCount).toBe(41);
      // The next births fill slot 10 upwards, not slot 40's neighbours or anything past it.
      particles.limit = 13;
      set.slots[0].spawnCarry = 2.5;
      particles.spawn(0, set);
      expect([live[10], live[11], live[12]]).toEqual([1, 1, 0]);
      expect(particles.count).toBe(13);
      expect(particles.drawCount).toBe(41);
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
        const slot = set.slots[particles.instances[i * INSTANCE_FLOATS + 6]];
        expect(slot.used).toBe(true);
        ids.add(slot.id);
      }
      expect([...ids].sort()).toEqual(["c", "d"]);
    });
  });
});
