import type { runGpuBenchmark } from "../gpu-benchmark.browser";
import { GPU_DRAIN_SECONDS } from "../../src/sim/gpu-lifecycle";
import { REPLAY_CAPACITY, type RecordedSchedule, type ReplayScenario, type ReplayTrace } from "./gpu-replay";

export type Viewport = "960x640" | "full";
export type Backend = "cpu" | "gpu";
/** Fixed-limit workloads of the paired comparison (GPU plan, Task 1 and Task 6). */
export const WORKLOADS = ["dense-10000", "dense-8000", "dense-2500", "dense-1000", "drop-2500", "draining", "drained", "rotation"] as const;
export type Workload = (typeof WORKLOADS)[number];
/** Spawn limits a fixed-limit run accepts. */
export const REPLAY_LIMITS = [10000, 8000, 2500, 1000] as const;
export type ReplayLimit = (typeof REPLAY_LIMITS)[number];
/**
 * The workloads the setup form starts with: Task 6's matrix. `dense-2500`, where the phone's adaptive
 * budget settles, came later for the active-horizon runs and is opt-in, so the default plan stays 86 runs.
 */
export const DEFAULT_WORKLOADS: readonly Workload[] = WORKLOADS.filter((workload) => workload !== "dense-2500" && workload !== "drop-2500");

/**
 * `drop-2500`: the full pool, then a budget drop to 2,500 (brightness ×2, as `ParticleBudget` sets it)
 * 15 s in, replayed like a recorded schedule. The page's budget starts at the full pool, so slots above
 * a lowered limit hold particles that fixed-limit runs never create; measuring waits until every
 * particle from before the drop has died (`DROP_SETTLE_SECONDS`).
 */
/**
 * Simulated seconds before a `drop-2500` run may measure: the drop plus the drain deadline, by which
 * every particle born before it has died. Below 10 fps callbacks fall behind wall time, so the 30 s
 * warmup alone would not reach it.
 */
export const DROP_SETTLE_SECONDS = 15 + GPU_DRAIN_SECONDS;

export const DROP_SCHEDULE: RecordedSchedule = {
  runId: "synthetic-drop-2500",
  scenario: "dense",
  motion: 1,
  decisions: [{ time: 0, limit: 10000, intensity: 1 }, { time: 15, limit: 2500, intensity: 2 }],
};

export interface SequenceConfig {
  viewports: Viewport[];
  workloads: Workload[];
  /** Paired repetitions per workload; the backend order alternates between them. */
  repetitions: number;
  /** A CPU adaptive discovery per viewport, then CPU-schedule replays on both backends. */
  scheduleReplays: boolean;
  /**
   * CPU runs only, without their untimed GPU replay: for comparing CPU changes between commits.
   * Absent in sequences stored before it existed, which ran both backends.
   */
  cpuOnly?: boolean;
  warmupSeconds: number;
  measureSeconds: number;
}

export interface RunSpec {
  /** Position in the plan, stable across reloads. */
  index: number;
  viewport: Viewport;
  kind: "fixed" | "discovery" | "schedule" | "drop";
  workload: Workload | "discovery" | "schedule-replay";
  backend: Backend;
  repetition: number;
  scenario: ReplayScenario;
  limit: ReplayLimit;
}

const SCENARIO: Record<Workload, [ReplayScenario, ReplayLimit]> = {
  "dense-10000": ["dense", 10000], "dense-8000": ["dense", 8000], "dense-2500": ["dense", 2500], "dense-1000": ["dense", 1000], "drop-2500": ["dense", 10000],
  draining: ["draining", 10000], drained: ["drained", 10000], rotation: ["rotation", 10000],
};

/** Backend order for a repetition: CPU first on odd repetitions, GPU first on even ones. */
export function backendOrder(repetition: number): Backend[] {
  return repetition % 2 === 1 ? ["cpu", "gpu"] : ["gpu", "cpu"];
}

function backends(config: SequenceConfig, repetition: number): Backend[] {
  return config.cpuOnly ? ["cpu"] : backendOrder(repetition);
}

/**
 * The run order: viewports one after another (switching to full screen needs the person), each
 * starting with the CPU adaptive discovery its replays need, then every workload per repetition as a
 * CPU/GPU pair in alternating order, then the CPU-schedule replay pairs.
 */
