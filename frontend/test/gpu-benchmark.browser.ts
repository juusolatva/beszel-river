import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";
import { createSubmissionCounter } from "./fixtures/gpu-gl";
import { CpuReplay, CPU_REFERENCE, REPLAY_CAPACITY, REPLAY_SEED, ReplayTrace, replayFrameIndex,
  validateCpuTrace, type ReplayScenario } from "./fixtures/gpu-replay";

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
}

const usedCanvases = new WeakSet<HTMLCanvasElement>();

function distribution(values: Float64Array, length: number) {
  if (!length) throw new Error("No measured callbacks");
  const sorted = values.slice(0, length).sort();
  return { median: sorted[Math.floor(length * 0.5)], p95: sorted[Math.floor(length * 0.95)], p99: sorted[Math.floor(length * 0.99)] };
}

/** Separate local harness, never imported by the public page. GPU selection fails until Task 4. */
export async function runGpuBenchmark(options: BenchmarkOptions) {
  const { backend = "cpu", scenario = "dense", limit = 10000, warmupSeconds = scenario === "drained" ? 60 : 30,
    measureSeconds = 60, traceCapacity = 120000, motion = 1, refreshHz, conditions } = options;
  if (backend !== "cpu") throw new Error("GPU backend not implemented; CPU reference only");
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
  const cpu = new CpuReplay(motion);
  const trace = new ReplayTrace(traceCapacity);
  const work = new Float64Array(traceCapacity);
  const simulation = new Float64Array(traceCapacity);
  const submission = new Float64Array(traceCapacity);
  const intervals = new Float64Array(traceCapacity);
  let measured = 0, missedPeriods = 0, totalUploads = 0, totalDraws = 0, totalDrawCapacity = 0;
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
        counters.uploadedBytes = counters.drawCalls = counters.particleDrawCapacity = 0;
        const simBegin = performance.now();
        const count = cpu.step(trace, trace.length - 1);
        if (scenario === "drained" && isMeasured && count !== 0) throw new Error("Drained measurement still has live particles: run invalid");
        const simEnd = performance.now();
        if (trace.dt[trace.length - 1] > 0) renderer.render(cpu.particles.instances, count, trace.dt[trace.length - 1], width / height);
        const end = performance.now();
        if (isMeasured) {
          simulation[measured] = simEnd - simBegin;
          submission[measured] = end - simEnd;
          intervals[measured++] = interval * 1000;
          missedPeriods += Math.max(0, Math.round(interval * refreshHz) - 1);
          totalUploads += counters.uploadedBytes;
          totalDraws += counters.drawCalls;
          totalDrawCapacity += counters.particleDrawCapacity;
        }
        raf = requestAnimationFrame(frame);
        if (isMeasured) work[measured - 1] = performance.now() - begin;
      } catch (error) { cleanup(); reject(error); }
    };
    raf = requestAnimationFrame(frame);
  });

  // No performance warmup overlaps this validation. Compare the complete final CPU instance
  // buffer and per-slot counts; GPU active/identity readbacks are added with that backend.
  const validation = validateCpuTrace(trace);
  const sameFinalState = cpu.particles.count === validation.cpu.particles.count
    && cpu.particles.instances.every((value, i) => Object.is(value, validation.cpu.particles.instances[i]))
    && cpu.streams.slots.every((slot, i) => slot.id === validation.cpu.streams.slots[i].id && slot.particles === validation.cpu.streams.slots[i].particles);
  if (!sameFinalState) throw new Error("Final CPU replay state mismatch: occupancy invalid");
  if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error: run invalid");
  return {
    runId,
    metadata: { cpuReference: CPU_REFERENCE, backend, scenario, seed: REPLAY_SEED, capacity: REPLAY_CAPACITY, limit,
      motion, refreshHz, conditions, userAgent: navigator.userAgent, renderer: rendererName, targetFormat,
      width, height, pixelRatio: trace.pixelRatio[trace.length - 1], warmupSeconds, measureSeconds },
    timing: { callbacks: measured, callbackMs: distribution(work, measured), simulationMs: distribution(simulation, measured),
      submissionMs: distribution(submission, measured), intervalMs: distribution(intervals, measured), missedPeriods,
      uploadedBytes: totalUploads, drawCalls: totalDraws, summedParticleDrawCapacity: totalDrawCapacity,
      simulatedSlotsPerPositiveStep: REPLAY_CAPACITY, gpuTime: "not measured" },
    validation: { source: "untimed CPU replay", finalStateMatches: sameFinalState, occupancy: validation.occupancy,
      counts: validation.counts, perSlot: validation.perSlot, ids: validation.ids, perSlotIdentity: validation.perSlotIdentity },
    trace,
    acceptance: "Foundation only: cross-backend five-second occupancy windows and target-device measurements pending",
  };
}
