import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";
import { MAX_STREAMS } from "../src/sim/streams";
import { CpuReplay, GpuReplay, readGpuState, REPLAY_CAPACITY, ReplayTrace, replayIds, validateCpuTrace,
  validateGpuTrace } from "./fixtures/gpu-replay";

function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

/** Simulation time after each callback's step. */
function endTimes(trace: ReplayTrace): Float64Array {
  const times = new Float64Array(trace.length);
  let time = 0;
  for (let i = 0; i < trace.length; i++) times[i] = time += trace.dt[i];
  return times;
}

/** Simulation-time-weighted mean of post-step counts over steps ending in (from, to]. */
function windowMean(trace: ReplayTrace, counts: Uint32Array, from: number, to: number): number {
  const times = endTimes(trace);
  let sum = 0, weight = 0;
  for (let i = 0; i < trace.length; i++) {
    if (times[i] > from && times[i] <= to) {
      sum += counts[i] * trace.dt[i];
      weight += trace.dt[i];
    }
  }
  return weight ? sum / weight : 0;
}

interface Segment { until: number; interval: number; frame: number; offline?: boolean; width?: number; height?: number; pixelRatio?: number }

/**
 * A trace in simulation time, built like the harness's: each callback's interval is clamped to
 * Float32(min(interval, maxDt)) by `ReplayTrace.append`. A segment with `until: 0` is one callback.
 */
function buildTrace(motion: number, segments: Segment[]): ReplayTrace {
  let length = 1, time = 0;
  for (const s of segments) {
    if (s.until === 0) { length++; time += Math.fround(Math.min(s.interval, LOOK.maxDt)); continue; }
    for (; time < s.until - 1e-9; length++) time += Math.fround(Math.min(s.interval, LOOK.maxDt));
  }
  const trace = new ReplayTrace(length);
  const first = segments[0];
  trace.append(0, first.frame, first.width ?? 1152, first.height ?? 768, first.pixelRatio ?? 1.2, motion, false, REPLAY_CAPACITY, 1, true);
  time = 0;
  for (const s of segments) {
    const append = () => {
      trace.append(s.interval, s.frame, s.width ?? 1152, s.height ?? 768, s.pixelRatio ?? 1.2, motion, s.offline ?? false, REPLAY_CAPACITY, 1, true);
      time += trace.dt[trace.length - 1];
    };
    if (s.until === 0) append();
    else while (time < s.until - 1e-9) append();
  }
  return trace;
}

/** Both validation replays of a trace: exact per-callback counts and slot identities. */
function replayBoth(gl: WebGL2RenderingContext, trace: ReplayTrace) {
  const cpu = validateCpuTrace(trace);
  const gpu = validateGpuTrace(gl, trace);
  assert(gl.getError() === gl.NO_ERROR, "WebGL error during a lifecycle replay");
  return { cpu, gpu };
}

/**
 * Stream loss and recovery: the page sets `offline` after 20 s without a connection, and every
 * stream dries up (vitality → 0, a fifth of the spawn rate) until the connection returns. Uses the
 * single plain stream: a pulsing one spawns three times as fast and keeps the pool nearly full.
 */
function outage(gl: WebGL2RenderingContext, motion: number) {
  const trace = buildTrace(motion, [
    { until: 15, interval: 1 / 30, frame: 0 },
    { until: 30, interval: 1 / 30, frame: 0, offline: true },
    { until: 55, interval: 1 / 30, frame: 0 },
  ]);
  const { cpu, gpu } = replayBoth(gl, trace);
  const phases = (counts: Uint32Array) => ({ before: windowMean(trace, counts, 10, 15), offline: windowMean(trace, counts, 25, 30), recovered: windowMean(trace, counts, 50, 55) });
  const result = { cpu: phases(cpu.counts), gpu: phases(gpu.counts) };
  for (const [backend, p] of Object.entries(result)) {
    assert(p.offline < 0.75 * p.before, `${backend} river did not dry up offline (motion ${motion})`);
    assert(p.recovered > 0.9 * p.before, `${backend} river did not recover (motion ${motion})`);
  }
  return result;
}

/**
 * A hidden tab right after a full replacement: all 32 streams are replaced in the callback that
 * follows a 20 s pause, clamped to one 0.1 s step as on the page. The replacements wait in the
 * pending frame; the GPU may claim a slot only once its drain deadline has passed in simulation
 * time, so the pause must not shorten the wait.
 */
