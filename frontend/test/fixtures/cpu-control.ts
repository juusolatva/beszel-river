import { ParticleSystem } from "../../src/sim/particles";
import { StreamSet } from "../../src/sim/streams";
import { mulberry32 } from "../../src/util/math";

// Test-only access: change the CPU control's random source, never production policy.
export interface Storage {
  takeLowestFree(): number; active: Uint8Array; slot: Uint8Array;
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  age: Float32Array; life: Float32Array; speedJitter: Float32Array;
}

/**
 * A CPU ParticleSystem whose random source (`pcg`: the GPU's per-birth PCG keys instead of one mulberry32
 * sequence) can be matched to the GPU prototype's. Its free-slot order already matches: since 2026-11-28
 * `ParticleSystem` takes the lowest free slot, as the GPU prefix scan does (before, an `ascending` option
 * emulated that over a stack of freed slots). `onDraw`, if given, sees every draw with the index it
 * belongs to.
 */
export function cpuControl(capacity: number, seed: number, pcg: boolean,
  onDraw?: (index: number, generation: number, value: number) => void) {
  // The slot of the birth in progress, recorded as the pool takes it.
  let storage: Storage, lastIndex = -1, state = 0, taken = -1;
  const counters = new Uint32Array(capacity);
  const random = pcg ? () => {
    // spawn() takes the slot immediately before the birth's first random draw.
    const index = taken;
    if (index !== lastIndex) {
      lastIndex = index;
      // Expansion only: no releases or reclaims, so every GPU generation is 1.
      state = (seed ^ Math.imul(index, 0x9e3779b9) ^ 0x85ebca6b ^ Math.imul(++counters[index], 0xc2b2ae35)) >>> 0;
    }
    state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
    const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
    const value = (((word >>> 22) ^ word) >>> 8) / 16777216;
    onDraw?.(index, counters[index], value);
    return value;
  } : mulberry32(seed);
  const particles = new ParticleSystem(capacity, random);
  storage = particles as unknown as Storage;
  const take = storage.takeLowestFree.bind(particles);
  storage.takeLowestFree = () => (taken = take());
  const streams = new StreamSet(1);
  return { particles, streams, storage, spawn(dt: number) {
    lastIndex = -1;
    particles.spawn(dt, streams);
  } };
}
