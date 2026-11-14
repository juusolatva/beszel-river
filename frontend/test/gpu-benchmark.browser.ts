import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";
import { createSubmissionCounter } from "./fixtures/gpu-gl";
import { compareGpuStates, CpuReplay, CPU_REFERENCE, fiveSecondWindows, GpuReplay, readGpuState, REPLAY_CAPACITY,
  REPLAY_SEED, ReplayTrace, replayableStep, replayFrameIndex, validateCpuTrace, validateGpuTrace,
  type ReplayScenario } from "./fixtures/gpu-replay";

interface BenchmarkOptions {
  backend?: "cpu" | "gpu";
  scenario?: ReplayScenario;
  limit?: 10000 | 8000 | 1000;
  warmupSeconds?: number;
  measureSeconds?: number;
  traceCapacity?: number;
  motion?: number;
  refreshHz: number;
  conditions: string;
  /** Also replay the trace through the other backend, untimed (default true). */
  crossValidate?: boolean;
}

const usedCanvases = new WeakSet<HTMLCanvasElement>();

function distribution(values: Float64Array, length: number) {
  if (!length) throw new Error("No measured callbacks");
  const sorted = values.slice(0, length).sort();
  return { median: sorted[Math.floor(length * 0.5)], p95: sorted[Math.floor(length * 0.95)], p99: sorted[Math.floor(length * 0.99)] };
}

/** Run the untimed GPU validation replay, or say why the GPU could not provide one. */
function gpuValidation(gl: WebGL2RenderingContext, trace: ReplayTrace) {
  try {
    return validateGpuTrace(gl, trace);
  } catch (error) {
    return { unavailable: String(error) };
  }
}

/**
 * Separate local harness, never imported by the public page. `backend` is fixed for the whole run:
 * a GPU failure fails the run rather than switching to the CPU, and a CPU restart is a new run.
 */
