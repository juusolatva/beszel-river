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
    this.pending = 0;
    return dt;
  }
}

/** The GPU simulation, its drawer and its step clock, set up and ready to step. */
export interface GpuBackend {
  readonly particles: GpuParticles;
  readonly drawer: GpuParticleDrawer;
  readonly clock: GpuStepClock;
}

/**
 * Sets up the GPU simulation with spawning on, and its drawer, compiling every shader now. WebGL2 can
 * exist while this fails (too-small limits, an incomplete integer target, a shader the driver rejects):
 * then it releases whatever it made and throws, and the caller runs the CPU simulation instead.
 */
export function createGpuBackend(gl: WebGL2RenderingContext, capacity: number, seed: number): GpuBackend {
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
  return { particles, drawer, clock: new GpuStepClock() };
}
