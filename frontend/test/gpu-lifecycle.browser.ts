import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../src/config";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { ParticleSystem } from "../src/sim/particles";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { replayFrames } from "./fixtures/gpu-replay";

function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

/** Untimed readback evidence, never used as a runtime count or performance result. */
export async function runGpuLifecycleBrowserChecks() {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  assert(!!gl, "WebGL2 required");
  const windows: { scenario: string; phase: number; start: number; slot: number; cpu: number; gpu: number; control: number; bound: number; pass: boolean }[] = [];
  const transitions: { scenario: string; backend: string; event: string; time: number }[] = [];
  const rotationCurve: { time: number; cpu: number; gpu: number; cpuSlots: number[]; gpuSlots: number[] }[] = [];
  const lastBirth = { cpuOld: 0, gpuOld: 0, cpuNew: 0, gpuNew: 0 };
  let checkedSteps = 0;
  const rng = { minLife: Infinity, maxLife: 0, minSize: Infinity, maxSize: 0, births: 0,
    laneCounts: [0, 0, 0, 0, 0, 0], cpuLaneCounts: [0, 0, 0, 0, 0, 0] };
  for (const scenario of ["occupancy", "filaments", "rotation"]) {
    const capacity = scenario === "rotation" ? 128 : 10000;
    const gpu = new GpuParticles(gl, capacity, 42); gpu.spawningEnabled = true;
    const cpu = new ParticleSystem(capacity, mulberry32(42));
    // A different CPU random sequence isolates stochastic/priority effects from GPU math.
    const control = new ParticleSystem(capacity, mulberry32(43));
    const motion = scenario === "rotation" ? 0.5 : 1;
    const gs = new StreamSet(motion, gpu.lifecycle.canRelease), cs = new StreamSet(motion);
    const controlStreams = new StreamSet(motion);
    const field = new FlowField(mulberry32(42));
    const readback = new ArrayBuffer(capacity * 64), words = new Uint32Array(readback), floats = new Float32Array(readback);
    const previous = new Uint32Array(capacity * 4), previousIds = Array(32).fill("") as string[];
    const sums = new Float64Array(99), counts = new Uint32Array(32);
    const lastEligible = new Float64Array(32), wasUsed = new Uint8Array(32);
    const laneBin = (offset: number) => Math.max(0, Math.min(5, Math.round((offset / LOOK.filamentSpan + 1) * 3 - 0.5)));
    const recorded = new Set<string>();
    let time = 0, windowTime = 0, previousPhase = -1;
    const steps = scenario === "rotation" ? 1450 : 600;
    const channels = replayFrames[2].streams[0];
    const frames: Frame[] = [1, 4, 32, 32, 32, 0].map((n, phase) => ({ v: 1, t: 0,
      streams: Array.from({ length: n }, (_, i) => ({ ...channels, id: `${phase === 3 ? "stale" : phase === 4 ? "new" : "old"}-${i}`,
        width: 0.5, flow: 0, density: 1, turbulence: 0.5, pulse: 0,
        ...(scenario === "filaments" ? { filaments: [0.1, 0.2, 0.9, 0.3, 0.2, 0.1] } : {}) })) }));
    const record = (backend: string, event: string) => {
      const key = `${backend}/${event}`;
      if (!recorded.has(key)) { transitions.push({ scenario, backend, event, time }); recorded.add(key); }
    };
    try {
      for (let step = 0; step < steps; step++) {
        // Include clamped hidden-tab intervals and variable display intervals in the lifecycle run.
        const interval = scenario === "rotation" && step % 5 === 0 ? (step % 50 === 0 ? 20 : 1 / 30) : 0.1;
        const dt = Math.fround(Math.min(interval, LOOK.maxDt));
        time += dt;
        let phase = time < 15 ? 0 : time < 30 ? 1 : 2;
        if (scenario === "rotation") phase = time < 30 ? 2 : time < 33 ? 3 : time < 36 ? 2 : time < 37 ? 3 : time < 68 ? 4 : 5;
        if (phase !== previousPhase) { gs.apply(frames[phase]); cs.apply(frames[phase]); controlStreams.apply(frames[phase]); previousPhase = phase; sums.fill(0); windowTime = 0; }
        gpu.lifecycle.advanceTime(dt);
        gs.update(dt, 1.5); cs.update(dt, 1.5); controlStreams.update(dt, 1.5);
        for (let s = 0; s < 32; s++) {
          if (previousIds[s] && previousIds[s] !== gs.slots[s].id) assert(counts[s] === 0, `Reused live generation ${scenario}/${s}`);
          previousIds[s] = gs.slots[s].used ? gs.slots[s].id : "";
          const slot = gs.slots[s];
          if (wasUsed[s] && !slot.inFrame && time > lastEligible[s] + 14 + Math.fround(LOOK.maxDt)) {
            assert(!slot.used || slot.id.startsWith("new"), `Missed safe claim/release deadline ${s}`);
          }
          wasUsed[s] = slot.used ? 1 : 0;
        }
        field.update(time, 1.5);
        cpu.spawn(dt, cs);
        if (scenario !== "occupancy") {
          const storage = cpu as unknown as { active: Uint8Array; age: Float32Array; offset: Float32Array; slot: Uint8Array };
          for (let i = 0; i < capacity; i++) if (storage.active[i] && storage.age[i] === 0) {
            if (scenario === "filaments") rng.cpuLaneCounts[laneBin(storage.offset[i])]++;
            else if (cs.slots[storage.slot[i]].id.startsWith("old")) lastBirth.cpuOld = time;
            else if (cs.slots[storage.slot[i]].id.startsWith("new")) lastBirth.cpuNew = time;
          }
        }
        cpu.step(dt, cs, field, 1.5, 1);
        control.spawn(dt, controlStreams); control.step(dt, controlStreams, field, 1.5, 1);
        gpu.step(dt, gs, field, 1.5);
        for (let s = 0; s < 32; s++) if (gs.slots[s].used && (gs.slots[s].inFrame || gs.slots[s].presence >= 0.01)) lastEligible[s] = time;
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(readback));
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        counts.fill(0);
        let live = 0;
        for (let i = 0; i < capacity; i++) {
          const o = i * 16, p = i * 4;
          const slot = words[o + 12], generation = words[o + 13], active = words[o + 14], counter = words[o + 15];
          assert(active <= 1 && floats[o + 10] === 0, "Invalid counter/active marker");
          for (let j = 0; j < 12; j++) assert(Number.isFinite(floats[o + j]), "Nonfinite particle/Box-Muller value");
          if (previous[p + 2]) assert(counter === previous[p + 3] && slot === previous[p] && generation === previous[p + 1], "Active ownership reassigned");
          if (active) {
            assert(gs.slots[slot].used && generation === gpu.lifecycle.commands[slot * 4], "Stale stream generation");
            counts[slot]++; live++;
          }
          if (counter !== previous[p + 3]) {
            if (scenario === "rotation") {
              if (gs.slots[slot].id.startsWith("old")) lastBirth.gpuOld = time;
              else if (gs.slots[slot].id.startsWith("new")) lastBirth.gpuNew = time;
            }
            rng.births++; rng.minLife = Math.min(rng.minLife, floats[o + 5]); rng.maxLife = Math.max(rng.maxLife, floats[o + 5]);
            rng.minSize = Math.min(rng.minSize, floats[o + 7]); rng.maxSize = Math.max(rng.maxSize, floats[o + 7]);
            if (scenario === "filaments") {
              // Activity-dependent scatter overlaps lanes; compare its aggregate profile below.
              const lane = laneBin(floats[o + 9]);
              rng.laneCounts[lane]++;
            }
          }
          previous.set(words.subarray(o + 12, o + 16), p);
        }
        assert(live <= capacity && gs.slots.every(s => s.particles === 0), "GPU count contaminated CPU policy");
        assert(gl.getError() === gl.NO_ERROR, "Lifecycle WebGL error");
        if (scenario !== "rotation") {
          const steadyStart = phase === 0 ? 10 : phase === 1 ? 25 : 45;
          if (time + 1e-5 >= steadyStart) {
            sums[0] += cpu.count * dt; sums[1] += live * dt;
            sums[66] += control.count * dt;
            for (let s = 0; s < 32; s++) { sums[2 + s * 2] += cs.slots[s].particles * dt; sums[3 + s * 2] += counts[s] * dt; }
            for (let s = 0; s < 32; s++) sums[67 + s] += controlStreams.slots[s].particles * dt;
            windowTime += dt;
            if (windowTime >= 5 - 1e-6) {
              for (let s = -1; s < 32; s++) {
                const a = sums[s < 0 ? 0 : 2 + s * 2] / windowTime, b = sums[s < 0 ? 1 : 3 + s * 2] / windowTime;
                const bound = Math.max(5, a * 0.05);
                windows.push({ scenario, phase, start: time - windowTime + dt, slot: s, cpu: a, gpu: b, control: sums[s < 0 ? 66 : 67 + s] / windowTime, bound, pass: Math.abs(a - b) <= bound });
              }
              sums.fill(0); windowTime = 0;
            }
          }
        } else {
          rotationCurve.push({ time, cpu: cpu.count, gpu: live, cpuSlots: cs.slots.map(s => s.particles), gpuSlots: [...counts] });
          if (time > 37) {
            if (gs.slots.every(s => s.used && s.id.startsWith("new"))) record("gpu", "pending-claimed");
            if (cs.slots.every(s => s.used && s.id.startsWith("new"))) record("cpu", "pending-claimed");
          }
          if (time >= 68) {
            if (live === 0) record("gpu", "empty");
            if (cpu.count === 0) record("cpu", "empty");
            if (gs.slots.every(s => !s.used)) record("gpu", "released");
            if (cs.slots.every(s => !s.used)) record("cpu", "released");
          }
        }
        checkedSteps++;
        if (step % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (scenario === "rotation") {
        assert(recorded.has("gpu/pending-claimed") && recorded.has("cpu/pending-claimed"), "Pending frame never claimed");
        assert(recorded.has("gpu/released") && recorded.has("cpu/released"), "Empty streams did not release");
      }
    } finally { gpu.dispose(); }
  }
  assert(rng.minLife >= 5 && rng.maxLife <= 14 && rng.minSize >= 0.7 - 1e-7 && rng.maxSize <= 1.6 + 1e-7, "Spawn distributions out of range");
  assert(rng.maxLife - rng.minLife > 8.9, "Lifetime distribution collapsed");
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { checkedSteps, parityPassed: windows.every(w => w.pass), failedWindows: windows.filter(w => !w.pass), windows, transitions, lastBirth, rotationCurve, rng };
}
