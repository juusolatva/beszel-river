import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { runCpuOccupancy, type OccupancyRun } from "./fixtures/occupancy-runs";
import { OCCUPANCY, OCCUPANCY_SCENARIOS, occupancyFrames, phaseAt, WindowMeans, type OccupancyScenario } from "./fixtures/occupancy-scenario";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Seeds fixed by the approved gate (docs/superpowers/plans/2026-11-13-gpu-prototype.md). */
export const GATE_SEEDS: Readonly<Record<OccupancyRun["group"], readonly number[]>> = {
  cpu: range(1, 20), calibration: range(21, 40), pcg: range(1001, 1020), gpu: range(1001, 1020),
};

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The GPU prototype through the occupancy fixture, with `seed` for its PCG keys and the flow field. */
async function runGpuOccupancy(gl: WebGL2RenderingContext, scenario: OccupancyScenario, seed: number): Promise<Omit<OccupancyRun, "group">> {
  const { capacity, steps, dt, aspect } = OCCUPANCY;
  const gpu = new GpuParticles(gl, capacity, seed);
  gpu.spawningEnabled = true;
  const streams = new StreamSet(1, gpu.lifecycle.canRelease);
  const field = new FlowField(mulberry32(seed));
  const frames = occupancyFrames(scenario);
  const windows = new WindowMeans();
  const readback = new ArrayBuffer(capacity * 64), bytes = new Uint8Array(readback), words = new Uint32Array(readback);
  const counts = new Uint32Array(32);
  let time = 0, phase = -1;
  try {
    for (let step = 0; step < steps; step++) {
      time += dt;
      if (phaseAt(time) !== phase) { phase = phaseAt(time); streams.apply(frames[phase]); }
      // The order the GPU lifecycle requires: release clock first, then streams, field and step.
      gpu.lifecycle.advanceTime(dt);
      streams.update(dt, aspect);
      field.update(time, aspect);
      gpu.step(dt, streams, field, aspect);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer);
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, bytes);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      if (gl.getError() !== gl.NO_ERROR) throw new Error(`WebGL error in ${scenario} seed ${seed} at step ${step}`);
      counts.fill(0);
      let live = 0;
      for (let i = 0; i < capacity; i++) {
        const o = i * 16;
        if (words[o + 14]) { counts[words[o + 12]]++; live++; }
      }
      windows.add(time, dt, live, (s) => counts[s]);
      if (step % 20 === 0) await yieldToBrowser();
    }
  } finally {
    gpu.dispose();
  }
  return { scenario, seed, starts: windows.starts, means: windows.means };
}

/**
 * Runs every group of the approved occupancy gate in this browser session and returns each run's window
 * means for `summarize_gpu_occupancy_gate.py`, which applies the statistic. Readback-heavy and untimed:
 * run it apart from benchmarks and coverage. `runsPerGroup` below 20 is a smoke run the processor rejects.
 */
export async function runGpuOccupancyGate(options: { runsPerGroup?: number; onProgress?: (done: number, total: number, label: string) => void } = {}) {
  const runsPerGroup = options.runsPerGroup ?? 20;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("The occupancy gate requires WebGL2");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const startedAt = new Date().toISOString(), start = performance.now();
  const metadata = { userAgent: navigator.userAgent, renderer: gl.getParameter(gl.RENDERER) as string,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null,
    ...OCCUPANCY, runsPerGroup, startedAt };
  const groups = Object.keys(GATE_SEEDS) as OccupancyRun["group"][];
  const total = OCCUPANCY_SCENARIOS.length * groups.length * runsPerGroup;
  const runs: OccupancyRun[] = [];
  try {
    for (const scenario of OCCUPANCY_SCENARIOS) {
      for (const group of groups) {
        for (const seed of GATE_SEEDS[group].slice(0, runsPerGroup)) {
          const run = group === "gpu" ? await runGpuOccupancy(gl, scenario, seed) : runCpuOccupancy(scenario, seed, group === "pcg");
          runs.push({ ...run, group });
          options.onProgress?.(runs.length, total, `${scenario} ${group} seed ${seed}`);
          await yieldToBrowser();
        }
      }
    }
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return { metadata: { ...metadata, finishedAt: new Date().toISOString(), seconds: (performance.now() - start) / 1000 }, runs };
}
