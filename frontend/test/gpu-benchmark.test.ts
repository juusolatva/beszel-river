import { afterEach, describe, expect, it, vi } from "vitest";
import { callsTo, createFakeGl } from "./fake-gl";
import { LOOK } from "../src/config";
import { ParticleBudget } from "../src/sim/budget";
import { runGpuBenchmark } from "./gpu-benchmark.browser";

afterEach(() => vi.unstubAllGlobals());

it("includes canvas layout reads in callback work and replays the final rendered CPU state", async () => {
  let clock = 0;
  let callback: FrameRequestCallback | undefined;
  const { gl } = createFakeGl({ overrides: {
    getParameter: () => "test renderer",
    getFramebufferAttachmentParameter: () => "FLOAT",
    getError: () => "NO_ERROR",
  } });
  const canvas = {
    get clientWidth() { clock += 10; return 960; },
    get clientHeight() { clock += 10; return 640; },
    getContext: () => gl,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  vi.stubGlobal("document", { hidden: false, querySelector: () => canvas,
    addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("navigator", { userAgent: "test browser" });
  vi.stubGlobal("performance", { now: () => clock++ });
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => { callback = next; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { callback = undefined; });
  const run = runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, traceCapacity: 4 });
  for (const now of [0, 20, 40, 60]) callback?.(now);
  const result = await run;
  expect(result.timing.callbackMs.median).toBeGreaterThanOrEqual(20);
  expect(result.validation.finalStateMatches).toBe(true);
  expect(result.trace).toHaveLength(3);
  expect(result.metadata.effectiveStep).toBe("Float32(clamp(interval, 0, LOOK.maxDt))");
  // The CPU steps and draws its slots through drawCount, not the whole pool or only the live ones.
  expect(result.timing.simulatedSlotsPerPositiveStep).toBe("drawCount (highest live slot + 1)");
  expect(result.timing.drawCapacity).toBe("drawCount (highest live slot + 1)");
  await expect(runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/Reload/);
  // CPU runs replay the trace through the GPU too, untimed.
  expect(result.validation.cpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  expect(result.validation.gpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  // Both replays feed the parity gate; a run shorter than one window decides nothing.
  expect(result.validation.parity).toEqual(expect.objectContaining({ gated: true, passed: null, windows: [] }));
});

/** Stub a visible page around a fake context; returns the next animation callback. */
function stubPage(options: Parameters<typeof createFakeGl>[0] = {}) {
  let clock = 0;
  const state: { callback?: FrameRequestCallback; lost?: () => void } = {};
  const fake = createFakeGl({ ...options, overrides: {
    getParameter: () => "test renderer",
    getFramebufferAttachmentParameter: () => "FLOAT",
    getError: () => "NO_ERROR",
    isContextLost: () => false,
    ...options.overrides,
  } });
  const canvas = { clientWidth: 960, clientHeight: 640, getContext: () => fake.gl,
    addEventListener: (type: string, listener: () => void) => { if (type === "webglcontextlost") state.lost = listener; },
    removeEventListener: vi.fn() };
  vi.stubGlobal("document", { hidden: false, querySelector: () => canvas, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("navigator", { userAgent: "test browser" });
  vi.stubGlobal("performance", { now: () => clock++ });
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => { state.callback = next; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { state.callback = undefined; });
  return { ...fake, state, canvas };
}

describe("GPU backend", () => {
  it("draws from GPU state on the recorded schedule and validates both backends untimed", async () => {
    const { calls, state } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05, crossValidate: false });
    for (let now = 0; now <= 1100; now += 20) state.callback?.(now);
    const result = await run;
    expect(result.metadata.backend).toBe("gpu");
    expect(result.timing.drawCapacity).toBe("activeSlots (horizon: at most capacity)");
    expect(result.timing.simulatedSlotsPerPositiveStep).toBe("activeSlots (horizon: at most capacity)");
    // Every positive step drew the full pool and uploaded no particle instances.
    const draws = callsTo(calls, "drawArraysInstanced");
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.every(([, , , instances]) => instances === 10000)).toBe(true);
    expect(callsTo(calls, "bufferSubData")).toEqual([]);
    expect(result.timing.uploadedBytes).toBe(0);
    // Stream and command data every measured step, and the flow grid.
    expect(result.timing.textureUploadBytes).toBeGreaterThanOrEqual(result.timing.callbacks * (24 * 32 * 16 + 32 * 16));
    expect(result.validation.finalStateMatches).toBe(true);
    expect(result.validation.finalStateMaxFloatDifference).toBe(0);
    expect(result.validation.source).toMatch(/GPU/);
    // crossValidate: false skips the CPU replay of a GPU run, and with it the parity gate.
    expect(result.validation.cpu).toEqual({ unavailable: "crossValidate: false" });
    expect(result.validation.parity).toEqual({ unavailable: "crossValidate: false" });
    expect(result.validation.gpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  });

  it("fails without falling back to the CPU when the GPU backend cannot start", async () => {
    stubPage({ overrides: { getParameter: (name) => (name === "MAX_VERTEX_TEXTURE_IMAGE_UNITS" ? 0 : "test renderer") } });
    await expect(runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/GPU backend failed.*unsupported/);
  });

  it("reports a drawer shader failure as a failed GPU start and releases the GPU replay", async () => {
    // The renderer links three programs and the simulation three more; the drawer's is the seventh.
    let links = 0;
    const { calls } = stubPage({ overrides: { linkProgram: () => { links++; }, getProgramParameter: () => links < 7, getProgramInfoLog: () => "drawer link" } });
    await expect(runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/GPU backend failed.*drawer link.*run invalid/);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("sets the drawer up before timing, so even a run without warmup creates nothing while measured", async () => {
    const { calls, state } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    const prepared = callsTo(calls, "createVertexArray").length;
    const links = callsTo(calls, "linkProgram").length;
    for (const now of [0, 20, 40, 60]) state.callback?.(now);
    expect(callsTo(calls, "createVertexArray")).toHaveLength(prepared);
    expect(callsTo(calls, "linkProgram")).toHaveLength(links);
    expect((await run).validation.finalStateMatches).toBe(true);
  });

  it("rejects unknown backends", async () => {
    stubPage();
    await expect(runGpuBenchmark({ backend: "webgpu" as "gpu", refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/cpu or gpu/);
  });

  it("marks a run invalid when the context is lost", async () => {
    const { calls, state } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05 });
    state.callback?.(0);
    state.lost?.();
    await expect(run).rejects.toThrow(/context lost/);
    // A failed run releases the GPU replay's resources.
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("releases the GPU replay when the final readback fails", async () => {
    const { calls, state } = stubPage({ overrides: { getBufferSubData: () => { throw new Error("readback failed"); } } });
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05 });
    for (let now = 0; now <= 1100; now += 20) state.callback?.(now);
    await expect(run).rejects.toThrow(/readback failed/);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("marks a run invalid when the context is lost during validation", async () => {
    let lost = false;
    const { state } = stubPage({ overrides: { isContextLost: () => lost, getBufferSubData: () => { lost = true; } } });
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05 });
    for (let now = 0; now <= 1100; now += 20) state.callback?.(now);
    await expect(run).rejects.toThrow(/lost during validation/);
  });

  it("rejects callback intervals the GPU cannot replay, on either backend", async () => {
    for (const backend of ["cpu", "gpu"] as const) {
      const { state } = stubPage();
      const run = runGpuBenchmark({ backend, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05 });
      state.callback?.(0);
      state.callback?.(1);
      await expect(run).rejects.toThrow(/below 1\/256 s/);
    }
  });

  it("attributes GL errors to the timed run or to the optional GPU replay", async () => {
    // During the timed CPU run: the run is invalid.
    const timed = stubPage({ overrides: { getError: () => "INVALID_OPERATION" } });
    const failing = runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05 });
    for (const now of [0, 20, 40, 60]) timed.state.callback?.(now);
    await expect(failing).rejects.toThrow(/WebGL error: run invalid/);
    // Raised by the GPU cross-replay of a CPU run (its first readback): reported there only.
    let replaying = false;
    const replay = stubPage({ overrides: { getBufferSubData: () => { replaying = true; }, getError: () => (replaying ? "OUT_OF_MEMORY" : "NO_ERROR") } });
    const run = runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05 });
    for (const now of [0, 20, 40, 60]) replay.state.callback?.(now);
    const result = await run;
    expect(result.validation.gpu).toEqual({ unavailable: expect.stringMatching(/OUT_OF_MEMORY during GPU validation/) });
    expect(result.validation.parity).toEqual({ unavailable: expect.stringMatching(/GPU replay unavailable: .*OUT_OF_MEMORY/) });
    expect(result.validation.cpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  });

  it("reports an unavailable cross-backend replay instead of failing a CPU run", async () => {
    let fail = false;
    const { state } = stubPage({ overrides: { getParameter: (name) => (fail && name === "MAX_VERTEX_ATTRIBS" ? 0 : "test renderer") } });
    const run = runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05 });
    for (const now of [0, 20, 40, 60]) state.callback?.(now);
    fail = true;
    const result = await run;
    expect(result.validation.gpu).toEqual({ unavailable: expect.stringMatching(/unsupported/) });
  });
});

