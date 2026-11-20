import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../src/config";
import { FlowField } from "../src/sim/noise";
import { INSTANCE_FLOATS, ParticleSystem } from "../src/sim/particles";
import { CENTER_MAX_Y, CENTER_MIN_Y, CENTER_SAMPLES, CENTER_SCALE, StreamSet, StreamSlot } from "../src/sim/streams";
import { clamp, fract, mulberry32 } from "../src/util/math";

// Synthetic channel snapshots, fixed across runs; no live hub or private metrics are involved.
const frames: Frame[] = Array.from({ length: 6 }, (_, n) => ({
  v: 1,
  t: n * 5000,
  streams: Array.from({ length: 4 }, (_, i) => ({
    id: `benchmark-${i}`, alive: true, width: [0.25, 0.5, 0.75, 1][i],
    flow: [0.3, 0.5, 0.7, 0.4][(i + n) % 4], density: 0.9, turbulence: 0.7, pulse: 0, heat: 0.5,
    ...(n % 2 === 0 ? { filaments: [0.1, 0.2, 0.9, 0.3, 0.2, 0.1] } : {}),
  })),
}));

function analyticCenter(this: StreamSlot, y: number): number {
  return this.center + this.half * LOOK.braid * Math.sin(2 * Math.PI * (y * LOOK.braidWaves + this.phase) + this.braidAngle);
}

function skipRebuild(): void {}

/** The pool's private state, for the reference step below. */
interface Pool {
  capacity: number; instances: Float32Array; x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  age: Float32Array; life: Float32Array; hueJitter: Float32Array; size: Float32Array; speedJitter: Float32Array;
  offset: Float32Array; slot: Uint8Array; active: Uint8Array; free: Int32Array; freeTop: number; globalHue: number; intensityScale: number;
}

/**
 * `ParticleSystem.step` with a `StreamSlot.centerAt` call per particle, as it was before the centre
 * table was inlined; with `analyticCenter` as `centerAt`, as it was before Task 3. Same flow sampling
 * as production.
 */
function calledStep(this: ParticleSystem, dt: number, streams: StreamSet, field: FlowField, aspect: number, devicePixelRatio: number): number {
  const p = this as unknown as Pool;
  const { x, y, vx, vy, age, life, instances } = p;
  const slots = streams.slots;
  const k = 1 - Math.exp(-dt / LOOK.inertia);
  const sizeScale = LOOK.sizePx * devicePixelRatio;
  const flow = field.vectors, cols = field.gridCols, cell = field.gridCell;
  const maxFx = cols - 1.001, maxFy = field.gridRows - 1.001;
  p.globalHue = fract(p.globalHue + LOOK.hueRotate * dt);
  let n = 0;
  for (let i = 0; i < p.capacity; i++) {
    if (!p.active[i]) continue;
    const s = slots[p.slot[i]];
    age[i] += dt;
    if (age[i] > life[i] || y[i] > 1.08 || x[i] < -0.1 || x[i] > aspect + 0.1) {
      p.active[i] = 0;
      p.free[p.freeTop++] = i;
      s.particles--;
      continue;
    }
    const fx = Math.min(Math.max(x[i] / cell, 0), maxFx);
    const fy = Math.min(Math.max(y[i] / cell, 0), maxFy);
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const i00 = (r * cols + c) * 2;
    const i10 = i00 + cols * 2;
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;
    const flowX = flow[i00] * w00 + flow[i00 + 2] * w01 + flow[i10] * w10 + flow[i10 + 2] * w11;
    const flowY = flow[i00 + 1] * w00 + flow[i00 + 3] * w01 + flow[i10 + 1] * w10 + flow[i10 + 3] * w11;
    const up = s.speed * p.speedJitter[i];
    const limit = LOOK.maxSlope * up;
    const side = clamp(flowX * s.turbulenceAmp * up + (s.centerAt(y[i]) + p.offset[i] * s.half - x[i]) * LOOK.steer, -limit, limit);
    vx[i] += (side - vx[i]) * k;
    vy[i] += (up * (1 + 0.3 * flowY * s.turbulenceAmp) - vy[i]) * k;
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
    const fade = Math.min(age[i] / LOOK.fadeIn, (life[i] - age[i]) / LOOK.fadeOut, 1);
    const o = n * INSTANCE_FLOATS;
    instances[o] = x[i] - vx[i] * s.streakSeconds;
    instances[o + 1] = y[i] - vy[i] * s.streakSeconds;
    instances[o + 2] = x[i];
    instances[o + 3] = y[i];
    instances[o + 4] = fract(p.globalHue + y[i] * LOOK.hueGradient + s.hueOffset + p.hueJitter[i]);
    instances[o + 5] = s.chroma;
    instances[o + 6] = LOOK.lightness;
    instances[o + 7] = LOOK.intensity * p.intensityScale * fade * s.brightness;
    instances[o + 8] = p.size[i] * sizeScale;
    n++;
  }
  return n;
}

