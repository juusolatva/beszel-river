import { afterEach, describe, expect, it, vi } from "vitest";
import { callsTo, createFakeGl } from "./fake-gl";
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
  await expect(runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/Reload/);
  // CPU runs replay the trace through the GPU too, untimed.
  expect(result.validation.cpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
  expect(result.validation.gpu).toEqual(expect.objectContaining({ counts: expect.any(Uint32Array) }));
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
  return { ...fake, state };
}

describe("GPU backend", () => {
  it("draws from GPU state on the recorded schedule and validates both backends untimed", async () => {
    const { calls, state } = stubPage();
    const run = runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 1, measureSeconds: 0.05, crossValidate: false });
    for (let now = 0; now <= 1100; now += 20) state.callback?.(now);
    const result = await run;
    expect(result.metadata.backend).toBe("gpu");
    expect(result.timing.drawCapacity).toBe(10000);
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
    // crossValidate: false skips the CPU replay of a GPU run.
    expect(result.validation.cpu).toEqual({ unavailable: "crossValidate: false" });
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

  it("needs warmup for the drawer's first draw and rejects unknown backends", async () => {
    stubPage();
    await expect(runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture", warmupSeconds: 0 })).rejects.toThrow(/warmup/);
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