it("rejects a missing render framebuffer before querying a default-framebuffer color attachment", async () => {
  let callback: FrameRequestCallback | undefined;
  const { gl, calls } = createFakeGl({ overrides: {
    createFramebuffer: () => null,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: () => "test renderer",
    getFramebufferAttachmentParameter: () => "FLOAT",
    getError: () => "NO_ERROR",
  } });
  const canvas = { clientWidth: 960, clientHeight: 640, getContext: () => gl,
    addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("document", { hidden: false, querySelector: () => canvas,
    addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => { callback = next; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const run = runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05 });
  callback?.(0);
  await expect(run).rejects.toThrow(/render framebuffer/);
  expect(calls.filter(([name]) => name === "getFramebufferAttachmentParameter")).toEqual([]);
});

describe("budget schedules", () => {
  /** Callbacks every `step` ms until the run resolves. */
  function drive(state: { callback?: FrameRequestCallback }, step: number, until: number) {
    for (let now = 0; now <= until; now += step) state.callback?.(now);
  }

  /** Simulation time at the start of callback `i`. */
  function startTime(trace: { dt: Float32Array }, i: number) {
    let time = 0;
    for (let k = 0; k < i; k++) time += trace.dt[k];
    return time;
  }

  /** A CPU discovery whose 60 ms frames are slow from the start: the budget drops once in 3 s. */
  async function discover() {
    const { state } = stubPage();
    const run = runGpuBenchmark({ budget: "adaptive", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 3, crossValidate: false });
    drive(state, 60, 3100);
    return run;
  }

  it("records a CPU adaptive discovery whose decisions take effect on the following step", async () => {
    const update = vi.spyOn(ParticleBudget.prototype, "update");
    const result = await discover();
    expect(result.metadata.budget).toMatch(/CPU adaptive discovery.*not a paired performance result/);
    expect(result.metadata.limit).toBe("scheduled");
    // More than 2 s of slow frames: the 34th 60 ms step returns the drop, the next step uses it.
    const { trace } = result;
    expect(trace.limit[34]).toBe(10000);
    expect(trace.limit[35]).toBe(8000);
    expect(trace.intensity[35]).toBeCloseTo(Math.sqrt(10000 / 8000));
    expect(result.schedule).toEqual({ runId: result.runId, scenario: "dense", motion: 1, decisions: [
      { time: 0, limit: 10000, intensity: 1 },
      { time: startTime(trace, 35), limit: 8000, intensity: Math.sqrt(10000 / 8000) },
    ] });
    expect(result.decisions).toEqual([
      { callback: 0, time: 0, limit: 10000, intensity: 1 },
      { callback: 35, time: startTime(trace, 35), limit: 8000, intensity: Math.sqrt(10000 / 8000) },
    ]);
    // The budget saw every positive step, with the CPU's exact live count and real intervals.
    expect(update).toHaveBeenCalledTimes(trace.length - 1);
    expect(update.mock.calls.every(([interval, live]) => interval === 0.06 && Number.isInteger(live) && live <= 10000)).toBe(true);
    // The untimed replay applied the same decisions and reproduced the run.
    expect(result.validation.finalStateMatches).toBe(true);
    update.mockRestore();
  });

  it("replays one CPU schedule on both backends at its simulation times, with no budget", async () => {
    const { schedule } = await discover();
    const update = vi.spyOn(ParticleBudget.prototype, "update");
    const runs = [];
    for (const backend of ["cpu", "gpu"] as const) {
      const { state } = stubPage();
      // A different cadence than the discovery: the boundary is in simulation time, not callbacks.
      const run = runGpuBenchmark({ backend, schedule, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 3, crossValidate: false });
      drive(state, 50, 3100);
      runs.push(await run);
    }
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    const boundary = schedule!.decisions[1].time;
    for (const result of runs) {
      expect(result.metadata.budget).toBe("CPU-schedule replay");
      expect(result.metadata.scheduleSource).toBe(schedule!.runId);
      expect(result.scheduleApplied).toEqual({ applied: 2, total: 2 });
      const first = result.decisions[1].callback;
      expect(startTime(result.trace, first)).toBeGreaterThanOrEqual(boundary);
      expect(startTime(result.trace, first - 1)).toBeLessThan(boundary);
      expect(result.validation.finalStateMatches).toBe(true);
    }
    // Same callbacks, same schedule: both backends applied identical decisions.
    expect(runs[1].decisions).toEqual(runs[0].decisions);
    expect(runs[0].decisions.map(({ limit }) => limit)).toEqual([10000, 8000]);
  });

  it("changes scenario frames at simulation times, so slow clamped callbacks do not shift them", async () => {
    const { state } = stubPage();
    const run = runGpuBenchmark({ scenario: "rotation", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 8, crossValidate: false });
    // 4 s of 200 ms callbacks simulate only 2 s (clamped to 0.1 s), then 100 ms callbacks.
    let now = 0;
    for (; now < 4000; now += 200) state.callback?.(now);
    for (; now <= 8100; now += 100) state.callback?.(now);
    const { trace } = await run;
    // The 1 → 4 stream expansion is due at 5 s.
    const expansion = trace.frame.indexOf(1);
    expect(trace.frame[expansion - 1]).toBe(0);
    expect(startTime(trace, expansion)).toBeGreaterThanOrEqual(5);
    expect(startTime(trace, expansion - 1)).toBeLessThan(5);
    // By wall time it would have come at 5 s; it came at 7 s, after 5 simulated seconds.
    let wall = 0;
    for (let k = 0; k < expansion; k++) wall += trace.interval[k];
    expect(wall).toBeCloseTo(7, 1);
  });

  it("reports decisions a shorter replay never reached", async () => {
    const { schedule } = await discover();
    const { state } = stubPage();
    const run = runGpuBenchmark({ schedule, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 1, crossValidate: false });
    drive(state, 50, 1100);
    const result = await run;
    expect(result.scheduleApplied).toEqual({ applied: 1, total: 2 });
    expect(result.decisions).toEqual([{ callback: 0, time: 0, limit: 10000, intensity: 1 }]);
  });

  it("saves the effective decisions of a fixed-limit run", async () => {
    const { state } = stubPage();
    const run = runGpuBenchmark({ limit: 8000, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05 });
    drive(state, 20, 60);
    const result = await run;
    expect(result.metadata).toEqual(expect.objectContaining({ budget: "fixed limit", limit: 8000 }));
    expect(result.decisions).toEqual([{ callback: 0, time: 0, limit: 8000, intensity: 1 }]);
    expect(result.schedule).toBeUndefined();
  });

  it("fails a discovery whose schedule overflows", async () => {
    const { state } = stubPage();
    const run = runGpuBenchmark({ budget: "adaptive", scheduleCapacity: 1, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 3 });
    drive(state, 60, 3100);
    await expect(run).rejects.toThrow(/schedule overflow/);
  });

  it("refuses GPU adaptation and schedules that would silently change the workload", async () => {
    const schedule = { runId: "r", scenario: "dense" as const, motion: 1, decisions: [{ time: 0, limit: 10000, intensity: 1 }] };
    const cases: [Partial<Parameters<typeof runGpuBenchmark>[0]>, RegExp][] = [
      [{ backend: "gpu", budget: "adaptive" }, /CPU only/],
      [{ budget: "native" as "adaptive" }, /fixed or adaptive/],
      [{ schedule, budget: "adaptive" }, /recalculates no budget/],
      [{ schedule, limit: 8000 }, /limits from the schedule/],
      [{ schedule, scenario: "rotation" }, /scenario and motion/],
      [{ schedule, motion: 0 }, /scenario and motion/],
      [{ budget: "adaptive", scheduleCapacity: 0 }, /Schedule capacity/],
      [{ schedule: { ...schedule, decisions: [{ time: 1, limit: 10000, intensity: 1 }] } }, /nondecreasing times from 0/],
      [{ schedule: { ...schedule, decisions: [] } }, /initial decision/],
      // Saved schedules arrive as JSON: null or a wrong shape must not become a fixed-limit run.
      [{ schedule: null as unknown as typeof schedule }, /recorded discovery schedule/],
      [{ schedule: { ...schedule, decisions: "none" as unknown as [] } }, /recorded discovery schedule/],
      [{ schedule: { ...schedule, runId: 7 as unknown as string } }, /recorded discovery schedule/],
      [{ schedule: { ...schedule, scenario: "spiral" as "dense" } }, /Scenario must be one of/],
      [{ scenario: "spiral" as "dense" }, /Scenario must be one of/],
      [{ budget: "adaptive", limit: 8000 }, /full pool; omit limit/],
    ];
    for (const [options, message] of cases) {
      stubPage();
      await expect(runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture", ...options })).rejects.toThrow(message);
    }
    // A malformed schedule fails before any GPU resource exists or the page is used up.
    const { calls, state } = stubPage();
    const bad = { ...schedule, decisions: [{ time: 0, limit: 0, intensity: 1 }] };
    await expect(runGpuBenchmark({ backend: "gpu", schedule: bad, refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/limits within the pool/);
    expect(callsTo(calls, "createBuffer")).toEqual([]);
    const run = runGpuBenchmark({ backend: "gpu", schedule, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) state.callback?.(now);
    expect((await run).validation.finalStateMatches).toBe(true);
  });
});

describe("GPU runs across page lifecycle events", () => {
  /** Resource creation and deletion calls, by name. */
  const LIFECYCLE = ["createBuffer", "deleteBuffer", "createTransformFeedback", "deleteTransformFeedback", "createProgram", "deleteProgram",
    "createVertexArray", "deleteVertexArray", "createTexture", "deleteTexture", "createFramebuffer", "deleteFramebuffer"];
  const lifecycleCalls = (calls: unknown[][], from: number) => calls.slice(from).filter(([name]) => LIFECYCLE.includes(name as string)).map(([name]) => name);

  it("recreates only the trail targets on landscape/portrait resizes and DPR changes", async () => {
    const { calls, state, canvas } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.5, crossValidate: false });
    state.callback?.(0);
    const started = calls.length;
    const sizes: [number, number, number][] = [];
    for (let now = 20; now <= 520; now += 20) {
      // Landscape → portrait, then DPR 1 → 2 (capped at LOOK.devicePixelRatioCap), each held for a few callbacks.
      if (now === 120) { canvas.clientWidth = 400; canvas.clientHeight = 700; }
      if (now === 240) vi.stubGlobal("devicePixelRatio", 2);
      state.callback?.(now);
    }
    // Disposal and the validation replay run after timing, once the run resolves.
    const timed = lifecycleCalls(calls, started);
    const result = await run;
    for (let i = 0; i < result.trace.length; i++) sizes.push([result.trace.width[i], result.trace.height[i], result.trace.pixelRatio[i]]);
    const distinct = [...new Set(sizes.map((size) => size.join("x")))];
    expect(distinct).toEqual(["960x640x1", "400x700x1", `${Math.round(400 * LOOK.devicePixelRatioCap)}x${Math.round(700 * LOOK.devicePixelRatioCap)}x${LOOK.devicePixelRatioCap}`]);
    // Two resizes, each replacing the two trail targets; the flow grid follows the aspect with
    // texImage2D on its existing texture. No simulation buffer, program or vertex array is touched.
    const target = ["deleteFramebuffer", "deleteTexture", "deleteFramebuffer", "deleteTexture", "createTexture", "createFramebuffer", "createTexture", "createFramebuffer"];
    expect(timed).toEqual([...target, ...target]);
    expect(result.validation.finalStateMatches).toBe(true);
  });

  it("fails the run and releases the GPU replay when the trail targets cannot be allocated", async () => {
    // At the first callback and after a mid-run resize.
    for (const failAt of [0, 100]) {
      let failing = false;
      const { calls, state, canvas } = stubPage({ overrides: { checkFramebufferStatus: () => (failing ? "FRAMEBUFFER_UNSUPPORTED" : "FRAMEBUFFER_COMPLETE") } });
      const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.5 });
      for (let now = 0; now <= 200 && state.callback; now += 20) {
        if (now === failAt) { failing = true; canvas.clientWidth = 400; }
        state.callback?.(now);
      }
      await expect(run).rejects.toThrow(/Cannot create render targets/);
      expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
    }
  });

  it("runs reduced motion on the GPU and validates it", async () => {
    const { state } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", motion: 0.5, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.1 });
    for (let now = 0; now <= 120; now += 20) state.callback?.(now);
    const result = await run;
    expect(result.metadata.motion).toBe(0.5);
    expect([...result.trace.motion.slice(0, result.trace.length)].every((motion) => motion === 0.5)).toBe(true);
    expect(result.validation.finalStateMatches).toBe(true);
    expect(result.validation.cpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  });
});

describe("GPU timer queries", () => {
  const EXT = { TIME_ELAPSED_EXT: "TIME_ELAPSED_EXT", GPU_DISJOINT_EXT: "GPU_DISJOINT_EXT" };
  /** A page offering the timer extension; every query reports 2 ms once `ready`. */
  function timedPage(state: { ready: boolean }) {
    return stubPage({ overrides: {
      getExtension: (name) => (name === "EXT_disjoint_timer_query_webgl2" ? EXT : null),
      getQueryParameter: (_query, pname) => (pname === "QUERY_RESULT_AVAILABLE" ? state.ready : 2e6),
      getParameter: (name) => (name === "GPU_DISJOINT_EXT" ? false : "test renderer"),
    } });
  }

  it("times every measured callback's simulation and rendering on the GPU and releases the queries", async () => {
    for (const backend of ["gpu", "cpu"] as const) {
      const { calls, state } = timedPage({ ready: true });
      const run = runGpuBenchmark({ backend, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0.04, measureSeconds: 0.1, crossValidate: false });
      for (let now = 0; now <= 160; now += 20) state.callback?.(now);
      const result = await run;
      expect(result.metadata.gpuTiming).toBe("enabled");
      const gpuTime = result.timing.gpuTime as Exclude<typeof result.timing.gpuTime, string>;
      // Warmup callbacks are not timed; every measured one is (this warmup covers the zero-dt first callback).
      expect(gpuTime.measuredSteps).toBe(result.timing.callbacks);
      expect(gpuTime.samples).toBe(result.timing.callbacks);
      expect([...gpuTime.callbacks]).toEqual([...result.trace.measured.slice(0, result.trace.length).keys()].filter((i) => result.trace.measured[i]));
      expect(gpuTime.simulationMs?.median).toBe(2);
      expect(gpuTime.totalMs?.median).toBe(4);
      expect([gpuTime.skippedRingFull, gpuTime.discardedDisjoint, gpuTime.lostAtEnd]).toEqual([0, 0, 0]);
      expect(callsTo(calls, "deleteQuery")).toHaveLength(callsTo(calls, "createQuery").length);
      // Queries go to the raw context, so the GPU still counts no buffer uploads.
      if (backend === "gpu") expect(result.timing.uploadedBytes).toBe(0);
    }
  });

  it("collects results that arrive only after timing, before validation", async () => {
    const ready = { ready: false };
    const { state } = timedPage(ready);
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) state.callback?.(now);
    ready.ready = true;
    const result = await run;
    const gpuTime = result.timing.gpuTime as Exclude<typeof result.timing.gpuTime, string>;
    // The zero-dt first callback is measured but submits no GPU work, so it is not timed.
    expect(result.timing.callbacks).toBe(3);
    expect([gpuTime.measuredSteps, gpuTime.samples, gpuTime.lostAtEnd]).toEqual([2, 2, 0]);
  });

  it("discloses an opt-out or a missing extension and never relabels submission time", async () => {
    const optOut = timedPage({ ready: true });
    let run = runGpuBenchmark({ backend: "gpu", gpuTiming: false, refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) optOut.state.callback?.(now);
    let result = await run;
    expect(result.metadata.gpuTiming).toBe("disabled (gpuTiming: false)");
    expect(result.timing.gpuTime).toBe("disabled (gpuTiming: false)");
    expect(callsTo(optOut.calls, "createQuery")).toEqual([]);

    const missing = stubPage();
    run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) missing.state.callback?.(now);
    result = await run;
    expect(result.timing.gpuTime).toBe("unavailable: EXT_disjoint_timer_query_webgl2 not supported");
  });

  it("keeps query calls out of the simulation and submission spans and the budget's input", async () => {
    // Each query call takes 100 ms of fake time; everything else takes none.
    let clock = 0;
    const slow = () => { clock += 100; };
    const page = stubPage({ overrides: {
      getExtension: (name) => (name === "EXT_disjoint_timer_query_webgl2" ? EXT : null),
      getQueryParameter: (_query, pname) => (pname === "QUERY_RESULT_AVAILABLE" ? true : 2e6),
      getParameter: (name) => (name === "GPU_DISJOINT_EXT" ? false : "test renderer"),
      beginQuery: slow, endQuery: slow,
    } });
    vi.stubGlobal("performance", { now: () => clock });
    const update = vi.spyOn(ParticleBudget.prototype, "update");
    const run = runGpuBenchmark({ budget: "adaptive", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) page.state.callback?.(now);
    const result = await run;
    expect((result.timing.gpuTime as { samples: number }).samples).toBe(2);
    expect(result.timing.simulationMs.p99).toBe(0);
    expect(result.timing.submissionMs.p99).toBe(0);
    // Callback work still includes the four query calls of each timed step.
    expect(result.timing.callbackMs.p99).toBe(400);
    expect(update.mock.calls.map(([, , work]) => work)).toEqual([0, 0]);
    update.mockRestore();
  });

  it("allocates every non-GL array before creating queries or GPU resources", async () => {
    const { calls, state } = timedPage({ ready: true });
    // An oversized schedule cannot be allocated; the failure must leave no query or buffer behind and the page usable.
    await expect(runGpuBenchmark({ budget: "adaptive", scheduleCapacity: 2 ** 40, refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(RangeError);
    await expect(runGpuBenchmark({ backend: "gpu", traceCapacity: 2 ** 40, refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(RangeError);
    expect(callsTo(calls, "createQuery")).toEqual([]);
    expect(callsTo(calls, "createBuffer")).toEqual([]);
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 0.05, crossValidate: false });
    for (const now of [0, 20, 40, 60]) state.callback?.(now);
    expect((await run).validation.finalStateMatches).toBe(true);
  });

  it("fails the run, releasing the GPU replay, when the queries cannot be created", async () => {
    const { calls } = stubPage({ overrides: {
      getExtension: (name) => (name === "EXT_disjoint_timer_query_webgl2" ? EXT : null), createQuery: () => null,
    } });
    await expect(runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/GPU timer queries failed.*run invalid/);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("ends an active query and releases the queries when a timed run fails", async () => {
    const { calls, state } = timedPage({ ready: false });
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0, measureSeconds: 1 });
    state.callback?.(0);
    state.callback?.(20);
    state.lost?.();
    await expect(run).rejects.toThrow(/context lost/);
    expect(callsTo(calls, "deleteQuery")).toHaveLength(callsTo(calls, "createQuery").length);
  });
});
