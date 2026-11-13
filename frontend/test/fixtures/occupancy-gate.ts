import type { OccupancyRun } from "./occupancy-runs";
import { OCCUPANCY, OCCUPANCY_SCENARIOS, SERIES, WINDOWS, type OccupancyScenario } from "./occupancy-scenario";

/**
 * The approved multi-seed occupancy gate (docs/superpowers/plans/2026-11-13-gpu-prototype.md, "Revised
 * occupancy gate"). One implementation serves the browser runner, which must pass calibration before
 * any GPU run, and the offline processor that gives the verdict.
 */
export const GATE = {
  /** Two-sided Student t quantile at alpha = 0.05 / 330 with 19 degrees of freedom (4.7127). */
  tCrit: 4.71,
  /** One-sided normal quantile for 90 % detection. */
  detectZ: 1.28,
  floorParticles: 1,
  floorShare: 0.005,
  /** Slots with a CPU mean above this count as busy for the sensitivity requirement. */
  busyParticles: 20,
  maxDetectableShare: 0.05,
  runsPerGroup: 20,
} as const;

export type GateGroup = OccupancyRun["group"];

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Seeds fixed by the approved gate. */
export const GATE_SEEDS: Readonly<Record<GateGroup, readonly number[]>> = {
  cpu: range(1, 20), calibration: range(21, 40), pcg: range(1001, 1020), gpu: range(1001, 1020),
};

/** The CPU groups calibration compares, and the comparison each makes with the `cpu` reference. */
const CALIBRATION_GROUPS = ["calibration", "pcg"] as const;
export const CPU_GROUPS: readonly GateGroup[] = ["cpu", ...CALIBRATION_GROUPS];

/** Approved window starts in seconds; recorded starts carry Float32 step rounding. */
export const WINDOW_STARTS = [10, 25, 45, 50, 55] as const;

export interface Comparison {
  scenario: OccupancyScenario;
  window: number;
  /** -1 for the total. */
  slot: number;
  a: number;
  b: number;
  difference: number;
  bound: number;
  passed: boolean;
  /** The true difference detected 90 % of the time. */
  detectable: number;
}

export interface CalibrationResult {
  passed: boolean;
  failures: Record<(typeof CALIBRATION_GROUPS)[number], number>;
  /** Median 90 % detectable difference over busy slots as a share of their mean; null without busy slots. */
  medianDetectableShare: Record<(typeof CALIBRATION_GROUPS)[number], number | null>;
}

type Grouped = Map<string, number[][]>;
const key = (scenario: OccupancyScenario, group: GateGroup) => `${scenario}/${group}`;

/**
 * Indexes the runs by scenario and group, ordered by seed, and rejects anything but exactly the first
 * `runsPerGroup` gate seeds of `groups`, the approved windows and possible occupancy means.
 */
export function validateRuns(runs: readonly OccupancyRun[], groups: readonly GateGroup[], runsPerGroup: number): Grouped {
  const bySeed = new Map<string, Map<number, number[]>>();
  for (const run of runs) {
    const label = `${run.scenario}/${run.group} seed ${run.seed}`;
    if (!OCCUPANCY_SCENARIOS.includes(run.scenario) || !groups.includes(run.group)) throw new Error(`Unexpected run: ${label}`);
    if (run.starts.length !== WINDOWS || run.starts.some((start, i) => Math.abs(start - WINDOW_STARTS[i]) > 1e-4)) {
      throw new Error(`Windows differ from the approved starts: ${label}`);
    }
    const { means } = run;
    if (means.length !== WINDOWS * SERIES || means.some((m) => !Number.isFinite(m) || m < 0 || m > OCCUPANCY.capacity)) {
      throw new Error(`Impossible means: ${label}`);
    }
    for (let w = 0; w < WINDOWS; w++) {
      // Each step's per-slot counts add up to its total, so their window means do too.
      let slots = 0;
      for (let s = 1; s < SERIES; s++) slots += means[w * SERIES + s];
      if (Math.abs(slots - means[w * SERIES]) > 1e-6 * OCCUPANCY.capacity) throw new Error(`Slots do not add up to the total: ${label}`);
    }
    const runsOfGroup = bySeed.get(key(run.scenario, run.group)) ?? new Map<number, number[]>();
    if (runsOfGroup.has(run.seed)) throw new Error(`Duplicate run: ${label}`);
    bySeed.set(key(run.scenario, run.group), runsOfGroup.set(run.seed, means));
  }
  const grouped: Grouped = new Map();
  for (const scenario of OCCUPANCY_SCENARIOS) {
    for (const group of groups) {
      const seeds = GATE_SEEDS[group].slice(0, runsPerGroup);
      const runsOfGroup = bySeed.get(key(scenario, group));
      if (!runsOfGroup || runsOfGroup.size !== seeds.length || !seeds.every((seed) => runsOfGroup.has(seed))) {
        throw new Error(`Seeds differ from the gate: ${scenario}/${group}`);
      }
      grouped.set(key(scenario, group), seeds.map((seed) => runsOfGroup.get(seed)!));
    }
  }
  return grouped;
}

const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const variance = (values: readonly number[]) => {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
};

/** One comparison per window and series of `other` against the `reference` runs. */
export function compare(scenario: OccupancyScenario, reference: readonly number[][], other: readonly number[][]): Comparison[] {
  const rows: Comparison[] = [];
  for (let index = 0; index < WINDOWS * SERIES; index++) {
    const aValues = reference.map((means) => means[index]), bValues = other.map((means) => means[index]);
    const a = mean(aValues), b = mean(bValues);
    const error = Math.sqrt(variance(aValues) / aValues.length + variance(bValues) / bValues.length);
    const floor = Math.max(GATE.floorParticles, GATE.floorShare * a);
    const bound = GATE.tCrit * error + floor;
    rows.push({ scenario, window: Math.floor(index / SERIES), slot: (index % SERIES) - 1, a, b, difference: b - a,
      bound, passed: Math.abs(b - a) <= bound, detectable: (GATE.tCrit + GATE.detectZ) * error + floor });
  }
  return rows;
}