export async function runGpuBenchmark(options: BenchmarkOptions) {
  const { backend = "cpu", scenario = "dense", limit = 10000, warmupSeconds = scenario === "drained" ? 60 : 30,
    measureSeconds = 60, traceCapacity = 120000, motion = 1, refreshHz, conditions, crossValidate = true } = options;
  if (backend !== "cpu" && backend !== "gpu") throw new Error("Backend must be cpu or gpu");
  // The drawer compiles on its first draw, which must fall in warmup.
  if (backend === "gpu" && !(warmupSeconds >= 1)) throw new Error("GPU runs need at least 1 s of warmup");
  if (!(refreshHz > 0) || !Number.isFinite(refreshHz) || !conditions.trim()) throw new Error("Record refresh rate and power/thermal/load conditions");
  if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0 || !Number.isFinite(measureSeconds) || measureSeconds <= 0) throw new Error("Invalid measurement duration");
  if (!Number.isInteger(traceCapacity) || traceCapacity <= 0) throw new Error("Trace capacity must be a positive integer");
  if (![10000, 8000, 1000].includes(limit) || !(motion >= 0 && motion <= 1)) throw new Error("Invalid replay limit or motion");
  const canvas = document.querySelector<HTMLCanvasElement>("#river");
  if (canvas && usedCanvases.has(canvas)) throw new Error("Reload the benchmark page before each run to reset GL resources");
  const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!canvas || !gl) throw new Error("WebGL2 unavailable");
  if (document.hidden) throw new Error("Benchmark must start in a visible tab");

  usedCanvases.add(canvas);
  const runId = crypto.randomUUID();

  // Instrument submission rather than GPU execution; method wrappers are cached on first use.
  const { gl: countedGl, counters } = createSubmissionCounter(gl);
  const renderer = new Renderer(countedGl, REPLAY_CAPACITY);
  const cpu = backend === "cpu" ? new CpuReplay(motion) : null;
  let gpu: GpuReplay | null = null;
  if (backend === "gpu") {
    try {
      gpu = new GpuReplay(countedGl, motion);
    } catch (error) {
      // Unsupported limits, failed allocation or a shader that does not compile: no fallback.
      throw new Error(`GPU backend failed: ${String(error)}: run invalid`);
    }
  }
  const trace = new ReplayTrace(traceCapacity);
  const work = new Float64Array(traceCapacity);
  const simulation = new Float64Array(traceCapacity);
  const submission = new Float64Array(traceCapacity);
  const intervals = new Float64Array(traceCapacity);
  let measured = 0, missedPeriods = 0, totalUploads = 0, totalTextureUploads = 0, totalDraws = 0, totalDrawCapacity = 0;
  let last: number | undefined, start: number | undefined;
  let width = 0, height = 0, raf = 0;
  let targetFormat = "unknown";
  let stopped = false;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      stopped = true;
    };
    const fail = (message: string) => { cleanup(); reject(new Error(message)); };
    const visibility = () => { if (document.hidden) fail("Hidden tab: run invalid"); };
    const lost = () => fail("WebGL context lost: run invalid");
    document.addEventListener("visibilitychange", visibility);
    canvas.addEventListener("webglcontextlost", lost);
    const frame = (now: number) => {
      if (stopped) return;
      const begin = performance.now();
      try {
        start ??= now;
        const seconds = (now - start) / 1000;
        if (seconds >= warmupSeconds + measureSeconds) { cleanup(); resolve(); return; }
        const interval = last === undefined ? 0 : (now - last) / 1000;
        last = now;
        const pixelRatio = Math.min(devicePixelRatio || 1, LOOK.devicePixelRatioCap);
        const nextWidth = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
        const nextHeight = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
        // Layout reads and resize work belong to callback work.
        if (nextWidth !== width || nextHeight !== height) {
          width = canvas.width = nextWidth;
          height = canvas.height = nextHeight;
          renderer.resize(width, height);
          if (!counters.lastFramebuffer) throw new Error("No render framebuffer: run invalid");
          gl.bindFramebuffer(gl.FRAMEBUFFER, counters.lastFramebuffer);
          targetFormat = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) === gl.FLOAT ? "RGBA16F" : "RGBA8";
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        const isMeasured = seconds >= warmupSeconds;
        trace.append(interval, replayFrameIndex(scenario, seconds), width, height, pixelRatio, motion, false, limit, 1, isMeasured);
        const i = trace.length - 1, dt = trace.dt[i];
        // Both backends must be able to replay every trace; the GPU rejects tiny positive steps.
        if (!replayableStep(dt)) {
          trace.valid = false;
          throw new Error("Callback interval below 1/256 s: run invalid (GPU step contract)");
        }
        counters.uploadedBytes = counters.textureUploadBytes = counters.drawCalls = counters.particleDrawCapacity = 0;
        const simBegin = performance.now();
        let count = 0;
        if (cpu) {
          count = cpu.step(trace, i);
          if (scenario === "drained" && isMeasured && count !== 0) throw new Error("Drained measurement still has live particles: run invalid");
        } else gpu!.step(trace, i);
        const simEnd = performance.now();
        if (dt > 0) {
          if (cpu) renderer.render(cpu.particles.instances, count, dt, width / height);
          else renderer.renderGpu(gpu!.drawer, dt, width / height, pixelRatio, gpu!.particles.globalHue, gpu!.intensity);
        }
        const end = performance.now();
        if (isMeasured) {
          simulation[measured] = simEnd - simBegin;
          submission[measured] = end - simEnd;
          intervals[measured++] = interval * 1000;
          missedPeriods += Math.max(0, Math.round(interval * refreshHz) - 1);
          totalUploads += counters.uploadedBytes;
          totalTextureUploads += counters.textureUploadBytes;
          totalDraws += counters.drawCalls;
          totalDrawCapacity += counters.particleDrawCapacity;
        }
        raf = requestAnimationFrame(frame);
        if (isMeasured) work[measured - 1] = performance.now() - begin;
      } catch (error) { cleanup(); reject(error); }
    };
    raf = requestAnimationFrame(frame);
  });

  // No performance warmup overlaps validation, and no readback happened while timing. The timed
  // run's final state is checked against an untimed replay of its own backend; the other backend
  // replays the same trace for cross-backend occupancy.
  let timedGpuState: ArrayBuffer | null = null;
  if (gpu) {
    timedGpuState = new ArrayBuffer(REPLAY_CAPACITY * 64);
    readGpuState(gl, gpu.particles, timedGpuState);
    gpu.dispose();
  }
  const cpuCheck = validateCpuTrace(trace);
  const gpuCheck = gpu || crossValidate ? gpuValidation(gl, trace) : null;
  if (gl.isContextLost()) throw new Error("WebGL context lost during validation: run invalid");
  let finalState: { matches: boolean; maxFloatDifference?: number };
  if (cpu) {
    finalState = { matches: cpu.particles.count === cpuCheck.cpu.particles.count
      && cpu.particles.instances.every((value, k) => Object.is(value, cpuCheck.cpu.particles.instances[k]))
      && cpu.streams.slots.every((slot, k) => slot.id === cpuCheck.cpu.streams.slots[k].id && slot.particles === cpuCheck.cpu.streams.slots[k].particles) };
    if (!finalState.matches) throw new Error("Final CPU replay state mismatch: occupancy invalid");
  } else {
    if (!gpuCheck || "unavailable" in gpuCheck) throw new Error(`GPU validation failed: ${gpuCheck?.unavailable}: run invalid`);
    const compared = compareGpuStates(timedGpuState!, gpuCheck.finalState);
    finalState = { matches: compared.identityMatches, maxFloatDifference: compared.maxFloatDifference };
    if (!finalState.matches) throw new Error("Final GPU active/slot/generation state differs from its validation replay: occupancy invalid");
    if (scenario === "drained" && gpuCheck.counts.some((n, k) => trace.measured[k] && n !== 0)) throw new Error("Drained measurement still has live particles: run invalid");
  }
  if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error: run invalid");
  const occupancy = (check: { counts: Uint32Array; perSlot: Uint32Array; perSlotIdentity: Uint16Array; occupancy: ReturnType<typeof validateCpuTrace>["occupancy"] }) => ({
    occupancy: check.occupancy, counts: check.counts, perSlot: check.perSlot, perSlotIdentity: check.perSlotIdentity,
    windows: fiveSecondWindows(trace, check.counts, check.perSlot),
  });
  return {
    runId,
    metadata: { cpuReference: CPU_REFERENCE, effectiveStep: "Float32(clamp(interval, 0, LOOK.maxDt))", backend, scenario, seed: REPLAY_SEED, capacity: REPLAY_CAPACITY, limit,
      motion, refreshHz, conditions, userAgent: navigator.userAgent, renderer: rendererName, targetFormat,
      width, height, pixelRatio: trace.pixelRatio[trace.length - 1], warmupSeconds, measureSeconds },
    timing: { callbacks: measured, callbackMs: distribution(work, measured), simulationMs: distribution(simulation, measured),
      submissionMs: distribution(submission, measured), intervalMs: distribution(intervals, measured), missedPeriods,
      uploadedBytes: totalUploads, textureUploadBytes: totalTextureUploads, drawCalls: totalDraws, summedParticleDrawCapacity: totalDrawCapacity,
      simulatedSlotsPerPositiveStep: REPLAY_CAPACITY, drawCapacity: backend === "gpu" ? REPLAY_CAPACITY : "live count",
      gpuTime: "not measured" },
    validation: { source: `untimed ${backend.toUpperCase()} replay of this trace`, finalStateMatches: finalState.matches,
      finalStateMaxFloatDifference: finalState.maxFloatDifference, ids: cpuCheck.ids,
      cpu: occupancy(cpuCheck),
      gpu: gpuCheck === null ? { unavailable: "crossValidate: false" } : "unavailable" in gpuCheck ? gpuCheck : occupancy(gpuCheck) },
    trace,
    acceptance: "Correctness harness: timing from one backend, exact occupancy from untimed replays of the same trace through both. Paired target-device runs and the parity decision are Task 6.",
  };
}