export function buildRunPlan(config: SequenceConfig): RunSpec[] {
  if (!config.viewports.length || (!config.workloads.length && !config.scheduleReplays)) throw new Error("Choose at least one viewport and workload");
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) throw new Error("Repetitions must be a positive integer");
  const plan: RunSpec[] = [];
  const add = (spec: Omit<RunSpec, "index">) => plan.push({ index: plan.length, ...spec });
  for (const viewport of config.viewports) {
    if (config.scheduleReplays) add({ viewport, kind: "discovery", workload: "discovery", backend: "cpu", repetition: 1, scenario: "dense", limit: 10000 });
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      for (const workload of config.workloads) {
        const [scenario, limit] = SCENARIO[workload];
        const kind = workload === "drop-2500" ? "drop" : "fixed";
        for (const backend of backends(config, repetition)) add({ viewport, kind, workload, backend, repetition, scenario, limit });
      }
    }
    if (config.scheduleReplays) {
      for (let repetition = 1; repetition <= config.repetitions; repetition++) {
        for (const backend of backends(config, repetition)) add({ viewport, kind: "schedule", workload: "schedule-replay", backend, repetition, scenario: "dense", limit: 10000 });
      }
    }
  }
  return plan;
}

/** Rough minutes for a plan: warmup and measurement plus an allowance for the untimed validation replays. */
export function estimateMinutes(plan: RunSpec[], config: Pick<SequenceConfig, "warmupSeconds" | "measureSeconds">, validationSeconds = 30): number {
  let seconds = 0;
  for (const spec of plan) seconds += (spec.scenario === "drained" ? Math.max(60, config.warmupSeconds) : config.warmupSeconds) + config.measureSeconds + validationSeconds + 5;
  return Math.round(seconds / 60);
}

/** Simulation time after each callback. */
function endTimes(trace: ReplayTrace): Float64Array {
  const times = new Float64Array(trace.length);
  let time = 0;
  for (let i = 0; i < trace.length; i++) times[i] = time += trace.dt[i];
  return times;
}

/** Live count at each whole simulated second (the last callback ending at or before it), for draining and rotation curves. */
export function occupancyCurve(trace: ReplayTrace, counts: Uint32Array): number[] {
  const times = endTimes(trace);
  const curve: number[] = [];
  const total = trace.length ? times[trace.length - 1] : 0;
  // Float32 steps sum with rounding (ten Float32(0.1) steps end at 1.0000000149 s).
  const tolerance = 1e-6;
  let i = 0;
  for (let second = 1; second <= total + tolerance; second++) {
    while (i + 1 < trace.length && times[i + 1] <= second + tolerance) i++;
    curve.push(counts[i]);
  }
  return curve;
}

/** Simulated seconds from `from` until the count first reaches zero and stays there, or null. */
export function timeToZero(trace: ReplayTrace, counts: Uint32Array, from: number): number | null {
  const times = endTimes(trace);
  let zeroAt: number | null = null;
  for (let i = 0; i < trace.length; i++) {
    if (times[i] < from) continue;
    if (counts[i] === 0) zeroAt ??= times[i] - from;
    else zeroAt = null;
  }
  return zeroAt;
}

type BenchmarkResult = Awaited<ReturnType<typeof runGpuBenchmark>>;
type Validation = BenchmarkResult["validation"]["cpu"];

/** Where the river is removed in each scenario, s of simulation time (`replayFrameIndex`). */
const REMOVAL: Partial<Record<ReplayScenario, number>> = { draining: 30, drained: 30, rotation: 70 };

/** Device facts the page can read at the start of a run; null where the browser does not say. */
export interface RunEnvironment {
  startedAt: string;
  battery: { charging: boolean; level: number } | null;
  memory: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null;
}

/**
 * A compact, JSON-safe summary of one run: what the ledger needs, without the trace or per-callback
 * arrays. Draining, drained and rotation runs keep per-second occupancy curves and time to zero.
 */
export function summarizeRun(spec: RunSpec, result: BenchmarkResult, environment: RunEnvironment) {
  const { metadata, timing, validation, trace } = result;
  const occupancy = (check: Validation) => {
    if ("unavailable" in check) return { unavailable: check.unavailable };
    const curves = spec.scenario === "draining" || spec.scenario === "drained" || spec.scenario === "rotation";
    const removal = REMOVAL[spec.scenario];
    return { ...check.occupancy, curve: curves ? occupancyCurve(trace, check.counts) : undefined,
      timeToZeroAfterRemoval: removal === undefined ? undefined : timeToZero(trace, check.counts, removal) };
  };
  const parity = validation.parity;
  const gpuTime = typeof timing.gpuTime === "string" ? timing.gpuTime : (({ callbacks: _callbacks, ...rest }) => rest)(timing.gpuTime);
  return {
    spec, ok: true as const, runId: result.runId, ...environment,
    metadata,
    timing: { ...timing, gpuTime },
    occupancy: { cpu: occupancy(validation.cpu), gpu: occupancy(validation.gpu) },
    parity: "unavailable" in parity ? parity : { rule: parity.rule, gated: parity.gated, passed: parity.passed, windows: parity.windows.length,
      failedWindows: parity.windows.filter((window) => !window.pass).length,
      maxStreamsOutsideBound: parity.windows.reduce((max, window) => Math.max(max, window.streamsOutsideBound), 0),
      nonzeroCallbacks: "nonzeroCallbacks" in parity ? parity.nonzeroCallbacks : undefined },
    finalStateMatches: validation.finalStateMatches,
    /** The limit and brightness changes the run applied, with their callbacks and simulation times. */
    decisions: result.decisions,
    scheduleApplied: result.scheduleApplied,
  };
}

