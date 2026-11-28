import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { REPLAY_CAPACITY, ReplayTrace } from "./fixtures/gpu-replay";
import { backendOrder, buildRunPlan, DEFAULT_WORKLOADS, DROP_SCHEDULE, DROP_SETTLE_SECONDS, estimateMinutes, REPLAY_LIMITS, ledgerMarkdown, occupancyCurve, summarizeRun, timeToZero, WORKLOADS,
  type FailedRun, type RunSpec, type SequenceConfig } from "./fixtures/run-sequence";

const CONFIG: SequenceConfig = { viewports: ["960x640", "full"], workloads: [...DEFAULT_WORKLOADS], repetitions: 3, scheduleReplays: true, warmupSeconds: 30, measureSeconds: 60 };

/** `seconds` of 0.1 s steps (the clamp) after a zero first callback, with counts from `count(time after the step)`. */
function trace(seconds: number, count: (time: number) => number) {
  const t = new ReplayTrace(seconds * 10 + 1);
  t.append(0, 2, 960, 640, 1, 1, false, REPLAY_CAPACITY, 1, false);
  for (let k = 0; k < seconds * 10; k++) t.append(0.1, 2, 960, 640, 1, 1, false, REPLAY_CAPACITY, 1, true);
  const counts = new Uint32Array(t.length);
  let time = 0;
  for (let i = 0; i < t.length; i++) counts[i] = count(time += t.dt[i]);
  return { trace: t, counts };
}

describe("run plan", () => {
  it("pairs every workload per repetition with alternating backend order, discovery first and replays last", () => {
    expect(backendOrder(1)).toEqual(["cpu", "gpu"]);
    expect(backendOrder(2)).toEqual(["gpu", "cpu"]);
    const plan = buildRunPlan(CONFIG);
    // Per viewport: 1 discovery + 6 workloads × 3 repetitions × 2 backends + 3 replay pairs.
    expect(plan).toHaveLength(2 * (1 + 36 + 6));
    expect(plan.map((spec) => spec.index)).toEqual(plan.map((_, k) => k));
    const small = plan.filter((spec) => spec.viewport === "960x640");
    expect(plan.slice(0, small.length)).toEqual(small);
    expect(small[0]).toEqual(expect.objectContaining({ kind: "discovery", backend: "cpu", scenario: "dense" }));
    expect(small.slice(1, 5).map(({ workload, backend, repetition }) => [workload, backend, repetition])).toEqual([
      ["dense-10000", "cpu", 1], ["dense-10000", "gpu", 1], ["dense-8000", "cpu", 1], ["dense-8000", "gpu", 1],
    ]);
    expect(small.find((spec) => spec.repetition === 2)).toEqual(expect.objectContaining({ workload: "dense-10000", backend: "gpu" }));
    expect(small.filter((spec) => spec.kind === "schedule").map(({ backend, repetition }) => [backend, repetition])).toEqual([
      ["cpu", 1], ["gpu", 1], ["gpu", 2], ["cpu", 2], ["cpu", 3], ["gpu", 3],
    ]);
    expect(small.find((spec) => spec.workload === "dense-1000")).toEqual(expect.objectContaining({ scenario: "dense", limit: 1000 }));
    expect(small.find((spec) => spec.workload === "rotation")).toEqual(expect.objectContaining({ scenario: "rotation", limit: 10000 }));
  });

  it("offers dense-2500 as an opt-in workload outside the default 86-run plan", () => {
    expect(WORKLOADS).toContain("dense-2500");
    expect(DEFAULT_WORKLOADS).toEqual(["dense-10000", "dense-8000", "dense-1000", "draining", "drained", "rotation"]);
    expect(buildRunPlan(CONFIG)).toHaveLength(86);
    const plan = buildRunPlan({ ...CONFIG, viewports: ["full"], workloads: ["dense-2500", "drained"], repetitions: 3, scheduleReplays: false });
    expect(plan.filter((spec) => spec.workload === "dense-2500")).toHaveLength(6);
    expect(plan.find((spec) => spec.workload === "dense-2500")).toEqual(expect.objectContaining({ kind: "fixed", scenario: "dense", limit: 2500 }));
    // Every workload's limit is one the benchmark accepts.
    expect(buildRunPlan({ ...CONFIG, workloads: [...WORKLOADS] }).every((spec) => REPLAY_LIMITS.includes(spec.limit))).toBe(true);
  });

  it("offers drop-2500 as an opt-in schedule replay from the full pool to 2,500", () => {
    expect(DEFAULT_WORKLOADS).not.toContain("drop-2500");
    const plan = buildRunPlan({ ...CONFIG, viewports: ["full"], workloads: ["drop-2500"], repetitions: 2, scheduleReplays: false, cpuOnly: true });
    expect(plan.map(({ kind, workload, backend, limit }) => [kind, workload, backend, limit])).toEqual([["drop", "drop-2500", "cpu", 10000], ["drop", "drop-2500", "cpu", 10000]]);
    // The drop lands 15 s in; measuring waits a drain deadline (longest life plus a step) beyond it.
    expect(DROP_SCHEDULE.decisions).toEqual([{ time: 0, limit: 10000, intensity: 1 }, { time: 15, limit: 2500, intensity: 2 }]);
    expect(DROP_SETTLE_SECONDS - DROP_SCHEDULE.decisions[1].time).toBeGreaterThan(LOOK.lifeRange[1]);
  });

  it("runs only the CPU, once per repetition, when asked", () => {
    const plan = buildRunPlan({ ...CONFIG, viewports: ["full"], cpuOnly: true });
    // 1 discovery + 6 workloads × 3 repetitions + 3 replays.
    expect(plan).toHaveLength(1 + 18 + 3);
    expect(plan.every((spec) => spec.backend === "cpu")).toBe(true);
    expect(plan.filter((spec) => spec.workload === "dense-1000").map((spec) => spec.repetition)).toEqual([1, 2, 3]);
  });

  it("builds subsets and rejects empty or invalid plans", () => {
    expect(buildRunPlan({ ...CONFIG, viewports: ["full"], workloads: ["dense-10000"], repetitions: 1, scheduleReplays: false })).toHaveLength(2);
    expect(buildRunPlan({ ...CONFIG, workloads: [], viewports: ["full"], repetitions: 1 }).map((spec) => spec.kind)).toEqual(["discovery", "schedule", "schedule"]);
    expect(() => buildRunPlan({ ...CONFIG, viewports: [] })).toThrow(/at least one/);
    expect(() => buildRunPlan({ ...CONFIG, workloads: [], scheduleReplays: false })).toThrow(/at least one/);
    expect(() => buildRunPlan({ ...CONFIG, repetitions: 0 })).toThrow(/positive integer/);
  });

  it("estimates time with the drained warmup and a validation allowance", () => {
    const plan = buildRunPlan({ ...CONFIG, viewports: ["full"], workloads: ["dense-10000", "drained"], repetitions: 1, scheduleReplays: false });
    // (30 + 60 + 30 + 5) × 2 + (60 + 60 + 30 + 5) × 2 = 560 s.
    expect(estimateMinutes(plan, CONFIG)).toBe(9);
  });
});

