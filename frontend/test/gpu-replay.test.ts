import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { callsTo, createFakeGl } from "./fake-gl";
import { compareGpuStates, CpuReplay, fiveSecondWindows, GpuReplay, MIN_GPU_STEP, REPLAY_CAPACITY, ReplayTrace, replayableStep,
  replayFrames, replayFrameIndex, replayIds, summarizeOccupancy, validateCpuTrace, validateGpuTrace } from "./fixtures/gpu-replay";

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
    expect([1 / 300, 1e-6].some(replayableStep)).toBe(false);
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
    windows.forEach((w, k) => expect(w.start).toBeCloseTo(5 * k, 5));
    expect(windows[0]).toMatchObject({ frames: [2], total: 100 });
    expect(windows[0].perSlot[3]).toBe(100);
    expect(windows[1].frames).toEqual([2, 4]);
    expect(windows[2]).toMatchObject({ frames: [4], total: 40 });
  });
});
