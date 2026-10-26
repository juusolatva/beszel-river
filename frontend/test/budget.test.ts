import { describe, expect, it } from "vitest";
import { ParticleBudget } from "../src/sim/budget";

/** Feeds `seconds` worth of frames of `interval` s; returns whether any of them changed the limit. */
function run(budget: ParticleBudget, interval: number, seconds: number): boolean {
  let changed = false;
  for (let t = 0; t < seconds; t += interval) changed = budget.update(interval) || changed;
  return changed;
}

describe("ParticleBudget", () => {
  it("drops a fifth after 2 s behind the display, then waits twice as long to rise again", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1);
    expect(run(budget, 1 / 20, 2.1)).toBe(true);
    expect(budget.limit).toBe(800);

    // The wait doubled from 10 s to 20 s.
    expect(run(budget, 1 / 60, 18)).toBe(false);
    expect(budget.limit).toBe(800);
    expect(run(budget, 1 / 60, 3)).toBe(true);
    expect(budget.limit).toBe(880);
  });

  it("never drops below a quarter of the pool or rises above it", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1);
    run(budget, 1 / 10, 60);
    expect(budget.limit).toBe(250);
    expect(budget.intensityScale).toBe(2);

    run(budget, 1 / 60, 3000);
    expect(budget.limit).toBe(1000);
    expect(budget.intensityScale).toBe(1);
  });

  it("caps the wait before a rise at 2 min", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1);
    // Ten drops would make the wait 10 s · 2¹⁰ without the cap; the floor stops the limit at 250.
    run(budget, 1 / 10, 25);
    expect(run(budget, 1 / 60, 119)).toBe(false);
    expect(run(budget, 1 / 60, 2)).toBe(true);
  });

  it("takes a steady 30 Hz display for keeping up, not for overload", () => {
    const budget = new ParticleBudget(1000, false);
    expect(run(budget, 1 / 30, 30)).toBe(false);
    expect(budget.limit).toBe(1000);
  });

  it("counts frames as slow when well behind the fastest seen, but never from 45 fps up", () => {
    // 40 fps is 3 periods behind a 120 Hz display, but within 1.5 periods of a 60 Hz one.
    const fast = new ParticleBudget(1000, false);
    run(fast, 1 / 120, 1);
    run(fast, 1 / 40, 2.1);
    expect(fast.limit).toBe(800);

    const normal = new ParticleBudget(1000, false);
    run(normal, 1 / 60, 1);
    run(normal, 1 / 40, 2.1);
    expect(normal.limit).toBe(1000);

    const fastest = new ParticleBudget(1000, false);
    run(fastest, 1 / 240, 1);
    run(fastest, 1 / 50, 10);
    expect(fastest.limit).toBe(1000);
  });

  it("lets keeping-up frames work off earlier slow time", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1);
    run(budget, 1 / 20, 1.5);
    run(budget, 1 / 60, 1.5);
    run(budget, 1 / 20, 1.5);
    expect(budget.limit).toBe(1000);
  });

  it("ignores pauses, non-positive intervals and a fixed count", () => {
    const budget = new ParticleBudget(1000, false);
    expect(budget.update(0)).toBe(false);
    expect(budget.update(-1)).toBe(false);
    expect(run(budget, 0.3, 30)).toBe(false);
    expect(budget.limit).toBe(1000);

    const fixed = new ParticleBudget(1000, true);
    run(fixed, 1 / 60, 1);
    expect(run(fixed, 1 / 10, 30)).toBe(false);
    expect(fixed.limit).toBe(1000);
  });
});
