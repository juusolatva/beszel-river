import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { createGpuBackend, GpuStepClock, MIN_GPU_STEP } from "../src/gpu-backend";
import { effectiveGpuStep } from "../src/sim/gpu-lifecycle";
import { callsTo, createFakeGl } from "./fake-gl";

describe("GpuStepClock", () => {
  it("passes ordinary intervals through as Float32 steps", () => {
    const clock = new GpuStepClock();
    expect(clock.take(1 / 60)).toBe(Math.fround(1 / 60));
    expect(clock.take(1 / 144)).toBe(Math.fround(1 / 144));
  });

  it("adds up intervals shorter than 1/256 s and skips the callbacks in between", () => {
    const clock = new GpuStepClock();
    // 480 Hz: every other callback runs one step of two intervals.
    expect(clock.take(1 / 480)).toBe(0);
    expect(clock.take(1 / 480)).toBe(Math.fround(2 / 480));
    expect(clock.take(1 / 480)).toBe(0);
    expect(clock.take(1 / 480)).toBe(Math.fround(2 / 480));
    // A jittery callback just short of the floor waits for the next one.
    expect(clock.take(0.0039)).toBe(0);
    expect(clock.take(0.0161)).toBe(Math.fround(0.02));
  });

  it("returns exactly 1/256 s when the intervals reach it", () => {
    const clock = new GpuStepClock();
    expect(clock.take(MIN_GPU_STEP / 2)).toBe(0);
    expect(clock.take(MIN_GPU_STEP / 2)).toBe(MIN_GPU_STEP);
  });

  it("clamps long pauses to maxDt and drops the rest", () => {
    const clock = new GpuStepClock();
    expect(clock.take(20)).toBe(Math.fround(LOOK.maxDt));
    expect(clock.take(1 / 60)).toBe(Math.fround(1 / 60));
  });

  it("ignores zero, negative and non-finite intervals", () => {
    const clock = new GpuStepClock();
    for (const interval of [0, -1, Number.NaN, -Infinity]) expect(clock.take(interval)).toBe(0);
    expect(clock.take(1 / 60)).toBe(Math.fround(1 / 60));
  });

  it("only ever returns steps the GPU simulation accepts", () => {
    const clock = new GpuStepClock();
    // Deterministic jitter around 360, 240, 144 and 60 Hz periods, plus occasional long gaps.
    let x = 12345;
    for (let i = 0; i < 20000; i++) {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      const base = [1 / 360, 1 / 240, 1 / 144, 1 / 60][i % 4];
      const interval = i % 997 === 0 ? 0.5 : base * (0.5 + x / 2 ** 31);
      const dt = clock.take(interval);
      expect(effectiveGpuStep(dt)).toBe(dt);
    }
  });
});

describe("createGpuBackend", () => {
  it("prepares the drawer and turns spawning on", () => {
    const { gl, calls } = createFakeGl();
    const { particles, drawer, clock } = createGpuBackend(gl, 12, 42);
    expect(clock.take(1 / 60)).toBe(Math.fround(1 / 60));
    expect(particles.spawningEnabled).toBe(true);
    expect(particles.capacity).toBe(12);
    expect(drawer.drawCapacity).toBe(12);
    // Simulation, free scan and drawer programs are all linked before the first frame.
    const linked = callsTo(calls, "linkProgram").length;
    expect(linked).toBeGreaterThanOrEqual(4);
    calls.length = 0;
    drawer.prepare();
    expect(callsTo(calls, "linkProgram")).toEqual([]);
  });

  it("releases everything when the drawer cannot be set up", () => {
    let links = 0;
    const { gl, calls } = createFakeGl({ overrides: { linkProgram: () => { links++; }, getProgramParameter: () => links < 4, getProgramInfoLog: () => "drawer link" } });
    expect(() => createGpuBackend(gl, 12, 42)).toThrow(/drawer link/);
    // The simulation's three programs, the drawer's failed one, both state buffers and the feedback object.
    expect(callsTo(calls, "deleteProgram")).toHaveLength(4);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
    expect(callsTo(calls, "deleteBuffer").length).toBeGreaterThanOrEqual(2);
  });

  it("throws when the simulation itself cannot start", () => {
    const { gl } = createFakeGl({ overrides: { getParameter: () => 0 } });
    expect(() => createGpuBackend(gl, 12, 42)).toThrow("GPU motion unsupported");
  });
});
