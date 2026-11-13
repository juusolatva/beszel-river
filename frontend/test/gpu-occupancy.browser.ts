import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../src/config";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { ParticleSystem } from "../src/sim/particles";
import { MIN_SHARE, StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { replayFrames } from "./fixtures/gpu-replay";

function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

// Test-only access: change the CPU control's free order/random source, never production policy.
interface Storage {
  free: Int32Array; freeTop: number; active: Uint8Array; slot: Uint8Array;
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  age: Float32Array; life: Float32Array; speedJitter: Float32Array;
}

function cpuControl(capacity: number, seed: number, pcg: boolean, ascending: boolean) {
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
    return (((word >>> 22) ^ word) >>> 8) / 16777216;
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
      assert(n === storage.freeTop, "CPU free-list accounting changed");
    }
    particles.spawn(dt, streams);
  } };
}

/** Causal controls for the rejected occupancy candidate; readback-heavy, never a benchmark. */
export async function runGpuOccupancyInvestigation() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("Occupancy investigation requires WebGL2");
  const capacity = 10000, seed = 42, dt = Math.fround(0.1), aspect = 1.5;
  const results = [];
  try {
    for (const filament of [false, true]) {
      const gpu = new GpuParticles(gl, capacity, seed); gpu.spawningEnabled = true;
      const streams = new StreamSet(1, gpu.lifecycle.canRelease);
      const controls = {
        reference: cpuControl(capacity, 42, false, false),
        differentSeed: cpuControl(capacity, 43, false, false),
        ascendingOnly: cpuControl(capacity, 42, false, true),
        pcgOnly: cpuControl(capacity, 42, true, false),
        matched: cpuControl(capacity, 42, true, true),
      };
      const names = Object.keys(controls) as (keyof typeof controls)[];
      const field = new FlowField(mulberry32(seed));
      const frames: Frame[] = [1, 4, 32].map(n => ({ v: 1, t: 0,
        streams: Array.from({ length: n }, (_, i) => ({ ...replayFrames[2].streams[0], id: `old-${i}`,
          width: 0.5, flow: 0, density: 1, turbulence: 0.5, pulse: 0,
          ...(filament ? { filaments: [0.1, 0.2, 0.9, 0.3, 0.2, 0.1] } : {}) })) }));
      const buffer = new ArrayBuffer(capacity * 64), words = new Uint32Array(buffer), floats = new Float32Array(buffer);
      const previous = new Uint32Array(capacity * 4), carry = new Float64Array(32), requests = new Uint32Array(32);
      const counts = new Uint32Array(32), births = new Uint32Array(32);
      const sums = names.map(() => new Float64Array(33)), gpuSums = new Float64Array(33);
      const lateRequested = new Uint32Array(32), lateAccepted = new Uint32Array(32), lateCpuAccepted = new Uint32Array(32);
      const windows = [];
      let time = 0, phase = -1, windowTime = 0, live = 0, totalBirths = 0, saturatedSteps = 0;
      let firstMatchedCountMismatch: number | null = null, matchedCountMismatches = 0, matchedIdentityMismatches = 0;
      let firstIdentityDifference: unknown = null;
      let previousFloats: Float32Array | null = null, beforeMotion: Record<string, Float32Array> | null = null;
      let referenceOrderMismatches = 0, checkedAllocations = 0;
      try {
        for (let step = 0; step < 600; step++) {
          if (!firstIdentityDifference) previousFloats = floats.slice();
          time += dt;
          const nextPhase = time < 15 ? 0 : time < 30 ? 1 : 2;
          if (nextPhase !== phase) {
            phase = nextPhase; streams.apply(frames[phase]);
            for (const c of Object.values(controls)) c.streams.apply(frames[phase]);
            for (const sum of sums) sum.fill(0);
            gpuSums.fill(0); windowTime = 0;
          }
          gpu.lifecycle.advanceTime(dt); streams.update(dt, aspect); field.update(time, aspect);
          const share = streams.slots.reduce((sum, s) => sum + (s.used ? s.shareWeight : 0), 0);
          const rate = share > 0 ? capacity / LOOK.turnoverSeconds / Math.max(share, MIN_SHARE) : 0;
          for (let s = 0; s < 32; s++) {
            carry[s] += streams.slots[s].used ? rate * streams.slots[s].spawnWeight * dt : 0;
            requests[s] = Math.floor(carry[s]); carry[s] -= requests[s];
          }
          for (const c of Object.values(controls)) {
            c.streams.update(dt, aspect);
            const beforeBirths = c.streams.slots.map(s => s.particles);
            c.spawn(dt);
            if (c === controls.reference && time >= 45) {
              for (let s = 0; s < 32; s++) lateCpuAccepted[s] += c.streams.slots[s].particles - beforeBirths[s];
            }
            if (c === controls.matched && !firstIdentityDifference) {
              beforeMotion = Object.fromEntries((["x", "y", "vx", "vy", "age", "life", "speedJitter"] as const)
                .map(key => [key, c.storage[key].slice()]));
            }
            c.particles.step(dt, c.streams, field, aspect, 1);
          }
          const totalRequests = requests.reduce((a, b) => a + b, 0);
          const accepted = Math.min(totalRequests, capacity - live);
          if (totalRequests > capacity - live) saturatedSteps++;
          gpu.step(dt, streams, field, aspect);
          gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer);
          gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(buffer));
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          counts.fill(0); births.fill(0);
          let rank = 0, requestStart = 0, matchedMismatch = false;
          for (let s = 0; s < 32; s++) {
            const o = s * 4, command = gpu.lifecycle.commands;
            assert(command[o + 2] === requestStart && command[o + 3] - command[o + 2] === requests[s], `Request mismatch ${step}/${s}`);
            requestStart += requests[s];
          }
          live = 0;
          for (let i = 0; i < capacity; i++) {
            const o = i * 16, p = i * 4;
            const born = words[o + 15] !== previous[p + 3];
            const expectedBirth = !previous[p + 2] && rank < accepted;
            assert(born === expectedBirth, `Birth rank mismatch ${step}/${i}`);
            if (previous[p + 2]) assert(words[o + 12] === previous[p] && words[o + 13] === previous[p + 1], `Live ownership changed ${step}/${i}`);
            if (born) {
              let owner = 0, end = requests[0];
              while (rank >= end && owner < 31) end += requests[++owner];
              assert(words[o + 12] === owner && words[o + 13] === 1 && words[o + 15] === previous[p + 3] + 1,
                `Birth identity mismatch ${step}/${i}`);
              births[owner]++; totalBirths++;
            }
            if (!previous[p + 2]) rank++;
            if (words[o + 14]) { counts[words[o + 12]]++; live++; }
            const matched = controls.matched.storage;
            if (words[o + 14] !== matched.active[i] || (words[o + 14] && words[o + 12] !== matched.slot[i])) {
              matchedIdentityMismatches++;
              firstIdentityDifference ??= { time, index: i, born, previousGpu: [...previousFloats!.subarray(o, o + 12)],
                beforeCpu: Object.fromEntries(Object.entries(beforeMotion!).map(([key, values]) => [key, values[i]])),
                afterGpu: [...floats.subarray(o, o + 12)], gpuActive: words[o + 14], cpuActive: matched.active[i] };
            }
            previous.set(words.subarray(o + 12, o + 16), p);
            checkedAllocations++;
          }
          assert(births.reduce((a, b) => a + b, 0) === accepted, "Total accepted births differ");
          assert(gl.getError() === gl.NO_ERROR, "Occupancy WebGL error");
          for (let s = 0; s < 32; s++) {
            if (counts[s] !== controls.matched.streams.slots[s].particles) matchedMismatch = true;
            if (controls.reference.streams.slots[s].particles !== controls.ascendingOnly.streams.slots[s].particles) referenceOrderMismatches++;
            if (time >= 45) { lateRequested[s] += requests[s]; lateAccepted[s] += births[s]; }
          }
          if (matchedMismatch) { matchedCountMismatches++; firstMatchedCountMismatch ??= time; }
          if (time + 1e-5 >= (phase === 0 ? 10 : phase === 1 ? 25 : 45)) {
            gpuSums[0] += live * dt;
            for (let s = 0; s < 32; s++) gpuSums[s + 1] += counts[s] * dt;
            for (let n = 0; n < names.length; n++) {
              const c = controls[names[n]]; sums[n][0] += c.particles.count * dt;
              for (let s = 0; s < 32; s++) sums[n][s + 1] += c.streams.slots[s].particles * dt;
            }
            windowTime += dt;
            if (windowTime >= 5 - 1e-6) {
              for (let s = -1; s < 32; s++) {
                const means = Object.fromEntries(names.map((name, n) => [name, sums[n][s + 1] / windowTime]));
                windows.push({ start: time - windowTime + dt, slot: s, gpu: gpuSums[s + 1] / windowTime, ...means });
              }
              for (const sum of sums) sum.fill(0);
              gpuSums.fill(0); windowTime = 0;
            }
          }
          if (step % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        results.push({ scenario: filament ? "filaments" : "occupancy", checkedAllocations, totalBirths, saturatedSteps,
          matchedCountMismatches, firstMatchedCountMismatch, matchedIdentityMismatches,
          referenceOrderMismatches, firstIdentityDifference, lateRequested: [...lateRequested], lateAccepted: [...lateAccepted],
          lateCpuAccepted: [...lateCpuAccepted], windows });
      } finally { gpu.dispose(); }
    }
    return { metadata: { userAgent: navigator.userAgent, capacity, seed, dt, aspect, stepsPerScenario: 600,
      renderer: gl.getParameter(gl.RENDERER), purpose: "Untimed causal investigation; original acceptance gate unchanged" }, results };
  } finally { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}
