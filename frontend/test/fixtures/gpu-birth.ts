import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../../src/config";
import { FlowField } from "../../src/sim/noise";
import { mulberry32 } from "../../src/util/math";
import { cpuControl } from "./cpu-control";
import { replayFrames } from "./gpu-replay";

/**
 * The first matched-control divergence recorded in docs/experiments/2026-11-13-gpu-occupancy.json
 * (plain scenario, simulated 6.5000000969 s, particle 674): CPU x before motion and the GPU's stored x.
 */
export const RECORDED_BIRTH = {
  time: 6.500000096857548,
  index: 674,
  cpuX: -0.09998229146003723,
  gpuX: -0.10000331699848175,
} as const;

/** Inputs to the plain spawn position of one birth, as the matched CPU control computed them. */
export interface BirthInputs {
  /** The Box–Muller inputs: `1 - draw`, and the next draw. Both are exact 24-bit fractions. */
  u: number; v: number;
  /** The stream's cached centre line, as the GPU receives it (Float32 texels), and its half-width. */
  centers: Float32Array; half: number;
  /** The birth as stored by the CPU before motion. */
  x: number; y: number; life: number; speedJitter: number;
}

/**
 * Replays the matched plain control of the occupancy investigation (seed 42, 0.1 s steps, aspect 1.5,
 * one stream, PCG keys and ascending free order) up to `RECORDED_BIRTH` and returns that birth's
 * inputs. Uses only the CPU, so it runs in Node.
 */
export function replayRecordedBirth(): BirthInputs {
  const capacity = 10000, seed = 42, dt = Math.fround(0.1), aspect = 1.5;
  let watching = false, generation = 0;
  const draws: number[] = [];
  const control = cpuControl(capacity, seed, true, true, (index, drawGeneration, value) => {
    if (!watching || index !== RECORDED_BIRTH.index) return;
    if (drawGeneration !== generation) { generation = drawGeneration; draws.length = 0; }
    draws.push(value);
  });
  const field = new FlowField(mulberry32(seed));
  const frame: Frame = { v: 1, t: 0, streams: [{ ...replayFrames[2].streams[0], id: "old-0",
    width: 0.5, flow: 0, density: 1, turbulence: 0.5, pulse: 0 }] };
  control.streams.apply(frame);
  let time = 0;
  for (let step = 0; step < 600; step++) {
    time += dt;
    field.update(time, aspect);
    control.streams.update(dt, aspect);
    watching = time === RECORDED_BIRTH.time;
    control.spawn(dt);
    if (watching) {
      const { storage } = control, i = RECORDED_BIRTH.index;
      // Draw order in spawn(): speed jitter, then the two Box–Muller inputs (no filament draw here).
      if (draws.length < 3 || storage.active[i] !== 1) throw new Error("The recorded birth did not happen");
      const slot = control.streams.slots[storage.slot[i]];
      const centers = new Float32Array(64);
      slot.writeCenters(centers, 0);
      return { u: 1 - draws[1], v: draws[2], centers, half: slot.half,
        x: storage.x[i], y: storage.y[i], life: storage.life[i], speedJitter: storage.speedJitter[i] };
    }
    control.particles.step(dt, control.streams, field, aspect, 1);
  }
  throw new Error("The replay ended before the recorded birth");
}

/**
 * The shader's plain spawn x (`centerAt(0.0) + gaussian() * band.y * u_birth.z`) in Float32 for a given
 * `gaussian()` result, with the centre interpolated from the Float32 table as simulate.vert does.
 */
export function shaderSpawnX(birth: BirthInputs, gaussian: number): number {
  const f = Math.fround;
  const position = f(f(0.0 + 0.02) * f(63.0 / 1.1));
  const i = Math.floor(position), a = birth.centers[i], b = birth.centers[i + 1];
  const center = f(a + f(f(b - a) * f(position - i)));
  return f(center + f(f(f(gaussian) * f(birth.half)) * f(LOOK.spawnSpread)));
}

/** gaussian()'s expression in simulate.vert, for diagnostics that must evaluate exactly the same GLSL. */
export const SHADER_GAUSSIAN = "sqrt(-2.0 * log(u)) * cos(6.283185307179586 * v)";

/** Box–Muller as gaussian() in src/util/math.ts computes it, in double precision. */
export function referenceGaussian(u: number, v: number): number {
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
