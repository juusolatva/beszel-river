import { describe, expect, it } from "vitest";
import lifecycle from "../../docs/experiments/2026-11-13-gpu-lifecycle.json";
import investigation from "../../docs/experiments/2026-11-13-gpu-occupancy.json";
import { gaussian, hashString, mulberry32 } from "../src/util/math";
import { evaluateCalibration, evaluateGate, GATE_SEEDS, runGate, validateRuns, type GateGroup } from "./fixtures/occupancy-gate";
import { runCpuOccupancy, type OccupancyRun } from "./fixtures/occupancy-runs";
import { OCCUPANCY_SCENARIOS, SERIES, WINDOWS, type OccupancyScenario } from "./fixtures/occupancy-scenario";

/** Retained means for one scenario in the runner's layout. */
function retained<T extends { start: number; slot: number }>(rows: readonly T[], value: (row: T) => number) {
  const starts = [...new Set(rows.map((r) => r.start))].sort((a, b) => a - b);
  const means = new Array<number>(starts.length * SERIES);
  for (const row of rows) means[starts.indexOf(row.start) * SERIES + row.slot + 1] = value(row);
  return { starts, means };
}

// Each run simulates 60 s of a saturated 10,000-particle pool; slow machines need more than 5 s under coverage.
const TIMEOUT = 20_000;

describe("occupancy gate CPU runs", () => {
  it.each<[OccupancyScenario, number, "cpu" | "control"]>([
    ["occupancy", 42, "cpu"], ["filaments", 42, "cpu"], ["occupancy", 43, "control"],
  ])("reproduce the retained Task 3 %s means for seed %i exactly", (scenario, seed, column) => {
    // The retained runs shared one flow field, seeded 42.
    const run = runCpuOccupancy(scenario, seed, false, 42);
    const expected = retained(lifecycle.windows.filter((w) => w.scenario === scenario), (w) => w[column]);
    expect(run.means).toHaveLength(WINDOWS * SERIES);
    expect(run.starts).toEqual(expected.starts);
    expect(run.means).toEqual(expected.means);
  }, TIMEOUT);

  it("reproduces the investigation's PCG-keyed matched control exactly", () => {
    const run = runCpuOccupancy("occupancy", 42, true);
    const rows = investigation.results.find((r) => r.scenario === "occupancy")!.windows;
    expect(run.means).toEqual(retained(rows, (w) => w.matched).means);
  }, TIMEOUT);
});

const STARTS = [10.000000149011612, 25.00000037252903, 45.000000670552254, 50.00000074505806, 55.000000819563866];
const BUSY = 8, BUSY_MEAN = 416;

interface Synthetic {
  /** Run-to-run standard deviation of busy slots, per group. */
  spread?: Partial<Record<GateGroup, number>>;
  /** Added to GPU means at window-major index `window * SERIES + slot + 1`; the total follows its slots. */
  gpuShift?: (window: number, slot: number) => number;
}

/**
 * One synthetic run: eight busy slots whose noise cancels in pairs, so the total of a saturated pool
 * stays constant, as in the real fixture's later windows; the other slots stay empty.
 */
function syntheticRun(scenario: OccupancyScenario, group: GateGroup, seed: number, options: Synthetic = {}): Omit<OccupancyRun, "group"> {
  const random = mulberry32(Math.floor(hashString(`${scenario}/${group}/${seed}`) * 2 ** 32));
  const spread = options.spread?.[group] ?? 8.5;
  const means: number[] = [];
  for (let w = 0; w < WINDOWS; w++) {
    const slots = new Array<number>(32).fill(0);
    for (let s = 0; s < BUSY; s += 2) {
      const noise = gaussian(random) * spread;
      slots[s] = BUSY_MEAN + noise;
      slots[s + 1] = BUSY_MEAN - noise;
    }
    if (group === "gpu" && options.gpuShift) for (let s = 0; s < 32; s++) slots[s] += options.gpuShift(w, s);
    means.push(slots.reduce((sum, v) => sum + v, 0), ...slots);
  }
  return { scenario, seed, starts: [...STARTS], means };
}

function syntheticRuns(options: Synthetic = {}, groups: readonly GateGroup[] = ["cpu", "calibration", "pcg", "gpu"]): OccupancyRun[] {
  return OCCUPANCY_SCENARIOS.flatMap((scenario) => groups.flatMap((group) =>
    GATE_SEEDS[group].map((seed) => ({ ...syntheticRun(scenario, group, seed, options), group }))));
}

