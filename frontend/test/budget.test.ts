import { describe, expect, it } from "vitest";
import { ParticleBudget } from "../src/sim/budget";

/** Feeds `seconds` worth of frames of `interval` s with `live` particles; returns whether any of them changed the limit. */
function run(budget: ParticleBudget, interval: number, seconds: number, live = 0, workSeconds = 0): boolean {
  let changed = false;
  for (let t = 0; t < seconds; t += interval) changed = budget.update(interval, live, workSeconds) || changed;
  return changed;
}

describe("ParticleBudget", () => {
  it("ignores a transient short interval after learning the display period", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1, 1000, 0.008);
    expect(budget.update(0.0001, 1000, 0)).toBe(false);
    expect(run(budget, 1 / 60, 30, 1000, 0.008)).toBe(false);
    expect(budget.limit).toBe(1000);
  });

  it("can recover after a short-interval timing glitch", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 2.1, 1000, 0.013);
    expect(budget.limit).toBe(800);
    budget.update(0.0001, 800, 0);
    expect(run(budget, 1 / 60, 21, 800, 0.008)).toBe(true);
    expect(budget.limit).toBe(880);
  });

  it.each([360, 480])("still detects work overload on a %i Hz display", (hz) => {
    const budget = new ParticleBudget(1000, false);
    expect(run(budget, 1 / hz, 2.1, 1000, (1 / hz) * 0.75)).toBe(true);
    expect(budget.limit).toBe(800);
  });

  it("confirms a modest refresh-rate increase after earlier calibration", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1, 1000, 0.001);
    // Above 70% of 64 Hz, but below 70% of the previously learned 60 Hz period.
    expect(run(budget, 1 / 64, 2.2, 1000, 0.0113)).toBe(true);
    expect(budget.limit).toBe(800);
  });

  it.each([
    [60, 0.013],
    [60, 0.018],
    [60, 0.022],
    [120, 0.006],
    [240, 0.003],
  ])("drops after sustained callback work at %i Hz with %f s of work", (hz, work) => {
    const budget = new ParticleBudget(1000, false);
    expect(run(budget, 1 / hz, 1.9, 1000, work)).toBe(false);
    expect(run(budget, 1 / hz, 0.2, 1000, work)).toBe(true);
    expect(budget.limit).toBe(800);
    expect(budget.intensityScale).toBeCloseTo(Math.sqrt(1000 / 800));
    expect(run(budget, 1 / hz, 10, 801, work)).toBe(false);
    expect(run(budget, 1 / hz, 2.1, 800, work)).toBe(true);
    expect(budget.limit).toBe(640);
  });

  it.each([
    [60, 0.008],
    [30, 0.010],
    [60, (1 / 60) * 0.7],
  ])("keeps the full pool at %i Hz with %f s of work", (hz, work) => {
    const budget = new ParticleBudget(1000, false);
    expect(run(budget, 1 / hz, 30, 1000, work)).toBe(false);
    expect(budget.limit).toBe(1000);
  });

  it("recovers only below 50% work and doubles the recovery wait after a work drop", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 2.1, 1000, 0.013);
    expect(budget.limit).toBe(800);
    expect(run(budget, 1 / 60, 30, 800, (1 / 60) * 0.5)).toBe(false);
    expect(run(budget, 1 / 60, 19, 800, 0.008)).toBe(false);
    // Moderate work resets, rather than advances, the recovery window.
    run(budget, 1 / 60, 1, 800, 0.010);
    expect(run(budget, 1 / 60, 19, 800, 0.008)).toBe(false);
    expect(run(budget, 1 / 60, 1.1, 800, 0.008)).toBe(true);
    expect(budget.limit).toBe(880);
  });

  it("retains the fastest learned period after a refresh or power-mode switch", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 120, 1, 1000, 0.001);
    // Cheap relative to 30 Hz, overloaded relative to the learned 120 Hz period.
    run(budget, 1 / 30, 2.1, 1000, 0.006);
    expect(budget.limit).toBe(800);
  });

  it.each([NaN, Infinity, -Infinity, -0.001])("ignores invalid work samples (%s) without poisoning calibration", (work) => {
    const budget = new ParticleBudget(1000, false);
    expect(run(budget, 1 / 240, 30, 1000, work)).toBe(false);
    expect(run(budget, 1 / 30, 30, 1000, 0.010)).toBe(false);
    expect(run(budget, 1 / 30, 2.1, 1000, 0.024)).toBe(true);
    expect(budget.limit).toBe(800);
  });

  it("ignores nonfinite intervals without poisoning later overload detection", () => {
    const budget = new ParticleBudget(1000, false);
    for (const interval of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(budget.update(interval, 1000, 0.013)).toBe(false);
    }
    expect(run(budget, 1 / 60, 2.1, 1000, 0.013)).toBe(true);
    expect(budget.limit).toBe(800);
  });

  it("does not join overload windows across a hidden-tab pause", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1.5, 1000, 0.013);
    expect(budget.update(60, 1000, 1)).toBe(false);
    expect(run(budget, 1 / 60, 1.5, 1000, 0.013)).toBe(false);
    expect(run(budget, 1 / 60, 0.6, 1000, 0.013)).toBe(true);
  });

  it("does not join recovery windows across a pause", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 2.1, 1000, 0.013);
    run(budget, 1 / 60, 15, 800, 0.008);
    budget.update(1, 800, 0);
    expect(run(budget, 1 / 60, 15, 800, 0.008)).toBe(false);
    expect(budget.limit).toBe(800);
  });

  it("keeps a fixed count under callback overload", () => {
    const budget = new ParticleBudget(1000, true);
    expect(run(budget, 1 / 240, 30, 1000, 0.020)).toBe(false);
    expect(budget.limit).toBe(1000);
    expect(budget.intensityScale).toBe(1);
  });

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

  it("waits for the particles above a lowered limit to die before counting slow frames again", () => {
    const budget = new ParticleBudget(1000, false);
    run(budget, 1 / 60, 1, 1000);
    run(budget, 1 / 20, 2.1, 1000);
    expect(budget.limit).toBe(800);

    // Still 1000 alive and still slow: that is the old load, not a reason for another drop.
    expect(run(budget, 1 / 20, 10, 1000)).toBe(false);
    expect(run(budget, 1 / 20, 10, 801)).toBe(false);
    expect(budget.limit).toBe(800);
    // Down to the limit and still slow: now it drops again.
    expect(run(budget, 1 / 20, 2.1, 800)).toBe(true);
    expect(budget.limit).toBe(640);
  });

  it("ignores pauses, non-positive intervals and a fixed count", () => {
    const budget = new ParticleBudget(1000, false);
    expect(budget.update(0, 0, 0)).toBe(false);
    expect(budget.update(-1, 0, 0)).toBe(false);
    expect(run(budget, 0.3, 30)).toBe(false);
    expect(budget.limit).toBe(1000);

    const fixed = new ParticleBudget(1000, true);
    run(fixed, 1 / 60, 1);
    expect(run(fixed, 1 / 10, 30)).toBe(false);
    expect(fixed.limit).toBe(1000);
  });
});
