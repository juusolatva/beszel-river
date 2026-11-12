import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../src/config";
import { FlowField } from "../src/sim/noise";
import { ParticleSystem } from "../src/sim/particles";
import { StreamSet, StreamSlot } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";

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

/** Paired CPU-only comparison; run in test/benchmark.html, separately from unit tests or live profiling. */
export async function runCpuBenchmark(): Promise<{
  userAgent: string; seed: number; capacity: number; aspect: number; pixelRatio: number;
  warmupFrames: number; measuredFrames: number;
  runs: { cached: boolean; meanMs: number; p50Ms: number; p95Ms: number; live: number }[];
}> {
  const runs: { cached: boolean; meanMs: number; p50Ms: number; p95Ms: number; live: number }[] = [];
  const warmupFrames = 600, measuredFrames = 1200, capacity = 20000, aspect = 1.5, pixelRatio = 1.5;
  const times = new Float64Array(measuredFrames);
  for (const cached of [false, true, true, false, false, true]) {
    const streams = new StreamSet(1);
    for (const slot of streams.slots) {
      slot.centerAt = cached ? StreamSlot.prototype.centerAt : analyticCenter;
      slot.rebuildCenters = cached ? StreamSlot.prototype.rebuildCenters : skipRebuild;
    }
    const field = new FlowField(mulberry32(42));
    const particles = new ParticleSystem(capacity, mulberry32(43));
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
    runs.push({ cached, meanMs, p50Ms: times[Math.floor(measuredFrames * 0.5)], p95Ms: times[Math.floor(measuredFrames * 0.95)], live: count });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return { userAgent: navigator.userAgent, seed: 42, capacity, aspect, pixelRatio, warmupFrames, measuredFrames, runs };
}