describe("occupancy gate statistic", () => {
  it("passes matching distributions with 330 comparisons and enough sensitivity", () => {
    const { summary } = evaluateGate(syntheticRuns());
    expect(summary.comparisons).toBe(330);
    expect(summary.calibration.passed).toBe(true);
    expect(summary.calibration.medianDetectableShare.calibration).toBeLessThan(0.05);
    expect(summary.calibration.medianDetectableShare.pcg).toBeLessThan(0.05);
    expect(summary.gpuFailures).toBe(0);
    expect(summary.gatePassed).toBe(true);
  });

  it("fails a 10 % bias in one busy slot of one window", () => {
    const { summary } = evaluateGate(syntheticRuns({ gpuShift: (w, s) => (w === 2 && s === 3 ? 41.6 : 0) }));
    expect(summary.calibration.passed).toBe(true);
    // The slot in both scenarios, plus their totals, which have no spread.
    expect(summary.gpuFailures).toBe(4);
    expect(summary.gatePassed).toBe(false);
  });

  it("lets saturated totals differ by less than 0.5 % but not more", () => {
    // Spread over the busy slots, each shift stays well inside its slot's bound.
    expect(evaluateGate(syntheticRuns({ gpuShift: (_w, s) => (s < BUSY ? 0.375 : 0) })).summary.gpuPassed).toBe(true);
    const { comparisons } = evaluateGate(syntheticRuns({ gpuShift: (_w, s) => (s < BUSY ? 7.5 : 0) }));
    const failed = comparisons.gpu!.filter((r) => !r.passed);
    expect(failed).toHaveLength(10);
    expect(failed.every((r) => r.slot === -1)).toBe(true);
  });

  it("requires unused slots to read zero within one particle", () => {
    expect(evaluateGate(syntheticRuns({ gpuShift: (_w, s) => (s === 20 ? 0.5 : 0) })).summary.gpuPassed).toBe(true);
    expect(evaluateGate(syntheticRuns({ gpuShift: (_w, s) => (s === 20 ? 1.5 : 0) })).summary.gpuPassed).toBe(false);
  });

  it("fails the gate on a failed calibration even when the GPU passes", () => {
    const runs = syntheticRuns();
    for (const run of runs) if (run.group === "calibration") { run.means[4] += 100; run.means[0] += 100; }
    const { summary } = evaluateGate(runs);
    expect(summary.calibration.passed).toBe(false);
    expect(summary.gpuPassed).toBe(true);
    expect(summary.gatePassed).toBe(false);
  });

  it("fails calibration when either control is too noisy to detect a 5 % difference", () => {
    for (const group of ["calibration", "pcg"] as const) {
      const result = evaluateCalibration(syntheticRuns({ spread: { [group]: 60 } }, ["cpu", "calibration", "pcg"])).result;
      expect(result.failures).toEqual({ calibration: 0, pcg: 0 });
      expect(result.medianDetectableShare[group]).toBeGreaterThan(0.05);
      expect(result.passed).toBe(false);
    }
  });

  it("reports an export that stopped after a failed calibration as a failed gate", () => {
    const runs = syntheticRuns({ spread: { pcg: 60 } }, ["cpu", "calibration", "pcg"]);
    const { summary } = evaluateGate(runs);
    expect(summary.gpuFailures).toBeNull();
    expect(summary.gatePassed).toBe(false);
    expect(() => evaluateGate(syntheticRuns({}, ["cpu", "calibration", "pcg"]))).toThrow(/no GPU runs/);
  });

  it("rejects malformed exports", () => {
    const groups: GateGroup[] = ["cpu", "calibration", "pcg", "gpu"];
    const cases: [string, (runs: OccupancyRun[]) => void][] = [
      ["missing run", (runs) => { runs.pop(); }],
      ["duplicate run", (runs) => { runs.push(structuredClone(runs[0])); }],
      ["other seed", (runs) => { runs[0].seed = 999; }],
      ["short means", (runs) => { runs[0].means.pop(); }],
      ["nonfinite mean", (runs) => { runs[0].means[0] = Number.NaN; }],
      ["negative mean", (runs) => { runs[0].means[30] = -1; runs[0].means[0] -= 1; }],
      ["mean above capacity", (runs) => { runs[0].means[30] = 20000; runs[0].means[0] += 20000; }],
      ["slots not adding up", (runs) => { runs[0].means[0] += 5; }],
      ["shifted windows in every run", (runs) => { for (const run of runs) run.starts = run.starts.map((t) => t + 1); }],
      ["missing window", (runs) => { runs[0].starts.pop(); }],
    ];
    for (const [name, corrupt] of cases) {
      const runs = syntheticRuns();
      corrupt(runs);
      expect(() => validateRuns(runs, groups, 20), name).toThrow();
    }
  });
});

describe("occupancy gate runner", () => {
  async function run(options: Synthetic, runsPerGroup?: number) {
    const order: string[] = [];
    const result = await runGate(
      (scenario, seed, pcg) => {
        const group = pcg ? "pcg" : seed > 20 ? "calibration" : "cpu";
        order.push(group);
        return syntheticRun(scenario, group, seed, options);
      },
      async (scenario, seed) => { order.push("gpu"); return syntheticRun(scenario, "gpu", seed, options); },
      { runsPerGroup },
    );
    return { order, result };
  }

  it("runs every CPU group of both scenarios, then the GPU only after calibration passed", async () => {
    const { order, result } = await run({});
    expect(result.calibration.passed).toBe(true);
    expect(result.gpuSkipped).toBe(false);
    expect(order.indexOf("gpu")).toBe(120);
    expect(order.filter((g) => g === "gpu")).toHaveLength(40);
    expect(evaluateGate(result.runs).summary.gatePassed).toBe(true);
  });

  it("never runs the GPU when calibration fails", async () => {
    const { order, result } = await run({ spread: { pcg: 60 } });
    expect(result.calibration.passed).toBe(false);
    expect(result.gpuSkipped).toBe(true);
    expect(order).not.toContain("gpu");
    expect(result.runs).toHaveLength(120);
  });

  it("still exercises the GPU in a smoke run, whose calibration is not enforced", async () => {
    const { order, result } = await run({ spread: { pcg: 60 } }, 2);
    expect(result.calibration.passed).toBe(false);
    expect(result.gpuSkipped).toBe(false);
    expect(order.filter((g) => g === "gpu")).toHaveLength(4);
  });
});
