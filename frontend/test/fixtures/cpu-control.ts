import { ParticleSystem } from "../../src/sim/particles";
import { StreamSet } from "../../src/sim/streams";
import { mulberry32 } from "../../src/util/math";

// Test-only access: change the CPU control's free order/random source, never production policy.
export interface Storage {
  free: Int32Array; freeTop: number; active: Uint8Array; slot: Uint8Array;
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  age: Float32Array; life: Float32Array; speedJitter: Float32Array;
}

/**
 * A CPU ParticleSystem whose random source (`pcg`: the GPU's per-birth PCG keys instead of one mulberry32
 * sequence) and free-slot order (`ascending`: lowest inactive index first, as the GPU prefix scan) can be
 * matched to the GPU prototype's. `onDraw`, if given, sees every draw with the index it belongs to.
 */
export function cpuControl(capacity: number, seed: number, pcg: boolean, ascending: boolean,
  onDraw?: (index: number, generation: number, value: number) => void) {
  let storage: Storage, lastIndex = -1, state = 0;
  const counters = new Uint32Array(capacity);
  const random = pcg ? () => {
    // spawn() pops the index immediately before its first random draw.
    const index = storage.free[storage.freeTop];
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
  const streams = new StreamSet(1);
  return { particles, streams, storage, spawn(dt: number) {
    lastIndex = -1;
    if (ascending) {
      // Pop the lowest inactive index, as the GPU prefix scan does.
      let n = 0;
      for (let i = capacity - 1; i >= 0; i--) if (!storage.active[i]) storage.free[n++] = i;
      if (n !== storage.freeTop) throw new Error("CPU free-list accounting changed");
    }
    particles.spawn(dt, streams);
  } };
}