function hiddenTab(gl: WebGL2RenderingContext, motion: number) {
  const trace = buildTrace(motion, [
    { until: 15, interval: 1 / 30, frame: 2 },
    { until: 0, interval: 20, frame: 3 },
    { until: 50, interval: 1 / 30, frame: 3 },
  ]);
  const { cpu, gpu } = replayBoth(gl, trace);
  const times = endTimes(trace);
  let gap = 0;
  while (trace.interval[gap] !== 20) gap++;
  const removal = times[gap - 1];
  const replacement = new Set(replayIds.flatMap((id, k) => (id.startsWith("replay-replacement-") ? [k] : [])));
  const claims = (identities: Uint16Array) => {
    let first = -1, all = -1;
    for (let i = 0; i < trace.length; i++) {
      let claimed = 0;
      for (let slot = 0; slot < MAX_STREAMS; slot++) if (replacement.has(identities[i * MAX_STREAMS + slot])) claimed++;
      if (claimed && first < 0) first = i;
      if (claimed === MAX_STREAMS) { all = i; break; }
    }
    let wall = 0;
    for (let i = gap; i <= first; i++) wall += trace.interval[i];
    return { firstClaimSimulationDelay: first < 0 ? null : times[first] - removal, firstClaimWallDelay: first < 0 ? null : wall,
      allClaimedSimulationDelay: all < 0 ? null : times[all] - removal };
  };
  const result = { removalTime: removal, cpu: claims(cpu.perSlotIdentity), gpu: claims(gpu.perSlotIdentity) };
  const deadline = LOOK.lifeRange[1] + Math.fround(LOOK.maxDt);
  assert(result.gpu.firstClaimSimulationDelay !== null && result.gpu.firstClaimSimulationDelay > deadline,
    `GPU claimed a replacement ${result.gpu.firstClaimSimulationDelay} s after removal, within the ${deadline} s drain deadline (motion ${motion})`);
  assert(result.cpu.allClaimedSimulationDelay !== null && result.gpu.allClaimedSimulationDelay !== null, `Replacements never all claimed (motion ${motion})`);
  // validateGpuTrace has already failed on any live particle whose generation differs from its slot's.
  return result;
}

/** Zero-dt callbacks (the first callback, or two in one display period) leave both backends' state untouched. */
function zeroSteps(gl: WebGL2RenderingContext, motion: number) {
  const trace = buildTrace(motion, [{ until: 3, interval: 1 / 30, frame: 1 }]);
  const zeros = new ReplayTrace(trace.length + 5);
  for (let i = 0; i < trace.length; i++) zeros.append(trace.interval[i], 1, 1152, 768, 1.2, motion, false, REPLAY_CAPACITY, 1, true);
  for (let k = 0; k < 5; k++) zeros.append(0, 1, 1152, 768, 1.2, motion, false, REPLAY_CAPACITY, 1, true);
  const gpu = new GpuReplay(gl, motion), cpu = new CpuReplay(motion);
  const before = new ArrayBuffer(REPLAY_CAPACITY * 64), after = new ArrayBuffer(REPLAY_CAPACITY * 64);
  try {
    for (let i = 0; i < trace.length; i++) { gpu.step(zeros, i); cpu.step(zeros, i); }
    readGpuState(gl, gpu.particles, before);
    const instances = cpu.particles.instances.slice(), count = cpu.particles.count;
    for (let i = trace.length; i < zeros.length; i++) { gpu.step(zeros, i); assert(cpu.step(zeros, i) === count, "CPU count changed at zero dt"); }
    readGpuState(gl, gpu.particles, after);
    const a = new Uint8Array(before), b = new Uint8Array(after);
    assert(a.every((byte, k) => byte === b[k]), "GPU state changed at zero dt");
    assert(cpu.particles.instances.every((value, k) => Object.is(value, instances[k])), "CPU instances changed at zero dt");
    assert(gl.getError() === gl.NO_ERROR, "WebGL error during zero-dt steps");
    return { liveBefore: count, zeroCallbacks: 5 };
  } finally {
    gpu.dispose();
  }
}

const SIZES = [
  { name: "landscape", width: 1152, height: 768, pixelRatio: 1.2 },
  { name: "portrait", width: 432, height: 768, pixelRatio: 1.2 },
  { name: "portrait DPR 2", width: 864, height: 1536, pixelRatio: 2 },
  { name: "landscape DPR 2", width: 1920, height: 1280, pixelRatio: 2 },
];