/** Median 90 % detectable difference over busy slots, as a share of their mean. */
export function medianDetectableShare(rows: readonly Comparison[]): number | null {
  const shares = rows.filter((r) => r.slot >= 0 && r.a > GATE.busyParticles).map((r) => r.detectable / r.a).sort((x, y) => x - y);
  if (shares.length === 0) return null;
  const middle = Math.floor(shares.length / 2);
  return shares.length % 2 ? shares[middle] : (shares[middle - 1] + shares[middle]) / 2;
}

function compareGroup(grouped: Grouped, group: GateGroup): Comparison[] {
  return OCCUPANCY_SCENARIOS.flatMap((scenario) => compare(scenario, grouped.get(key(scenario, "cpu"))!, grouped.get(key(scenario, group))!));
}

/**
 * Calibration: CPU seeds 1-20 against 21-40 and against the PCG-keyed control must pass every
 * comparison, and each comparison must detect a 5 % difference in busy slots 90 % of the time.
 */
export function evaluateCalibration(runs: readonly OccupancyRun[], runsPerGroup: number = GATE.runsPerGroup) {
  const grouped = validateRuns(runs.filter((r) => r.group !== "gpu"), CPU_GROUPS, runsPerGroup);
  const comparisons = { calibration: compareGroup(grouped, "calibration"), pcg: compareGroup(grouped, "pcg") };
  const failures = { calibration: comparisons.calibration.filter((r) => !r.passed).length, pcg: comparisons.pcg.filter((r) => !r.passed).length };
  const shares = { calibration: medianDetectableShare(comparisons.calibration), pcg: medianDetectableShare(comparisons.pcg) };
  const sensitive = Object.values(shares).every((share) => share !== null && share <= GATE.maxDetectableShare);
  const result: CalibrationResult = { passed: failures.calibration === 0 && failures.pcg === 0 && sensitive, failures, medianDetectableShare: shares };
  return { result, comparisons };
}

const closest = (rows: readonly Comparison[]) => [...rows].sort((x, y) => Math.abs(y.difference) / y.bound - Math.abs(x.difference) / x.bound).slice(0, 5);

/**
 * The verdict on a complete export. Without GPU runs, the browser stopped after a failed calibration:
 * that is reported as a failed gate; GPU runs missing after a passed calibration are malformed.
 */
export function evaluateGate(runs: readonly OccupancyRun[]) {
  const calibration = evaluateCalibration(runs);
  const hasGpu = runs.some((r) => r.group === "gpu");
  if (!hasGpu && calibration.result.passed) throw new Error("Calibration passed but the export has no GPU runs");
  const gpu = hasGpu ? compareGroup(validateRuns(runs, [...CPU_GROUPS, "gpu"], GATE.runsPerGroup), "gpu") : null;
  const gpuFailures = gpu ? gpu.filter((r) => !r.passed).length : null;
  const comparisons = { ...calibration.comparisons, ...(gpu ? { gpu } : {}) };
  return {
    comparisons,
    summary: {
      comparisons: calibration.comparisons.calibration.length,
      calibration: calibration.result,
      gpuFailures,
      gpuPassed: gpuFailures === 0,
      gatePassed: calibration.result.passed && gpuFailures === 0,
      closest: Object.fromEntries(Object.entries(comparisons).map(([name, rows]) => [name, closest(rows)])),
    },
  };
}

/**
 * Runs the gate's groups in its required order: every CPU group of both scenarios, then calibration,
 * and the GPU only if calibration passed. `runsPerGroup` below 20 is a smoke run, never evidence: its
 * calibration is reported but not enforced, so the GPU path is exercised too.
 */
export async function runGate(
  runCpu: (scenario: OccupancyScenario, seed: number, pcg: boolean) => Omit<OccupancyRun, "group">,
  runGpu: (scenario: OccupancyScenario, seed: number) => Promise<Omit<OccupancyRun, "group">>,
  options: { runsPerGroup?: number; onProgress?: (done: number, total: number, label: string) => void; yieldEach?: () => Promise<unknown> } = {},
) {
  const runsPerGroup = options.runsPerGroup ?? GATE.runsPerGroup;
  const total = OCCUPANCY_SCENARIOS.length * (CPU_GROUPS.length + 1) * runsPerGroup;
  const runs: OccupancyRun[] = [];
  const record = async (run: Omit<OccupancyRun, "group">, group: GateGroup) => {
    runs.push({ ...run, group });
    options.onProgress?.(runs.length, total, `${run.scenario} ${group} seed ${run.seed}`);
    await options.yieldEach?.();
  };
  for (const scenario of OCCUPANCY_SCENARIOS) {
    for (const group of CPU_GROUPS) {
      for (const seed of GATE_SEEDS[group].slice(0, runsPerGroup)) await record(runCpu(scenario, seed, group === "pcg"), group);
    }
  }
  const calibration = evaluateCalibration(runs, runsPerGroup).result;
  if (!calibration.passed && runsPerGroup === GATE.runsPerGroup) return { runs, calibration, gpuSkipped: true };
  for (const scenario of OCCUPANCY_SCENARIOS) {
    for (const seed of GATE_SEEDS.gpu.slice(0, runsPerGroup)) await record(await runGpu(scenario, seed), "gpu");
  }
  return { runs, calibration, gpuSkipped: false };
}