export type RunSummary = ReturnType<typeof summarizeRun>;
/** A run that threw: kept so the summary shows it, and so it can be retried. */
export interface FailedRun { spec: RunSpec; ok: false; error: string; startedAt: string }

const fmt = (value: number | undefined | null, digits = 2) => (value === undefined || value === null || !Number.isFinite(value) ? "–" : value.toFixed(digits));
/** Median and range of one statistic across repetitions; an even count averages the middle two. */
function spread(values: number[]): string {
  if (!values.length) return "–";
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted.length === 1 ? fmt(median) : `${fmt(median)} (${fmt(sorted[0])}–${fmt(sorted[sorted.length - 1])})`;
}

/**
 * Result-ledger rows in the GPU plan's column order, one per viewport, workload and backend: each
 * statistic is the median across repetitions with its range in brackets, so run-to-run variation
 * shows next to every comparison. Failed runs are listed separately.
 */
export function ledgerMarkdown(results: (RunSummary | FailedRun)[], commit: string): string {
  const ok = results.filter((result): result is RunSummary => result.ok);
  const groups = new Map<string, RunSummary[]>();
  for (const result of ok) {
    const key = `${result.spec.viewport}|${result.spec.workload}|${result.spec.backend}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const lines = [
    "| Variant / commit | Device / power / browser | Replay / viewport / DPR / capacity / limit | Callback median / p95 / p99 | Frame intervals / missed periods | Validated live min/mean/max / simulated slots / draw capacity / trace ID | GPU / memory / power | Decision / occupancy parity |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const runs of groups.values()) {
    const { spec, metadata } = runs[0];
    const own = (run: RunSummary) => run.occupancy[spec.backend];
    const live = (pick: (o: { min: number; simulationMean: number; max: number }) => number) =>
      spread(runs.flatMap((run) => { const o = own(run); return "unavailable" in o ? [] : [pick(o)]; }));
    const gpu = runs.flatMap((run) => (typeof run.timing.gpuTime === "string" || !run.timing.gpuTime.totalMs ? [] : [run.timing.gpuTime.totalMs.median]));
    const charging = [...new Set(runs.map((run) => (run.battery ? (run.battery.charging ? "AC" : "battery") : "unknown")))].join("/");
    const parity = runs.map((run) => ("unavailable" in run.parity ? "n/a" : run.parity.passed === null ? "not gated" : run.parity.passed ? "pass" : "FAIL"));
    lines.push(`| ${spec.backend.toUpperCase()} / ${commit || "?"} | ${metadata.conditions}; ${metadata.renderer}; ${metadata.targetFormat} | ${spec.workload} / ${metadata.width}×${metadata.height} / ${fmt(metadata.pixelRatio)} / ${REPLAY_CAPACITY} / ${metadata.limit}; ${metadata.budget}; ${runs.length} run(s) | ${spread(runs.map((run) => run.timing.callbackMs.median))} / ${spread(runs.map((run) => run.timing.callbackMs.p95))} / ${spread(runs.map((run) => run.timing.callbackMs.p99))} ms | median ${spread(runs.map((run) => run.timing.intervalMs.median))} ms, p95 ${spread(runs.map((run) => run.timing.intervalMs.p95))} ms / ${spread(runs.map((run) => run.timing.missedPeriods))} | ${live((o) => o.min)} / ${live((o) => o.simulationMean)} / ${live((o) => o.max)} / ${runs[0].timing.simulatedSlotsPerPositiveStep} / ${runs[0].timing.drawCapacity} / ${runs.map((run) => run.runId.slice(0, 8)).join(", ")} | ${gpu.length ? `GPU ${spread(gpu)} ms` : String(typeof runs[0].timing.gpuTime === "string" ? runs[0].timing.gpuTime : "no GPU samples")} / heap ${spread(runs.flatMap((run) => (run.memory ? [run.memory.usedJSHeapSize / 2 ** 20] : [])))} MiB / ${charging} | Pending / ${parity.join(", ")} |`);
  }
  const failed = results.filter((result): result is FailedRun => !result.ok);
  if (failed.length) {
    lines.push("", "Failed runs:");
    for (const run of failed) lines.push(`- #${run.spec.index} ${run.spec.viewport} ${run.spec.workload} ${run.spec.backend} rep ${run.spec.repetition}: ${run.error}`);
  }
  return lines.join("\n");
}
