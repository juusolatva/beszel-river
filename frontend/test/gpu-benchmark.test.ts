import { afterEach, expect, it, vi } from "vitest";
import { createFakeGl } from "./fake-gl";
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
  await expect(runGpuBenchmark({ refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/Reload/);
  await expect(runGpuBenchmark({ backend: "gpu", refreshHz: 60, conditions: "unit fixture" })).rejects.toThrow(/not implemented/);
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
