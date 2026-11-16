import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { callsTo, createFakeGl } from "./fake-gl";
import { BudgetSchedule, compareGpuStates, CpuReplay, effectiveDecisions, fiveSecondWindows, GpuReplay, MIN_GPU_STEP, REPLAY_CAPACITY, ReplayTrace, replayableStep,
  replayFrames, replayFrameIndex, replayIds, ScheduleCursor, summarizeOccupancy, validateCpuTrace, validateGpuTrace } from "./fixtures/gpu-replay";

/** A short trace on the four-stream frame: one zero callback, then steady 30 Hz steps. */
function shortTrace(length: number, motion = 1): ReplayTrace {
  const trace = new ReplayTrace(length);
  for (let i = 0; i < length; i++) trace.append(i === 0 ? 0 : 1 / 30, 1, 960, 640, 1, motion, i === length - 1, 9000, 1.25, i > 0);
  return trace;
}

/** Fake GL whose state readbacks report `fill` for particle 0 and inactive slots elsewhere. */
function readbackGl(fill: (floats: Float32Array, words: Uint32Array) => void) {
  return createFakeGl({ overrides: {
    getBufferSubData: (_target, _offset, out) => {
      const bytes = out as Uint8Array;
      bytes.fill(0);
      fill(new Float32Array(bytes.buffer, bytes.byteOffset, 16), new Uint32Array(bytes.buffer, bytes.byteOffset, 16));
    },
  } });
}

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
    expect(() => replayFrameIndex("spiral" as "dense", 0)).toThrow(/Unknown replay scenario/);
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

  it("accepts only steps both backends can replay", () => {
    expect(MIN_GPU_STEP).toBe(1 / 256);
    expect([0, 1 / 256, 1 / 60, LOOK.maxDt].every(replayableStep)).toBe(true);
    expect([1 / 300, 1e-6, -1 / 60, Math.fround(LOOK.maxDt) * 1.001, Infinity, NaN].some(replayableStep)).toBe(false);
    expect(replayableStep(Math.fround(LOOK.maxDt))).toBe(true);
  });

  it("refuses unreplayable steps in both replays and their validations, not only in the harness", () => {
    const { gl } = createFakeGl();
    for (const dt of [-1 / 60, 1 / 300, LOOK.maxDt * 2, Infinity, NaN]) {
      const trace = shortTrace(2);
      // Bypass ReplayTrace.append's clamp, as a future trace source might.
      trace.dt[1] = dt;
      const gpu = new GpuReplay(gl);
      gpu.step(trace, 0);
      expect(() => gpu.step(trace, 1)).toThrow(/Unreplayable step/);
      gpu.dispose();
      const cpu = new CpuReplay();
      cpu.step(trace, 0);
      expect(() => cpu.step(trace, 1)).toThrow(/Unreplayable step/);
      expect(() => validateGpuTrace(gl, trace)).toThrow(/Unreplayable step/);
      expect(() => validateCpuTrace(trace)).toThrow(/Unreplayable step/);
    }
  });

  it("drives the GPU from the same trace: limit, offline, intensity, and the release clock before the streams", () => {
    const { gl, calls } = createFakeGl();
    const trace = shortTrace(3);
    const gpu = new GpuReplay(gl);
    expect(gpu.particles.spawningEnabled).toBe(true);
    expect(gpu.particles.capacity).toBe(REPLAY_CAPACITY);
    const order: string[] = [];
    const advance = gpu.particles.lifecycle.advanceTime.bind(gpu.particles.lifecycle);
    gpu.particles.lifecycle.advanceTime = (dt) => { order.push("clock"); advance(dt); };
    const update = gpu.streams.update.bind(gpu.streams);
    gpu.streams.update = (dt, aspect) => { order.push("streams"); update(dt, aspect); };
    calls.length = 0;
    gpu.step(trace, 0);
    expect(order).toEqual([]);
    expect(callsTo(calls, "drawArrays")).toEqual([]);
    gpu.step(trace, 1);
    expect(order).toEqual(["clock", "streams"]);
    expect(gpu.particles.limit).toBe(9000);
    expect(gpu.intensity).toBe(1.25);
    expect(gpu.streams.offline).toBe(false);
    expect(callsTo(calls, "drawArrays").at(-1)).toEqual(["POINTS", 0, REPLAY_CAPACITY]);
    gpu.step(trace, 2);
    expect(gpu.streams.offline).toBe(true);
    expect(() => gpu.step(shortTrace(1, 0.5), 0)).toThrow(/Motion changes/);
    gpu.dispose();
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("counts live particles per slot from readbacks after positive steps only", () => {
    const { gl, calls } = readbackGl((_floats, words) => words.set([0, 1, 1, 1], 12));
    const trace = shortTrace(4);
    const result = validateGpuTrace(gl, trace);
    expect(Array.from(result.counts)).toEqual([0, 1, 1, 1]);
    expect(result.perSlot[32]).toBe(1);
    expect(result.ids[result.perSlotIdentity[32]]).toBe(replayFrames[1].streams[0].id);
    expect(result.ids).toBe(replayIds);
    expect(result.finalState.byteLength).toBe(REPLAY_CAPACITY * 64);
    // One readback per positive step and a final one.
    expect(callsTo(calls, "getBufferSubData")).toHaveLength(4);
    expect(() => validateGpuTrace(gl, Object.assign(shortTrace(1), { valid: false }))).toThrow(/invalid trace/);
  });

  it("rejects stale generations and the spawn-counter overflow marker", () => {
    const stale = readbackGl((_floats, words) => words.set([0, 7, 1, 1], 12));
    expect(() => validateGpuTrace(stale.gl, shortTrace(2))).toThrow(/Stale stream generation/);
    const outOfRange = readbackGl((_floats, words) => words.set([40, 1, 1, 1], 12));
    expect(() => validateGpuTrace(outOfRange.gl, shortTrace(2))).toThrow(/Stale stream generation/);
    const overflow = readbackGl((floats) => { floats[10] = 1; });
    expect(() => validateGpuTrace(overflow.gl, shortTrace(2))).toThrow(/overflow marker/);
    // The replay's resources are released either way.
    expect(callsTo(overflow.calls, "deleteTransformFeedback")).toHaveLength(1);
  });

  it("compares final states exactly on identity and reports float differences", () => {
    const a = new ArrayBuffer(128), b = new ArrayBuffer(128);
    new Float32Array(b)[17] = 0.25;
    expect(compareGpuStates(a, b)).toEqual({ identityMatches: true, maxFloatDifference: 0.25 });
    new Uint32Array(b)[30] = 1;
    expect(compareGpuStates(a, b).identityMatches).toBe(false);
    expect(compareGpuStates(a, new ArrayBuffer(64)).identityMatches).toBe(false);
  });

  it("averages measured callbacks over five-second simulation windows without mixing frames", () => {
    const trace = new ReplayTrace(400);
    const counts = new Uint32Array(400), perSlot = new Uint32Array(400 * 32);
    for (let i = 0; i < 400; i++) {
      trace.append(i === 0 ? 0 : 0.05, i <= 150 ? 2 : 4, 960, 640, 1, 1, false, 1000, 1, i >= 50);
      counts[i] = i < 150 ? 100 : 40;
      perSlot[i * 32 + 3] = counts[i];
    }
    const windows = fiveSecondWindows(trace, counts, perSlot);
    expect(windows).toHaveLength(3); // 350 measured callbacks of 0.05 s; the partial window is left out
    expect(windows.map((w) => w.start)).toEqual([0, 5, 10]);
    expect(windows[0]).toMatchObject({ frames: [2], total: 100 });
    expect(windows[0].perSlot[3]).toBe(100);
    expect(windows[1].frames).toEqual([2, 4]);
    expect(windows[2]).toMatchObject({ frames: [4], total: 40 });
  });

  it("splits a step that crosses a window boundary and keeps the windows aligned", () => {
    // Float32(0.07) does not divide 5 s; 858 steps cover 60.06 s and must still give 12 windows.
    const trace = new ReplayTrace(858);
    const counts = new Uint32Array(858), perSlot = new Uint32Array(858 * 32);
    for (let i = 0; i < 858; i++) {
      trace.append(0.07, 2, 960, 640, 1, 1, false, 1000, 1, true);
      counts[i] = i < 72 ? 100 : 200; // steps 0–71 cover 0–5.04 s
      perSlot[i * 32] = counts[i];
    }
    const windows = fiveSecondWindows(trace, counts, perSlot);
    expect(windows.map((w) => w.start)).toEqual(Array.from({ length: 12 }, (_, k) => 5 * k));
    // Step 71 spans 4.97–5.04 s: its count fills the end of the first window and the start of the second.
    const dt = Math.fround(0.07);
    expect(windows[0].total).toBeCloseTo(100, 4);
    expect(windows[1].total).toBeCloseTo((100 * (72 * dt - 5) + 200 * (10 - 72 * dt)) / 5, 4);
    expect(windows[1].perSlot[0]).toBeCloseTo(windows[1].total, 9);
    expect(windows[11].total).toBeCloseTo(200, 4);
  });
});

