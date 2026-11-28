import { GPU_COUNT_EVERY, GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { replayFrames } from "./fixtures/gpu-replay";

function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

/** Ends the current task: WebGL updates a fence's status only between tasks, as between animation frames. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * `GpuParticles.liveCount` against exact counts in real shaders: a full pool, a lowered limit, an empty
 * river and the full pool again, one task per step as on the page. Every count that arrives must equal
 * the exact live count before the step that asked for it, and it must be 0 while the horizon is empty.
 * A second pass checks how soon readbacks arrive.
 */
export async function runGpuLiveCountBrowserChecks(): Promise<{ steps: number; arrivals: number; maxLag: number; delivery: { arrivals: number; medianLag: number; maxLag: number } }> {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  assert(!!gl, "WebGL2 required");
  const capacity = 1000;
  const gpu = new GpuParticles(gl, capacity, 42);
  const streams = new StreamSet(1, gpu.lifecycle.canRelease);
  streams.apply(replayFrames[1]); streams.update(0, 1.5);
  for (const s of streams.slots) { s.half = 0.01; s.center = 0.75; s.rebuildCenters(); }
  const field = new FlowField(() => 0.5); field.update(0, 1.5);
  gpu.spawningEnabled = true;
  gpu.countingLive = true;
  // The step that sent the readback in flight, and whether a result was read this step: one at a time.
  let requestedAt = -1, received = false;
  const readPixels = gl.readPixels.bind(gl) as (...args: unknown[]) => void;
  const getBufferSubData = gl.getBufferSubData.bind(gl) as (...args: unknown[]) => void;
  (gl as unknown as Record<string, unknown>).readPixels = (...args: unknown[]) => { requestedAt = steps; readPixels(...args); };
  (gl as unknown as Record<string, unknown>).getBufferSubData = (...args: unknown[]) => { if (args[0] === gl.PIXEL_PACK_BUFFER) received = true; getBufferSubData(...args); };
  const words = new Uint32Array(capacity * 16);
  // Exact live count after each step; a readback describes the state before the step that asked for it.
  // The pool starts empty: the first readback may describe the state before the first step.
  const history: number[] = [0];
  let arrivals = 0, maxLag = 0, steps = 0;
  try {
    for (const [limit, seconds] of [[1000, 3], [300, 20], [0, 17], [1000, 2]]) {
      gpu.limit = limit;
      for (let t = 0; t < seconds; t += 0.1) {
        await nextTask();
        received = false;
        const request = requestedAt;
        gpu.step(0.1, streams, field, 1.5);
        steps++;
        if (received) {
          // Exactly the state before the step that asked: history[k] is the count after k steps.
          assert(gpu.liveCount === history[request], `Live count ${gpu.liveCount} for step ${request + 1}, exact ${history[request]}`);
          // Short here because the full-state read below waits for the GPU; `deliveryPass` checks timing.
          maxLag = Math.max(maxLag, steps - request);
          arrivals++;
        } else if (gpu.activeSlots === 0) {
          assert(gpu.liveCount === 0, `Live count ${gpu.liveCount} with an empty horizon`);
        }
        // The exact count, read without disturbing the fence: this readback waits for the GPU anyway.
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, words); gl.bindBuffer(gl.ARRAY_BUFFER, null);
        let live = 0;
        for (let i = 0; i < capacity; i++) if (words[i * 16 + 14] !== 0) live++;
        history.push(live);
      }
      if (limit === 0) assert(gpu.liveCount === 0, `Live count ${gpu.liveCount} after emptying`);
    }
    // About one readback per GPU_COUNT_EVERY steps plus its latency.
    assert(arrivals >= steps / (GPU_COUNT_EVERY + 4) / 2, `Only ${arrivals} live counts arrived in ${steps} steps`);
    assert(gl.getError() === gl.NO_ERROR, "Live count WebGL error");
  } finally {
    gpu.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return { steps, arrivals, maxLag, delivery: await deliveryPass() };
}

/** Most frames a readback may take to arrive with nothing else waiting for the GPU (measured 3–6). */
const MAX_DELIVERY_STEPS = 8;

/**
 * Delivery without the value pass's full-state reads, which wait for the GPU and so make every
 * readback ready by the next step. One step per animation frame, as on the page; values unchecked.
 */
async function deliveryPass(): Promise<{ arrivals: number; medianLag: number; maxLag: number }> {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  const gpu = new GpuParticles(gl, 1000, 42);
  const streams = new StreamSet(1, gpu.lifecycle.canRelease);
  streams.apply(replayFrames[1]); streams.update(0, 1.5);
  const field = new FlowField(() => 0.5); field.update(0, 1.5);
  gpu.spawningEnabled = true;
  gpu.countingLive = true;
  let steps = 0, requestedAt = -1, received = false;
  const readPixels = gl.readPixels.bind(gl) as (...args: unknown[]) => void;
  const getBufferSubData = gl.getBufferSubData.bind(gl) as (...args: unknown[]) => void;
  (gl as unknown as Record<string, unknown>).readPixels = (...args: unknown[]) => { requestedAt = steps; readPixels(...args); };
  (gl as unknown as Record<string, unknown>).getBufferSubData = (...args: unknown[]) => { received = true; getBufferSubData(...args); };
  const lags: number[] = [];
  try {
    while (steps < 300) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      received = false;
      const request = requestedAt;
      gpu.step(1 / 60, streams, field, 1.5);
      steps++;
      if (received) lags.push(steps - request);
    }
    assert(gl.getError() === gl.NO_ERROR, "Delivery WebGL error");
  } finally {
    gpu.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  lags.sort((a, b) => a - b);
  const maxLag = lags.at(-1) ?? Infinity;
  assert(lags.length >= 300 / (GPU_COUNT_EVERY + MAX_DELIVERY_STEPS), `Only ${lags.length} readbacks arrived in 300 frames`);
  assert(maxLag <= MAX_DELIVERY_STEPS, `A readback took ${maxLag} frames to arrive`);
  return { arrivals: lags.length, medianLag: lags[Math.floor(lags.length / 2)], maxLag };
}
