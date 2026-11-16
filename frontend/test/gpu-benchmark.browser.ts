import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";
import { ParticleBudget } from "../src/sim/budget";
import { createSubmissionCounter } from "./fixtures/gpu-gl";
import { GpuTimer } from "./fixtures/gpu-timer";
import { BudgetSchedule, compareGpuStates, occupancyParity, CpuReplay, CPU_REFERENCE, effectiveDecisions, fiveSecondWindows, GpuReplay, readGpuState,
  REPLAY_CAPACITY, REPLAY_SCENARIOS, REPLAY_SEED, ReplayTrace, replayableStep, replayIds, replayFrameIndex, ScheduleCursor, validateCpuTrace,
  validateGpuTrace, type RecordedSchedule, type ReplayScenario } from "./fixtures/gpu-replay";

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
  /**
   * "adaptive" records a CPU adaptive discovery: the unmodified `ParticleBudget` sets the limit from
   * the exact CPU live count, callback work and intervals. CPU only; not a paired performance result.
   */
  budget?: "fixed" | "adaptive";
  /** Replay a discovery's schedule at its simulation times with no budget (CPU-schedule replay), on either backend. */
  schedule?: RecordedSchedule;
  /** Room for decisions an adaptive discovery records (default 1024). */
  scheduleCapacity?: number;
  /** GPU execution time from EXT_disjoint_timer_query_webgl2 where supported (default true); false discloses an opt-out. */
  gpuTiming?: boolean;
}

const BUDGET_LABELS = { fixed: "fixed limit", adaptive: "CPU adaptive discovery (not a paired performance result)", schedule: "CPU-schedule replay" };

const usedCanvases = new WeakSet<HTMLCanvasElement>();

function distribution(values: Float64Array, length: number) {
  if (!length) throw new Error("No measured callbacks");
  const sorted = values.slice(0, length).sort();
  return { median: sorted[Math.floor(length * 0.5)], p95: sorted[Math.floor(length * 0.95)], p99: sorted[Math.floor(length * 0.99)] };
}

/**
 * GPU execution time per timed callback, split into simulation and rendering. Samples are a subset
 * of the measured callbacks with a positive step (zero-dt callbacks submit no GPU work): ring-full skips, disjoint discards and results lost at the end are counted.
 */
function gpuTimeSummary(timer: GpuTimer, measuredSteps: number) {
  const { samples } = timer;
  const total = new Float64Array(samples);
  for (let k = 0; k < samples; k++) total[k] = timer.simulationMs[k] + timer.renderMs[k];
  return {
    source: "EXT_disjoint_timer_query_webgl2 TIME_ELAPSED_EXT",
    covers: "simulation: uploads, flag and prefix-scan passes, transform feedback over both state buffers' full capacity; render: instance upload or full-capacity draw, trail passes, present",
    measuredSteps, samples, skippedRingFull: timer.skipped, discardedDisjoint: timer.discarded, lostAtEnd: timer.inFlight,
    simulationMs: samples ? distribution(timer.simulationMs, samples) : null,
    renderMs: samples ? distribution(timer.renderMs, samples) : null,
    totalMs: samples ? distribution(total, samples) : null,
    callbacks: timer.callback.slice(0, samples),
  };
}

/**
 * Run the untimed GPU validation replay, or say why the GPU could not provide one. GL errors raised
 * during it belong to it, not to the timed run, whose errors are checked before validation.
 */