/**
 * Landscape/portrait resizes and DPR changes: both replays follow the aspect change and the flow
 * grid it resizes. Each size must keep a populated river, with the backends' means over its last
 * 3 s within `max(5 particles, 5%)` of each other.
 */
function resize(gl: WebGL2RenderingContext, motion: number) {
  const trace = buildTrace(motion, SIZES.map((size, k) => ({ until: 5 * (k + 1), interval: 1 / 60, frame: 1, ...size })));
  const { cpu, gpu } = replayBoth(gl, trace);
  return SIZES.map((size, k) => {
    const result = { size: size.name, cpu: windowMean(trace, cpu.counts, 5 * k + 2, 5 * k + 5), gpu: windowMean(trace, gpu.counts, 5 * k + 2, 5 * k + 5) };
    assert(result.cpu > 1000 && result.gpu > 1000, `River emptied after resizing to ${size.name} (motion ${motion})`);
    assert(Math.abs(result.cpu - result.gpu) <= Math.max(5, 0.05 * result.cpu), `CPU and GPU diverged after resizing to ${size.name} (motion ${motion})`);
    return result;
  });
}

/**
 * Draws GPU state through the shared renderer at each size: the trail targets are recreated on
 * resize, and the present pass must still show the river.
 */
function drawAcrossResizes(gl: WebGL2RenderingContext) {
  const canvas = gl.canvas as HTMLCanvasElement;
  const trace = buildTrace(1, SIZES.map((size, k) => ({ until: 2 * (k + 1), interval: 1 / 30, frame: 1, ...size })));
  const renderer = new Renderer(gl, REPLAY_CAPACITY);
  const gpu = new GpuReplay(gl, 1);
  const lit: { size: string; format: string; litPixels: number }[] = [];
  const pixels = new Uint8Array(64 * 64 * 4);
  try {
    gpu.drawer.prepare();
    const times = endTimes(trace);
    for (let i = 0; i < trace.length; i++) {
      const width = trace.width[i], height = trace.height[i];
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        renderer.resize(width, height);
      }
      gpu.step(trace, i);
      if (trace.dt[i] > 0) renderer.renderGpu(gpu.drawer, trace.dt[i], width / height, trace.pixelRatio[i], gpu.particles.globalHue, gpu.intensity);
      const last = i === trace.length - 1 || trace.width[i + 1] !== width || trace.height[i + 1] !== height;
      if (last) {
        // The bottom centre, where the bands rise; read in the same task as the present pass.
        gl.readPixels(Math.floor(width / 2) - 32, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let count = 0;
        for (let p = 0; p < pixels.length; p += 4) if (pixels[p] + pixels[p + 1] + pixels[p + 2] > 0) count++;
        const size = SIZES.find((s) => s.width === width && s.height === height)!;
        lit.push({ size: size.name, format: renderer.halfFloat ? "RGBA16F" : "RGBA8", litPixels: count });
        assert(count > 0, `Nothing drawn after resizing to ${size.name} (t = ${times[i].toFixed(2)} s)`);
      }
    }
    assert(gl.getError() === gl.NO_ERROR, "WebGL error while drawing across resizes");
    return lit;
  } finally {
    gpu.dispose();
  }
}

/**
 * Real-shader lifecycle checks for the GPU benchmark's replays (GPU plan, Task 5): stream loss and
 * recovery, a hidden tab during a full replacement, zero-dt callbacks and resizes, each at normal
 * and reduced motion (0.5, the page's `prefers-reduced-motion` value), with the page's time clamping.
 * Untimed readback evidence, never a performance result.
 */
export function runGpuReplayLifecycleChecks() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  assert(!!gl, "WebGL2 required");
  try {
    const results = [1, 0.5].map((motion) => ({
      motion,
      outage: outage(gl!, motion),
      hiddenTab: hiddenTab(gl!, motion),
      zeroSteps: zeroSteps(gl!, motion),
      resize: resize(gl!, motion),
    }));
    return { results, drawing: drawAcrossResizes(gl!) };
  } finally {
    // Frees everything the checks allocated, the renderer's trail targets included, so reruns
    // neither accumulate GPU memory nor exhaust the browser's context limit.
    gl!.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
