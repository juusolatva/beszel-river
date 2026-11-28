import { LOOK } from "./config";
import { GpuParticleDrawer } from "./render/gpu-particle-drawer";
import { GpuParticles } from "./sim/gpu-particles";

/** Smallest positive step the GPU simulation accepts (`effectiveGpuStep`). */
export const MIN_GPU_STEP = 1 / 256;

/**
 * Turns callback intervals into GPU steps. The GPU's age arithmetic needs steps of at least 1/256 s
 * (`effectiveGpuStep`), which a 360 Hz display undercuts every frame and Firefox's timestamp jitter
 * undercuts now and then at 60 Hz. Shorter intervals add up until they reach it; callbacks in between
 * simulate and draw nothing, so the canvas keeps showing the last image.
 */
export class GpuStepClock {
  /** Wall-clock seconds the last step covers, before the clamp: every interval added into it. */
  interval = 0;
  private pending = 0;

  /**
   * The step to run this callback, in seconds: 0 while the intervals so far add up to less than
   * 1/256 s, otherwise their sum clamped to `LOOK.maxDt`, as Float32 so every consumer sees the same
   * value. Time beyond the clamp is dropped, as on the CPU path (a hidden tab's pause).
   */
  take(interval: number): number {
    if (Number.isNaN(interval) || interval <= 0) return 0;
    this.pending += interval;
    if (this.pending < MIN_GPU_STEP) return 0;
    // Float32 rounding keeps a sum of at least 1/256 at or above it, since 1/256 is exact.
    const dt = Math.fround(Math.min(this.pending, LOOK.maxDt));
    this.interval = this.pending;
    this.pending = 0;
    return dt;
  }
}

/** The GPU simulation, its drawer, its step clock and its live count for the budget, ready to step. */
export interface GpuBackend {
  readonly particles: GpuParticles;
  readonly drawer: GpuParticleDrawer;
  readonly clock: GpuStepClock;
  readonly live: GpuBudgetLive;
}

/**
 * Sets up the GPU simulation with spawning on, and its drawer, compiling every shader now. WebGL2 can
 * exist while this fails (too-small limits, an incomplete integer target, a shader the driver rejects):
 * then it releases whatever it made and throws, and the caller runs the CPU simulation instead.
 * `alwaysCount` reads the live count back throughout (`GpuBudgetLive`), for `?debug`.
 */
export function createGpuBackend(gl: WebGL2RenderingContext, capacity: number, seed: number, alwaysCount = false): GpuBackend {
  // The constructor releases its own resources when it throws.
  const particles = new GpuParticles(gl, capacity, seed);
  let drawer: GpuParticleDrawer | null = null;
  try {
    drawer = new GpuParticleDrawer(gl, particles);
    drawer.prepare();
  } catch (error) {
    drawer?.dispose();
    particles.dispose();
    throw error;
  }
  particles.spawningEnabled = true;
  return { particles, drawer, clock: new GpuStepClock(), live: new GpuBudgetLive(particles, alwaysCount) };
}

/**
 * The GPU's live count as `ParticleBudget` needs it. The budget uses it only as `live <= limit`, to
 * count overload after a drop only once the particles above the new limit have died. That holds at the
 * start (the limit is the pool size) and keeps holding, since births never exceed `limit - live` and a
 * rise only widens the gap; only a drop breaks it. So counts are read back only from a drop until one
 * is at or below the new limit, never in steady state (`alwaysCount`, for `?debug`, reads them throughout).
 */
export class GpuBudgetLive {
  private atMostLimit = true;

  constructor(private readonly particles: Pick<GpuParticles, "liveCount" | "countingLive" | "forgetLiveCount">, private readonly alwaysCount: boolean) {
    particles.countingLive = alwaysCount;
  }

  /**
   * The live count to pass to `ParticleBudget.update` with the current `limit`: the exact count when
   * one is known, `limit` when the count is known to be at most that but not read, and `Infinity` while
   * a drop is unconfirmed, so no overload counts yet.
   */
  live(limit: number): number {
    const count = this.particles.liveCount;
    if (!this.atMostLimit) {
      if (count === null || count > limit) return Infinity;
      this.atMostLimit = true;
      this.particles.countingLive = this.alwaysCount;
    }
    return count !== null && count <= limit ? count : limit;
  }

  /** Call after the budget lowers the limit: counts from before the drop prove nothing any more. */
  dropped(): void {
    this.atMostLimit = false;
    this.particles.countingLive = true;
    this.particles.forgetLiveCount();
  }
}
