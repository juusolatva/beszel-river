import type { GpuParticles } from "../../src/sim/gpu-particles";
import { GPU_STATE_STRIDE_BYTES } from "../../src/sim/gpu-layout";
import { ParticleSystem } from "../../src/sim/particles";
import type { StreamSet } from "../../src/sim/streams";

const fields = ["x", "y", "vx", "vy", "age", "life", "hueJitter", "size", "speedJitter", "offset"] as const;
type CpuStorage = Record<typeof fields[number], Float32Array> & { slot: Uint8Array; active: Uint8Array; freeTop: number };

/** Test-only upload; readbacks and initial-state injection never enter production animation. */
export function preloadGpuState(gl: WebGL2RenderingContext, particles: GpuParticles, state: ArrayBuffer): void {
  if (state.byteLength !== particles.capacity * GPU_STATE_STRIDE_BYTES) throw new Error("Fixture capacity mismatch");
  gl.bindBuffer(gl.ARRAY_BUFFER, particles.stateBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(state));
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

/** Inject the identical fixture into the unmodified CPU reference, bypassing spawning RNG. */
export function preloadCpuState(state: ArrayBuffer, streams: StreamSet): ParticleSystem {
  const capacity = state.byteLength / GPU_STATE_STRIDE_BYTES;
  const cpu = new ParticleSystem(capacity, () => 0.5);
  const storage = cpu as unknown as CpuStorage;
  const floats = new Float32Array(state);
  const words = new Uint32Array(state);
  let active = 0;
  for (let i = 0; i < capacity; i++) {
    for (let j = 0; j < fields.length; j++) storage[fields[j]][i] = floats[i * 16 + j];
    storage.slot[i] = words[i * 16 + 12];
    storage.active[i] = words[i * 16 + 14];
    if (storage.active[i]) { active++; streams.slots[storage.slot[i]].particles++; }
  }
  storage.freeTop = capacity - active;
  return cpu;
}

/** Compare stored Float32 state, rather than the renderer's derived instance positions. */
export function compareMotion(state: ArrayBuffer, cpu: ParticleSystem, tolerance: number): number {
  const floats = new Float32Array(state);
  const words = new Uint32Array(state);
  const storage = cpu as unknown as CpuStorage;
  let maxError = 0;
  for (let i = 0; i < cpu.capacity; i++) {
    if (words[i * 16 + 12] !== storage.slot[i] || words[i * 16 + 14] !== storage.active[i]) throw new Error(`Identity mismatch at ${i}: slot ${words[i * 16 + 12]}/${storage.slot[i]}, active ${words[i * 16 + 14]}/${storage.active[i]}`);
    for (let j = 0; j < fields.length; j++) {
      const error = Math.abs(floats[i * 16 + j] - storage[fields[j]][i]);
      if (!Number.isFinite(error) || error > tolerance) throw new Error(`Motion mismatch at ${i}/${fields[j]}: ${error}`);
      maxError = Math.max(maxError, error);
    }
  }
  return maxError;
}