/**
 * `ParticleSystem.step` as it was before Task 4: one `FlowField.sample` call per particle, read back
 * through `sx`/`sy`. Same results bit for bit (see particles.test.ts); kept only as the benchmark's reference.
 * Centre lines are interpolated inline as in production, so only the flow sampling differs.
 */
function sampledStep(this: ParticleSystem, dt: number, streams: StreamSet, field: FlowField, aspect: number, devicePixelRatio: number): number {
  const p = this as unknown as Pool;
  const { x, y, vx, vy, age, life, instances } = p;
  const slots = streams.slots;
  const k = 1 - Math.exp(-dt / LOOK.inertia);
  const sizeScale = LOOK.sizePx * devicePixelRatio;
  const centers = streams.centers;
  p.globalHue = fract(p.globalHue + LOOK.hueRotate * dt);
  let n = 0;
  for (let i = 0; i < p.capacity; i++) {
    if (!p.active[i]) continue;
    const slotIndex = p.slot[i];
    const s = slots[slotIndex];
    age[i] += dt;
    if (age[i] > life[i] || y[i] > 1.08 || x[i] < -0.1 || x[i] > aspect + 0.1) {
      p.active[i] = 0;
      p.free[p.freeTop++] = i;
      s.particles--;
      continue;
    }
    field.sample(x[i], y[i]);
    const py = y[i];
    let center: number;
    if (py < CENTER_MIN_Y || py > CENTER_MAX_Y) {
      center = s.centerAt(py);
    } else {
      const position = (py - CENTER_MIN_Y) * CENTER_SCALE;
      const sample = Math.min(Math.floor(position), CENTER_SAMPLES - 2);
      const c = slotIndex * CENTER_SAMPLES + sample;
      center = centers[c] + (centers[c + 1] - centers[c]) * (position - sample);
    }
    const up = s.speed * p.speedJitter[i];
    const limit = LOOK.maxSlope * up;
    const side = clamp(field.sx * s.turbulenceAmp * up + (center + p.offset[i] * s.half - x[i]) * LOOK.steer, -limit, limit);
    vx[i] += (side - vx[i]) * k;
    vy[i] += (up * (1 + 0.3 * field.sy * s.turbulenceAmp) - vy[i]) * k;
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
    const fade = Math.min(age[i] / LOOK.fadeIn, (life[i] - age[i]) / LOOK.fadeOut, 1);
    const o = n * INSTANCE_FLOATS;
    instances[o] = x[i] - vx[i] * s.streakSeconds;
    instances[o + 1] = y[i] - vy[i] * s.streakSeconds;
    instances[o + 2] = x[i];
    instances[o + 3] = y[i];
    instances[o + 4] = fract(p.globalHue + y[i] * LOOK.hueGradient + s.hueOffset + p.hueJitter[i]);
    instances[o + 5] = s.chroma;
    instances[o + 6] = LOOK.lightness;
    instances[o + 7] = LOOK.intensity * p.intensityScale * fade * s.brightness;
    instances[o + 8] = p.size[i] * sizeScale;
    n++;
  }
  return n;
}