describe("occupancy curves", () => {
  it("samples the live count at each whole simulated second", () => {
    const { trace: t, counts } = trace(4, (time) => time * 10);
    expect(occupancyCurve(t, counts)).toEqual([10, 20, 30, 40]);
    expect(occupancyCurve(new ReplayTrace(0), new Uint32Array(0))).toEqual([]);
  });

  it("measures time from removal until the count reaches zero and stays there", () => {
    // Thresholds sit between steps: Float32 step sums land just past whole seconds.
    const { trace: t, counts } = trace(10, (time) => (time < 6.05 ? 100 : time < 7.05 ? 0 : time < 8.05 ? 5 : 0));
    expect(timeToZero(t, counts, 4)).toBeCloseTo(4.1, 5);
    const { trace: never, counts: busy } = trace(4, () => 1);
    expect(timeToZero(never, busy, 1)).toBeNull();
  });
});

describe("run summaries and ledger", () => {
  const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({ index: 0, viewport: "full", kind: "fixed", workload: "draining", backend: "gpu", repetition: 1, scenario: "draining", limit: 10000, ...overrides });
  /** A result shaped like `runGpuBenchmark`'s, with only what summaries read. */
  function result(runId: string, callbackMedian: number, parityPassed: boolean | null, gpuTime: unknown = "unavailable: EXT_disjoint_timer_query_webgl2 not supported") {
    const { trace: t, counts } = trace(40, (time) => (time < 29.5 ? 500 : time < 34.5 ? 100 : 0));
    const check = { counts, perSlot: new Uint32Array(t.length * 32), occupancy: { min: 0, max: 500, simulationMean: 300, wallMean: 290 } };
    return {
      runId,
      metadata: { conditions: "X280, battery", renderer: "Intel", targetFormat: "RGBA16F", width: 1920, height: 1080, pixelRatio: 1.25, limit: 10000, budget: "fixed limit" },
      timing: { callbacks: 3600, callbackMs: { median: callbackMedian, p95: callbackMedian + 2, p99: callbackMedian + 4 }, intervalMs: { median: 16.7, p95: 17.5, p99: 18 },
        missedPeriods: 3, simulatedSlotsPerPositiveStep: 10000, drawCapacity: 10000, gpuTime },
      validation: { finalStateMatches: true, cpu: check, gpu: check,
        parity: { rule: "draining", gated: parityPassed !== null, passed: parityPassed, windows: [{ pass: parityPassed !== false, streamsOutsideBound: 2 }] } },
      trace: t,
      decisions: [{ callback: 0, time: 0, limit: 10000, intensity: 1 }],
      scheduleApplied: undefined,
    } as unknown as Parameters<typeof summarizeRun>[1];
  }
  const env = { startedAt: "2026-11-16T08:00:00Z", battery: { charging: false, level: 0.8 }, memory: { usedJSHeapSize: 64 * 2 ** 20, totalJSHeapSize: 0, jsHeapSizeLimit: 0 } };

  it("keeps what the ledger needs, curves and time to zero, without traces or per-callback arrays", () => {
    const summary = summarizeRun(spec(), result("abcdef123456", 7, null, { samples: 3, totalMs: { median: 4, p95: 5, p99: 6 }, callbacks: new Uint32Array(3) }), env);
    expect(summary).toEqual(expect.objectContaining({ ok: true, runId: "abcdef123456", battery: env.battery, finalStateMatches: true }));
    expect(summary.decisions).toEqual([{ callback: 0, time: 0, limit: 10000, intensity: 1 }]);
    expect(summary.timing.gpuTime).toEqual({ samples: 3, totalMs: { median: 4, p95: 5, p99: 6 } });
    const gpu = summary.occupancy.gpu as { curve: number[]; timeToZeroAfterRemoval: number | null; simulationMean: number };
    expect(gpu.curve).toHaveLength(40);
    // Seconds 29–36: removal shows at 30, zero from 35.
    expect(gpu.curve.slice(28, 36)).toEqual([500, 100, 100, 100, 100, 100, 0, 0]);
    expect(gpu.timeToZeroAfterRemoval).toBeCloseTo(4.5, 5);
    expect(summary.parity).toEqual(expect.objectContaining({ gated: false, passed: null, windows: 1, failedWindows: 0, maxStreamsOutsideBound: 2 }));
    expect(JSON.parse(JSON.stringify(summary))).not.toHaveProperty("trace");
    // Dense runs keep no curve; unavailable replays and parity pass through.
    const dense = summarizeRun(spec({ workload: "dense-10000", scenario: "dense" }), result("x", 7, true), { ...env, battery: null, memory: null });
    expect((dense.occupancy.gpu as { curve?: number[] }).curve).toBeUndefined();
    const missing = result("y", 7, true);
    missing.validation.gpu = { unavailable: "crossValidate: false" };
    missing.validation.parity = { unavailable: "crossValidate: false" };
    const partial = summarizeRun(spec(), missing, env);
    expect(partial.occupancy.gpu).toEqual({ unavailable: "crossValidate: false" });
    expect(partial.parity).toEqual({ unavailable: "crossValidate: false" });
  });

  it("groups repetitions into ledger rows with medians and ranges, and lists failures", () => {
    const runs = [7, 9, 8].map((median, k) => summarizeRun(spec({ repetition: k + 1, workload: "dense-10000", scenario: "dense" }),
      result(`run${k}aaaaaaaa`, median, k !== 1, { samples: 1, totalMs: { median: 3 + k, p95: 0, p99: 0 } }), env));
    const cpuResult = result("cpurun00", 12, true);
    Object.assign(cpuResult.timing, { simulatedSlotsPerPositiveStep: "drawCount (highest live slot + 1)", drawCapacity: "drawCount (highest live slot + 1)" });
    const cpu = summarizeRun(spec({ backend: "cpu", workload: "dense-10000", scenario: "dense" }), cpuResult, { ...env, battery: null, memory: null });
    const failed: FailedRun = { spec: spec({ index: 9, backend: "cpu" }), ok: false, error: "Error: Hidden tab: run invalid", startedAt: env.startedAt };
    const ledger = ledgerMarkdown([...runs, cpu, failed], "abc1234").split("\n");
    expect(ledger[0]).toMatch(/^\| Variant \/ commit \| Device \/ power \/ browser \|/);
    expect(ledger).toHaveLength(2 + 2 + 3);
    expect(ledger[2]).toContain("| GPU / abc1234 |");
    expect(ledger[2]).toContain("dense-10000 / 1920×1080 / 1.25 / 10000 / 10000; fixed limit; 3 run(s)");
    expect(ledger[2]).toContain("| 8.00 (7.00–9.00) / 10.00 (9.00–11.00) / 12.00 (11.00–13.00) ms |");
    expect(ledger[2]).toContain("GPU 4.00 (3.00–5.00) ms / heap 64.00 (64.00–64.00) MiB / battery");
    expect(ledger[2]).toContain("run0aaaa, run1aaaa, run2aaaa");
    expect(ledger[2]).toContain("| Pending / pass, FAIL, pass |");
    expect(ledger[3]).toContain("| CPU / abc1234 |");
    expect(ledger[2]).toContain(" / 10000 / 10000 / run0aaaa");
    expect(ledger[3]).toContain(" / drawCount (highest live slot + 1) / drawCount (highest live slot + 1) / cpurun00");
    expect(ledger[3]).toContain("unavailable: EXT_disjoint_timer_query_webgl2 not supported / heap – MiB / unknown");
    expect(ledger.slice(5)).toEqual(["Failed runs:", "- #9 full draining cpu rep 1: Error: Hidden tab: run invalid"]);
    expect(ledgerMarkdown([], "")).not.toContain("Failed runs");
    // Two repetitions: the median averages them.
    expect(ledgerMarkdown(runs.slice(0, 2), "abc1234")).toContain("| 8.00 (7.00–9.00) / 10.00 (9.00–11.00) / 12.00 (11.00–13.00) ms |");
  });
});
