import { describe, expect, it } from "vitest";
import lifecycle from "../../docs/experiments/2026-11-13-gpu-lifecycle.json";
import investigation from "../../docs/experiments/2026-11-13-gpu-occupancy.json";
import { runCpuOccupancy } from "./fixtures/occupancy-runs";
import { SERIES, WINDOWS, type OccupancyScenario } from "./fixtures/occupancy-scenario";

/** Retained means for one scenario in the runner's layout. */
function retained(rows: readonly { start: number; slot: number }[], value: (row: never) => number) {
  const starts = [...new Set(rows.map((r) => r.start))].sort((a, b) => a - b);
  const means = new Array<number>(starts.length * SERIES);
  for (const row of rows) means[starts.indexOf(row.start) * SERIES + row.slot + 1] = value(row as never);
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
    const expected = retained(lifecycle.windows.filter((w) => w.scenario === scenario), (w: { cpu: number; control: number }) => w[column]);
    expect(run.means).toHaveLength(WINDOWS * SERIES);
    expect(run.starts).toEqual(expected.starts);
    expect(run.means).toEqual(expected.means);
  }, TIMEOUT);

  it("reproduces the investigation's PCG-keyed matched control exactly", () => {
    const run = runCpuOccupancy("occupancy", 42, true);
    const rows = investigation.results.find((r) => r.scenario === "occupancy")!.windows;
    expect(run.means).toEqual(retained(rows, (w: { matched: number }) => w.matched).means);
  }, TIMEOUT);
});
