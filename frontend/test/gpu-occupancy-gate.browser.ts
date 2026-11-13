import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { runGate } from "./fixtures/occupancy-gate";
import { runCpuOccupancy, type OccupancyRun } from "./fixtures/occupancy-runs";
import { OCCUPANCY, occupancyFrames, phaseAt, WindowMeans, type OccupancyScenario } from "./fixtures/occupancy-scenario";

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
        const o = i * 16, active = words[o + 14], slot = words[o + 12];
        // A bad marker or slot would drop out of the per-stream series yet still count in the total.
        if (active > 1 || (active && slot >= 32)) throw new Error(`Invalid particle ${i} in ${scenario} seed ${seed} at step ${step}`);
        if (active) { counts[slot]++; live++; }
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
 * Runs the approved occupancy gate in this browser session: every CPU group of both scenarios, then
 * calibration, then the GPU groups only if calibration passed. Returns each run's window means for
 * `summarize-gpu-occupancy-gate.ts`, which gives the verdict. Readback-heavy and untimed: run it apart
 * from benchmarks and coverage. `runsPerGroup` below 20 is a smoke run: calibration is not enforced
 * and the processor rejects it.
 */
export async function runGpuOccupancyGate(options: { runsPerGroup?: number; onProgress?: (done: number, total: number, label: string) => void } = {}) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("The occupancy gate requires WebGL2");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const startedAt = new Date().toISOString(), start = performance.now();
  const metadata = { userAgent: navigator.userAgent, renderer: gl.getParameter(gl.RENDERER) as string,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null,
    ...OCCUPANCY, runsPerGroup: options.runsPerGroup ?? 20, startedAt };
  try {
    const result = await runGate(runCpuOccupancy, (scenario, seed) => runGpuOccupancy(gl, scenario, seed),
      { ...options, yieldEach: yieldToBrowser });
    return { metadata: { ...metadata, finishedAt: new Date().toISOString(), seconds: (performance.now() - start) / 1000 }, ...result };
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
