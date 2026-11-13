import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { CpuReplay, ReplayTrace, replayFrames, replayFrameIndex, summarizeOccupancy, validateCpuTrace } from "./fixtures/gpu-replay";

describe("GPU comparison replay foundation", () => {
  it("covers synthetic plain, filament, pulse, expansion, rotation and empty frames", () => {
    expect(replayFrames.map((f) => f.streams.length)).toEqual([1, 4, 32, 32, 0]);
    expect(replayFrames[0].streams[0].filaments).toBeUndefined();
    expect(replayFrames[1].streams[0].filaments).toHaveLength(6);
    expect(replayFrames[1].streams.some((s) => s.pulse > 0)).toBe(true);
    expect(replayFrames[2].streams.every((s) => s.flow === 0 && s.density === 1)).toBe(true);
    expect(replayFrames[3].streams.every((s) => !replayFrames[2].streams.some((old) => old.id === s.id))).toBe(true);
    expect(replayFrameIndex("rotation", 0)).toBe(0);
    expect(replayFrameIndex("rotation", 5)).toBe(1);
    expect(replayFrameIndex("rotation", 10)).toBe(2);
    expect(replayFrameIndex("rotation", 40)).toBe(3);
    expect(replayFrameIndex("rotation", 70)).toBe(4);
    expect(replayFrameIndex("dense", 100)).toBe(2);
    expect(replayFrameIndex("empty", 0)).toBe(4);
    expect(replayFrameIndex("draining", 30)).toBe(4);
    expect(replayFrameIndex("draining", 29)).toBe(2);
    expect(replayFrameIndex("drained", 60)).toBe(4);
  });

  it("rejects capacities that cannot be represented by the trace arrays", () => {
    for (const capacity of [2.5, NaN, Infinity, -1]) expect(() => new ReplayTrace(capacity)).toThrow();
  });

  it("preallocates a complete effective schedule, clamps dt, and rejects overflow", () => {
    const trace = new ReplayTrace(2);
    trace.append(0, 2, 960, 640, 1.2, 1, false, 1000, 1, false);
    trace.append(3, 4, 640, 960, 1, 0.2, true, 800, 2, true);
    expect(trace).toHaveLength(2);
    expect(trace.dt[1]).toBe(Math.fround(LOOK.maxDt));
    expect(trace.interval[1]).toBe(3);
    expect(trace.frame[1]).toBe(4);
    expect(trace.motion[1]).toBe(0.2);
    expect(trace.offline[1]).toBe(1);
    expect(trace.measured[1]).toBe(1);
    expect(trace.limit[1]).toBe(800);
    expect(trace.intensity[1]).toBe(2);
    expect(() => trace.append(1 / 60, 2, 1, 1, 1, 1, false, 1, 1, true)).toThrow(/overflow/i);
    expect(trace.valid).toBe(false);
  });

  it("records identical Float32-effective dt for both backends while retaining callback intervals", () => {
    const trace = new ReplayTrace(1);
    const interval = 0.07793116454949989;
    trace.append(interval, 2, 960, 640, 1, 1, false, 1000, 1, true);
    expect(trace.interval[0]).toBe(interval);
    expect(trace.dt[0]).toBe(Math.fround(interval));
    expect(trace.dt[0]).not.toBe(interval);
  });

  it("rejects dimensions that cannot survive storage as positive uint32 values", () => {
    for (const bad of [0, -1, 0.5, NaN, Infinity, 2 ** 32]) {
      for (const [width, height] of [[bad, 640], [960, bad]]) {
        const trace = new ReplayTrace(1);
        expect(() => trace.append(0.1, 2, width, height, 1, 1, false, 1000, 1, true)).toThrow(/dimensions/);
        expect(trace.valid).toBe(false);
        expect(trace).toHaveLength(0);
      }
    }
  });

  it("reproduces CPU counts and instances from the recorded schedule through resizing and removal", () => {
    const trace = new ReplayTrace(480);
    const first = new CpuReplay(0.2);
    const counts = new Uint32Array(480);
    for (let i = 0; i < 480; i++) {
      trace.append(i === 0 ? 0 : 1 / 60, i < 240 ? 1 : 4, i < 120 ? 960 : 640, 640, 1, 0.2, i > 360, i < 120 ? 1000 : 800, 1.5, i >= 240);
      counts[i] = first.step(trace, i);
    }
    const second = new CpuReplay(0.2);
    for (let i = 0; i < trace.length; i++) {
      expect(second.step(trace, i)).toBe(counts[i]);
      expect(second.streams.slots.reduce((n, s) => n + s.particles, 0)).toBe(counts[i]);
    }
    const validation = validateCpuTrace(trace);
    expect(validation.counts).toEqual(counts);
    expect(validation.perSlot.slice(-32)).toEqual(Uint32Array.from(second.streams.slots, (s) => s.particles));
    expect(validation.ids[validation.perSlotIdentity[trace.length * 32 - 32]]).toBe(second.streams.slots[0].id);
    expect(second.particles.capacity).toBe(10000);
    expect(second.particles.limit).toBe(800);
    expect(second.particles.instances).toEqual(first.particles.instances);
    expect(second.streams.slots.map((s) => s.particles)).toEqual(first.streams.slots.map((s) => s.particles));
  });

  it("drains a previously populated full-capacity pool after stream removal", () => {
    const trace = new ReplayTrace(700);
    const cpu = new CpuReplay();
    let populated = false;
    for (let i = 0; i < 700; i++) {
      trace.append(0.1, replayFrameIndex("drained", i / 10), 960, 640, 1, 1, false, 1000, 1, i >= 600);
      const count = cpu.step(trace, i);
      if (i < 300 && count > 0) populated = true;
      if (i >= 600) expect(count).toBe(0);
    }
    expect(populated).toBe(true);
    expect(cpu.particles.capacity).toBe(10000);
  });

  it("rejects motion changes and invalid traces rather than silently replaying different physics", () => {
    const trace = new ReplayTrace(1);
    trace.append(0.1, 2, 960, 640, 1, 0.2, false, 1000, 1, true);
    expect(() => new CpuReplay().step(trace, 0)).toThrow(/Motion changes/);
    trace.valid = false;
    expect(() => validateCpuTrace(trace)).toThrow(/invalid trace/);
    expect(validateCpuTrace(new ReplayTrace(0)).occupancy.simulationMean).toBe(0);
  });

  it("weights measured post-step occupancy by simulation time and reports wall time separately", () => {
    const trace = new ReplayTrace(3);
    trace.append(1, 2, 1, 1, 1, 1, false, 1000, 1, false);
    trace.append(0.05, 2, 1, 1, 1, 1, false, 1000, 1, true);
    trace.append(1, 2, 1, 1, 1, 1, false, 1000, 1, true);
    const stats = summarizeOccupancy(trace, new Uint32Array([999, 10, 20]));
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(20);
    expect(stats.simulationMean).toBeCloseTo((10 * 0.05 + 20 * LOOK.maxDt) / (0.05 + LOOK.maxDt));
    expect(stats.wallMean).toBeCloseTo((10 * 0.05 + 20) / 1.05);
  });
});