export type Variant = "analytic" | "called" | "inline" | "sampled" | "inlined";
type Run = { variant: Variant; meanMs: number; p50Ms: number; p95Ms: number; live: number };

/**
 * Paired CPU-only comparison; run in test/benchmark.html, separately from unit tests or live profiling.
 * `centres` (Task 3) compares braid centres from the sine per particle (`analytic`), from the cached
 * table through a `centerAt` call per particle (`called`), and from the table inlined in the step
 * (`inline`, production). `flow` (Task 4) compares a `FlowField.sample` call per particle with the
 * inlined sampling, both with inlined centres. The production variants, `inline` and `inlined`,
 * replace nothing; the others set methods on the run's own instances.
 *
 * `order` replaces the default ABBAAB run order. Each variant swaps methods on fresh instances, and
 * once a page has run both, the JIT keeps the call sites polymorphic: later runs of the first variant
 * slow down (Firefox: analytic 0.70 → 0.95 ms on the 9600X desktop). Production has one implementation,
 * so compare variants run alone, each in a fresh browser (`cpu-benchmark-run.mjs`), and never run a
 * second comparison in the same page.
 */
export async function runCpuBenchmark(compare: "centres" | "flow" = "centres", order?: readonly Variant[]): Promise<{
  userAgent: string; compare: "centres" | "flow"; seed: number; capacity: number; aspect: number; pixelRatio: number;
  warmupFrames: number; measuredFrames: number; runs: Run[];
}> {
  const runs: Run[] = [];
  const warmupFrames = 600, measuredFrames = 1200, capacity = 20000, aspect = 1.5, pixelRatio = 1.5;
  const times = new Float64Array(measuredFrames);
  const variants: Variant[] = compare === "centres" ? ["analytic", "called", "inline"] : ["sampled", "inlined"];
  const [a, b]: Variant[] = compare === "centres" ? ["analytic", "inline"] : variants;
  const plan = order ?? [a, b, b, a, a, b];
  if (plan.length === 0 || plan.some((variant) => !variants.includes(variant))) {
    throw new Error(`order must list only ${variants.join(", ")}`);
  }
  for (const variant of plan) {
    const streams = new StreamSet(1);
    if (variant === "analytic") {
      for (const slot of streams.slots) {
        slot.centerAt = analyticCenter;
        slot.rebuildCenters = skipRebuild;
      }
    }
    const field = new FlowField(mulberry32(42));
    const particles = new ParticleSystem(capacity, mulberry32(43));
    if (variant === "analytic" || variant === "called") particles.step = calledStep;
    if (variant === "sampled") particles.step = sampledStep;
    let count = 0;
    for (let frame = 0; frame < warmupFrames + measuredFrames; frame++) {
      if (frame % 300 === 0) streams.apply(frames[frame / 300]);
      const start = performance.now();
      streams.update(1 / 60, aspect);
      field.update(frame / 60, aspect);
      particles.spawn(1 / 60, streams);
      count = particles.step(1 / 60, streams, field, aspect, pixelRatio);
      if (frame >= warmupFrames) times[frame - warmupFrames] = performance.now() - start;
    }
    const meanMs = times.reduce((sum, n) => sum + n, 0) / measuredFrames;
    times.sort();
    runs.push({ variant, meanMs, p50Ms: times[Math.floor(measuredFrames * 0.5)], p95Ms: times[Math.floor(measuredFrames * 0.95)], live: count });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return { userAgent: navigator.userAgent, compare, seed: 42, capacity, aspect, pixelRatio, warmupFrames, measuredFrames, runs };
}