function gpuValidation(gl: WebGL2RenderingContext, trace: ReplayTrace) {
  try {
    const result = validateGpuTrace(gl, trace);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error} during GPU validation`);
    return result;
  } catch (error) {
    return { unavailable: String(error) };
  }
}

/**
 * Separate local harness, never imported by the public page. `backend` is fixed for the whole run:
 * a GPU failure fails the run rather than switching to the CPU, and a CPU restart is a new run.
 */
export async function runGpuBenchmark(options: BenchmarkOptions) {
  const { backend = "cpu", schedule, budget: budgetOption = "fixed", scheduleCapacity = 1024, refreshHz, conditions, crossValidate = true, gpuTiming = true } = options;
  const { scenario = schedule?.scenario ?? "dense", motion = schedule?.motion ?? 1, limit = 10000 } = options;
  const { warmupSeconds = scenario === "drained" ? 60 : 30, measureSeconds = 60, traceCapacity = 120000 } = options;
  if (backend !== "cpu" && backend !== "gpu") throw new Error("Backend must be cpu or gpu");
  if (budgetOption !== "fixed" && budgetOption !== "adaptive") throw new Error("Budget must be fixed or adaptive");
  // Native GPU adaptation needs exact live counts the GPU never reports; replay a CPU schedule instead.
  if (budgetOption === "adaptive" && backend !== "cpu") throw new Error("Adaptive discovery runs on the CPU only; replay its schedule on the GPU");
  // A saved schedule arrives as JSON: null or a non-object must not quietly become a fixed-limit run.
  if (options.schedule !== undefined && (typeof schedule !== "object" || schedule === null || !Array.isArray(schedule.decisions) || typeof schedule.runId !== "string")) {
    throw new Error("A schedule must be a recorded discovery schedule");
  }
  if (!REPLAY_SCENARIOS.includes(scenario)) throw new Error(`Scenario must be one of ${REPLAY_SCENARIOS.join(", ")}`);
  if (budgetOption === "adaptive" && options.limit !== undefined) throw new Error("Adaptive discovery starts from the full pool; omit limit");
  if (schedule && budgetOption === "adaptive") throw new Error("A schedule replay recalculates no budget");
  if (schedule && options.limit !== undefined) throw new Error("A schedule replay takes its limits from the schedule");
  if (schedule && (scenario !== schedule.scenario || motion !== schedule.motion)) throw new Error("Replay a schedule on the scenario and motion it was discovered with");
  if (!Number.isInteger(scheduleCapacity) || scheduleCapacity <= 0) throw new Error("Schedule capacity must be a positive integer");
  const mode = schedule ? "schedule" : budgetOption;
  if (!(refreshHz > 0) || !Number.isFinite(refreshHz) || !conditions.trim()) throw new Error("Record refresh rate and power/thermal/load conditions");
  if (!Number.isFinite(warmupSeconds) || warmupSeconds < 0 || !Number.isFinite(measureSeconds) || measureSeconds <= 0) throw new Error("Invalid measurement duration");
  if (!Number.isInteger(traceCapacity) || traceCapacity <= 0) throw new Error("Trace capacity must be a positive integer");
  if (![10000, 8000, 1000].includes(limit) || !(motion >= 0 && motion <= 1)) throw new Error("Invalid replay limit or motion");
  // Checked and preallocated first, so a malformed saved schedule fails before the page or any GPU resource is used.
  const cursor = schedule ? new ScheduleCursor(BudgetSchedule.from(schedule.decisions)) : null;
  // Everything that needs no GL is allocated before any GL resource, so a failure here leaks none.
  const trace = new ReplayTrace(traceCapacity);
  const budget = mode === "adaptive" ? new ParticleBudget(REPLAY_CAPACITY, false) : null;
  const discovered = budget ? new BudgetSchedule(scheduleCapacity) : null;
  if (budget) discovered!.record(0, budget.limit, budget.intensityScale);
  // In force for the next step; a budget change made after a callback's render applies to the following one, as in main.ts.
  let stepLimit = cursor ? cursor.limit : budget ? budget.limit : limit;
  let stepIntensity = cursor ? cursor.intensity : budget ? budget.intensityScale : 1;
  // Simulation time at the start of the next step, the sum of the trace's effective steps: it picks
  // the scenario's frame and the schedule's decision, so slow, clamped callbacks shift neither.
  let simulationTime = 0;
  const work = new Float64Array(traceCapacity);
  const simulation = new Float64Array(traceCapacity);
  const submission = new Float64Array(traceCapacity);
  const intervals = new Float64Array(traceCapacity);
  const canvas = document.querySelector<HTMLCanvasElement>("#river");
  if (canvas && usedCanvases.has(canvas)) throw new Error("Reload the benchmark page before each run to reset GL resources");
  const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!canvas || !gl) throw new Error("WebGL2 unavailable");
  if (document.hidden) throw new Error("Benchmark must start in a visible tab");

  usedCanvases.add(canvas);
  const runId = crypto.randomUUID();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);

  // Instrument submission rather than GPU execution; method wrappers are cached on first use.
  const { gl: countedGl, counters } = createSubmissionCounter(gl);
  const renderer = new Renderer(countedGl, REPLAY_CAPACITY);
  const cpu = backend === "cpu" ? new CpuReplay(motion) : null;
  let gpu: GpuReplay | null = null;
  if (backend === "gpu") {
    try {
      gpu = new GpuReplay(countedGl, motion);
      // All drawer setup happens here, so its shader fails before timing and no measured callback sets anything up.
      gpu.drawer.prepare();
    } catch (error) {
      gpu?.dispose();
      // Unsupported limits, failed allocation or a shader that does not compile: no fallback.
      throw new Error(`GPU backend failed: ${String(error)}: run invalid`);
    }
  }
  // Queries go to the raw context, so they never count as submitted uploads or draws.
  let timer: GpuTimer | string;
  try {
    timer = GpuTimer.create(gl, gpuTiming, traceCapacity);
  } catch (error) {
    gpu?.dispose();
    throw new Error(`GPU timer queries failed: ${String(error)}: run invalid`);
  }
  const gpuTimer = typeof timer === "string" ? null : timer;
  let measured = 0, measuredSteps = 0, missedPeriods = 0, totalUploads = 0, totalTextureUploads = 0, totalDraws = 0, totalDrawCapacity = 0;
  let last: number | undefined, start: number | undefined;
  let width = 0, height = 0, raf = 0;
  let targetFormat = "unknown";
  let stopped = false;

  // A failed run releases the GPU replay's resources; the page still needs a reload before the next run.
  const timed = new Promise<void>((resolve, reject) => {
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
        if (cursor) {
          cursor.advance(simulationTime);
          stepLimit = cursor.limit;
          stepIntensity = cursor.intensity;
        }
        trace.append(interval, replayFrameIndex(scenario, simulationTime), width, height, pixelRatio, motion, false, stepLimit, stepIntensity, isMeasured);
        const i = trace.length - 1, dt = trace.dt[i];
        // Both backends must be able to replay every trace; the GPU rejects tiny positive steps.
        if (!replayableStep(dt)) {
          trace.valid = false;
          throw new Error("Callback interval below 1/256 s: run invalid (GPU step contract)");
        }
        counters.uploadedBytes = counters.textureUploadBytes = counters.drawCalls = counters.particleDrawCapacity = 0;
        // Polling and query calls belong to callback work, outside the simulation and submission spans.
        gpuTimer?.poll();
        const timing = isMeasured && dt > 0 && gpuTimer !== null && gpuTimer.beginSimulation(i);
        const simBegin = performance.now();
        let count = 0;
        if (cpu) {
          count = cpu.step(trace, i);
          if (scenario === "drained" && isMeasured && count !== 0) throw new Error("Drained measurement still has live particles: run invalid");
        } else gpu!.step(trace, i);
        const simEnd = performance.now();
        if (timing) gpuTimer!.beginRender();
        // Submission starts after the query switch, so neither span (nor the budget's input) includes query calls.
        const renderBegin = performance.now();
        if (dt > 0) {
          if (cpu) renderer.render(cpu.particles.instances, count, dt, width / height);
          else renderer.renderGpu(gpu!.drawer, dt, width / height, pixelRatio, gpu!.particles.globalHue, gpu!.intensity);
        }
        const end = performance.now();
        if (timing) gpuTimer!.endRender();
        if (isMeasured && dt > 0) measuredSteps++;
        simulationTime += dt;
        // Only exact CPU counts reach the budget; it sees simulation and render submission, as in main.ts.
        if (budget && dt > 0 && budget.update(interval, cpu!.particles.count, (simEnd - simBegin + end - renderBegin) / 1000)) {
          stepLimit = budget.limit;
          stepIntensity = budget.intensityScale;
          discovered!.record(simulationTime, stepLimit, stepIntensity);
        }
        if (isMeasured) {
          simulation[measured] = simEnd - simBegin;
          submission[measured] = end - renderBegin;
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
  try {
    await timed;
    // Collect results still in flight, untimed and before any readback; a few frames normally suffice.
    for (let wait = 0; gpuTimer?.inFlight && wait < 60 && !gl.isContextLost(); wait++) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      gpuTimer.poll();
    }
  } catch (error) {
    gpu?.dispose();
    throw error;
  } finally {
    gpuTimer?.dispose();
  }

  // No performance warmup overlaps validation, and no readback happened while timing. The timed
  // run's final state is checked against an untimed replay of its own backend; the other backend
  // replays the same trace for cross-backend occupancy.
  let timedGpuState: ArrayBuffer | null = null;
  if (gpu) {
    timedGpuState = new ArrayBuffer(REPLAY_CAPACITY * 64);
    try {
      readGpuState(gl, gpu.particles, timedGpuState);
    } finally {
      gpu.dispose();
    }
  }
  if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL error: run invalid");
  // crossValidate: false keeps only the run's own backend's replay.
  const cpuCheck = cpu || crossValidate ? validateCpuTrace(trace) : null;
  const gpuCheck = gpu || crossValidate ? gpuValidation(gl, trace) : null;
  if (gl.isContextLost()) throw new Error("WebGL context lost during validation: run invalid");
  let finalState: { matches: boolean; maxFloatDifference?: number };
  if (cpu && cpuCheck) {
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
  const occupancy = (check: { counts: Uint32Array; perSlot: Uint32Array; perSlotIdentity: Uint16Array; occupancy: ReturnType<typeof validateCpuTrace>["occupancy"] }) => ({
    occupancy: check.occupancy, counts: check.counts, perSlot: check.perSlot, perSlotIdentity: check.perSlotIdentity,
    windows: fiveSecondWindows(trace, check.counts, check.perSlot),
  });
  return {
    runId,
    metadata: { cpuReference: CPU_REFERENCE, effectiveStep: "Float32(clamp(interval, 0, LOOK.maxDt))", backend, scenario, seed: REPLAY_SEED, capacity: REPLAY_CAPACITY,
      budget: BUDGET_LABELS[mode], limit: mode === "fixed" ? limit : "scheduled", scheduleSource: schedule?.runId,
      gpuTiming: typeof timer === "string" ? timer : "enabled", motion, refreshHz, conditions, userAgent: navigator.userAgent, renderer: rendererName, targetFormat,
      width, height, pixelRatio: trace.pixelRatio[trace.length - 1], warmupSeconds, measureSeconds },
    timing: { callbacks: measured, callbackMs: distribution(work, measured), simulationMs: distribution(simulation, measured),
      submissionMs: distribution(submission, measured), intervalMs: distribution(intervals, measured), missedPeriods,
      uploadedBytes: totalUploads, textureUploadBytes: totalTextureUploads, drawCalls: totalDraws, summedParticleDrawCapacity: totalDrawCapacity,
      simulatedSlotsPerPositiveStep: REPLAY_CAPACITY, drawCapacity: backend === "gpu" ? REPLAY_CAPACITY : "live count",
      gpuTime: gpuTimer ? gpuTimeSummary(gpuTimer, measuredSteps) : timer as string },
    validation: { source: `untimed ${backend.toUpperCase()} replay of this trace`, finalStateMatches: finalState.matches,
      finalStateMaxFloatDifference: finalState.maxFloatDifference, ids: replayIds,
      cpu: cpuCheck === null ? { unavailable: "crossValidate: false" } : occupancy(cpuCheck),
      gpu: gpuCheck === null ? { unavailable: "crossValidate: false" } : "unavailable" in gpuCheck ? gpuCheck : occupancy(gpuCheck),
      /** The decided cross-backend gate; a failure makes this run's performance comparison inconclusive. */
      parity: cpuCheck && gpuCheck && !("unavailable" in gpuCheck) ? occupancyParity(trace, scenario, cpuCheck, gpuCheck)
        : { unavailable: cpuCheck && gpuCheck ? `GPU replay unavailable: ${(gpuCheck as { unavailable: string }).unavailable}` : "crossValidate: false" } },
    trace,
    /** Limit and intensity changes this run applied, per callback; validation replayed exactly these. */
    decisions: effectiveDecisions(trace),
    /** An adaptive discovery's schedule, to pass back as `schedule` for CPU-schedule replays on both backends. */
    schedule: discovered ? { runId, scenario, motion, decisions: discovered.decisions() } satisfies RecordedSchedule : undefined,
    /** Of a replayed schedule: decisions this run reached; later ones lay beyond its simulated time. */
    scheduleApplied: cursor ? { applied: cursor.applied, total: schedule!.decisions.length } : undefined,
    acceptance: "Correctness harness: timing from one backend, exact occupancy from untimed replays of the same trace through both. Paired target-device runs and the parity decision are Task 6.",
  };
}