describe("budget schedules", () => {
  it("checks and preallocates decisions, starting from the initial state at time 0", () => {
    const decisions = [{ time: 0, limit: 10000, intensity: 1 }, { time: 2.5, limit: 8000, intensity: 1.1 }, { time: 2.5, limit: 6400, intensity: 1.25 }];
    const schedule = BudgetSchedule.from(decisions);
    expect(schedule.capacity).toBe(3);
    expect(schedule.decisions()).toEqual(decisions);
    expect(() => BudgetSchedule.from([])).toThrow(/initial decision/);
    expect(() => new BudgetSchedule(0)).toThrow(/positive integer/);
    for (const bad of [
      [{ time: 0.1, limit: 10000, intensity: 1 }],
      [{ time: 0, limit: 10000, intensity: 1 }, { time: -1, limit: 8000, intensity: 1 }],
      [{ time: 0, limit: 10000, intensity: 1 }, { time: Infinity, limit: 8000, intensity: 1 }],
      [{ time: 0, limit: 0, intensity: 1 }],
      [{ time: 0, limit: REPLAY_CAPACITY + 1, intensity: 1 }],
      [{ time: 0, limit: 2500.5, intensity: 1 }],
      [{ time: 0, limit: 10000, intensity: 0 }],
      [{ time: 0, limit: 10000, intensity: NaN }],
    ]) expect(() => BudgetSchedule.from(bad)).toThrow(/nondecreasing times/);
    const full = new BudgetSchedule(1);
    full.record(0, 10000, 1);
    expect(() => full.record(1, 8000, 1)).toThrow(/overflow/);
    expect(full.valid).toBe(false);
    expect(() => new ScheduleCursor(full)).toThrow(/invalid schedule/);
  });

  it("applies a decision to steps starting at or after its simulation time", () => {
    const cursor = new ScheduleCursor(BudgetSchedule.from([
      { time: 0, limit: 10000, intensity: 1 }, { time: 2, limit: 8000, intensity: 1.1 }, { time: 2, limit: 6400, intensity: 1.25 }, { time: 5, limit: 7040, intensity: 1.2 },
    ]));
    expect([cursor.limit, cursor.intensity, cursor.applied]).toEqual([10000, 1, 1]);
    cursor.advance(1.999);
    expect(cursor.limit).toBe(10000);
    // Several decisions at one boundary: the last is in force.
    cursor.advance(2);
    expect([cursor.limit, cursor.intensity, cursor.applied]).toEqual([6400, 1.25, 3]);
    cursor.advance(10);
    expect([cursor.limit, cursor.applied]).toEqual([7040, 4]);
  });

  it("lists the decisions a trace applied with their callbacks and step start times", () => {
    const trace = new ReplayTrace(5);
    for (const [interval, limit, intensity] of [[0, 10000, 1], [1 / 30, 10000, 1], [1 / 30, 8000, 1.1], [1 / 30, 8000, 1.1], [1 / 30, 8000, 1.2]]) {
      trace.append(interval, 2, 960, 640, 1, 1, false, limit, intensity, true);
    }
    const step = Math.fround(1 / 30);
    expect(effectiveDecisions(trace)).toEqual([
      { callback: 0, time: 0, limit: 10000, intensity: 1 },
      { callback: 2, time: step, limit: 8000, intensity: 1.1 },
      { callback: 4, time: 3 * step, limit: 8000, intensity: 1.2 },
    ]);
    expect(effectiveDecisions(new ReplayTrace(0))).toEqual([]);
  });
});
