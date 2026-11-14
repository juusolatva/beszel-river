import type { Frame } from "@beszel-river/shared";
import { replayFrames } from "./gpu-replay";

/**
 * The Task 3 occupancy fixture (docs/superpowers/plans/2026-11-13-gpu-prototype.md): 10,000 slots,
 * 600 steps of Float32(0.1) s, aspect 1.5, one stream, then four at 15 s and 32 at 30 s, measured over
 * the steady five-second windows from 10, 25 and 45 s. gpu-lifecycle.browser.ts inlines the same
 * schedule; it is kept unchanged because its retained results are evidence.
 */
export const OCCUPANCY = { capacity: 10000, steps: 600, dt: Math.fround(0.1), aspect: 1.5 } as const;

export type OccupancyScenario = "occupancy" | "filaments";
export const OCCUPANCY_SCENARIOS: readonly OccupancyScenario[] = ["occupancy", "filaments"];

/** Total plus the 32 stream slots. */
export const SERIES = 33;
/** One window in each of the first two phases, three in the last. */
export const WINDOWS = 5;

/** The frames of the three phases. */
export function occupancyFrames(scenario: OccupancyScenario): Frame[] {
  const channels = replayFrames[2].streams[0];
  return [1, 4, 32].map((n) => ({ v: 1, t: 0,
    streams: Array.from({ length: n }, (_, i) => ({ ...channels, id: `old-${i}`,
      width: 0.5, flow: 0, density: 1, turbulence: 0.5, pulse: 0,
      ...(scenario === "filaments" ? { filaments: [0.1, 0.2, 0.9, 0.3, 0.2, 0.1] } : {}) })) }));
}

export function phaseAt(time: number): number {
  return time < 15 ? 0 : time < 30 ? 1 : 2;
}

/**
 * Time-weighted mean counts over the steady windows, accumulated as gpu-lifecycle.browser.ts does so
 * that its retained CPU means are reproduced exactly. `means` is window-major: index
 * `window * SERIES + slot + 1`, with slot -1 the total.
 */
export class WindowMeans {
  readonly means: number[] = [];
  readonly starts: number[] = [];
  private readonly sums = new Float64Array(SERIES);
  private windowTime = 0;
  private phase = -1;

  /** Adds one step's counts; `slotCount(s)` gives slot s's live particles. */
  add(time: number, dt: number, total: number, slotCount: (slot: number) => number): void {
    const phase = phaseAt(time);
    if (phase !== this.phase) { this.phase = phase; this.sums.fill(0); this.windowTime = 0; }
    if (time + 1e-5 < (phase === 0 ? 10 : phase === 1 ? 25 : 45)) return;
    this.sums[0] += total * dt;
    for (let s = 0; s < 32; s++) this.sums[s + 1] += slotCount(s) * dt;
    this.windowTime += dt;
    if (this.windowTime >= 5 - 1e-6) {
      for (let i = 0; i < SERIES; i++) this.means.push(this.sums[i] / this.windowTime);
      this.starts.push(time - this.windowTime + dt);
      this.sums.fill(0);
      this.windowTime = 0;
    }
  }
}
