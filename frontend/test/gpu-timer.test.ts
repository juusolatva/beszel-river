import { describe, expect, it } from "vitest";
import { callsTo, createFakeGl } from "./fake-gl";
import { GpuTimer, TIMER_EXTENSION } from "./fixtures/gpu-timer";

const EXT = { TIME_ELAPSED_EXT: "TIME_ELAPSED_EXT", GPU_DISJOINT_EXT: "GPU_DISJOINT_EXT" };

/** Fake context offering the timer extension; `ready` and `disjoint` steer query availability and the disjoint flag. */
function timerGl(state: { ready: boolean; disjoint?: boolean }, extension: object | null = EXT) {
  return createFakeGl({ overrides: {
    getExtension: (name) => (name === TIMER_EXTENSION ? extension : null),
    // Query n's elapsed time is n ms, so samples show which query they came from.
    getQueryParameter: (query, pname) => (pname === "QUERY_RESULT_AVAILABLE" ? state.ready : (query as { n: number }).n * 1e6),
    getParameter: (pname) => (pname === "GPU_DISJOINT_EXT" ? !!state.disjoint : 4096),
  } });
}

/** One timed callback: simulation query, then render query. */
function timeCallback(timer: GpuTimer, callback: number): boolean {
  if (!timer.beginSimulation(callback)) return false;
  timer.beginRender();
  timer.endRender();
  return true;
}

describe("GpuTimer", () => {
  it("reports a disabled run or a missing extension instead of timing anything", () => {
    const { gl, calls } = timerGl({ ready: true }, null);
    expect(GpuTimer.create(gl, false, 10)).toBe("disabled (gpuTiming: false)");
    expect(GpuTimer.create(gl, true, 10)).toBe(`unavailable: ${TIMER_EXTENSION} not supported`);
    expect(callsTo(calls, "createQuery")).toEqual([]);
  });

  it("preallocates two queries per ring slot and releases them if one cannot be created", () => {
    const { gl, calls } = timerGl({ ready: true });
    const timer = GpuTimer.create(gl, true, 10, 4) as GpuTimer;
    expect(callsTo(calls, "createQuery")).toHaveLength(8);
    timer.dispose();
    expect(callsTo(calls, "deleteQuery")).toHaveLength(8);

    let created = 0;
    const failing = createFakeGl({ overrides: { getExtension: () => EXT, createQuery: () => (++created < 3 ? { n: created } : null) } });
    expect(() => GpuTimer.create(failing.gl, true, 10, 4)).toThrow(/createQuery failed/);
    expect(callsTo(failing.calls, "deleteQuery")).toHaveLength(2);
  });

  it("times simulation and rendering with consecutive, never nested, TIME_ELAPSED queries", () => {
    const { gl, calls } = timerGl({ ready: false });
    const timer = GpuTimer.create(gl, true, 10, 2) as GpuTimer;
    calls.length = 0;
    timeCallback(timer, 7);
    expect(calls.map(([name, ...args]) => [name, args[0]])).toEqual([
      ["beginQuery", "TIME_ELAPSED_EXT"], ["endQuery", "TIME_ELAPSED_EXT"], ["beginQuery", "TIME_ELAPSED_EXT"], ["endQuery", "TIME_ELAPSED_EXT"],
    ]);
    const [first, second] = callsTo(calls, "beginQuery").map(([, query]) => query);
    expect(first).not.toBe(second);
    expect(() => { timer.beginSimulation(8); timer.beginSimulation(9); }).toThrow(/already active/);
  });

  it("reads completed slots in order without waiting and converts nanoseconds to milliseconds", () => {
    const state = { ready: false };
    const { gl } = timerGl(state);
    const timer = GpuTimer.create(gl, true, 10, 4) as GpuTimer;
    timeCallback(timer, 3);
    timeCallback(timer, 4);
    // Not ready: nothing is read and nothing waits.
    timer.poll();
    expect([timer.samples, timer.inFlight]).toEqual([0, 2]);
    state.ready = true;
    timer.poll();
    expect([timer.samples, timer.inFlight]).toEqual([2, 0]);
    // Queries 1–8 belong to slots 0–3 (simulation, render); callbacks 3 and 4 used slots 0 and 1.
    expect([...timer.simulationMs.slice(0, 2)]).toEqual([1, 3]);
    expect([...timer.renderMs.slice(0, 2)]).toEqual([2, 4]);
    expect([...timer.callback.slice(0, 2)]).toEqual([3, 4]);
    // The ring wraps: slots 2, 3, then 0 again.
    for (const callback of [5, 6, 7]) timeCallback(timer, callback);
    timer.poll();
    expect([...timer.renderMs.slice(2, 5)]).toEqual([6, 8, 2]);
    expect([...timer.callback.slice(0, 5)]).toEqual([3, 4, 5, 6, 7]);
  });

  it("leaves a callback untimed when every slot is still in flight", () => {
    const state = { ready: false };
    const { gl, calls } = timerGl(state);
    const timer = GpuTimer.create(gl, true, 10, 2) as GpuTimer;
    expect(timeCallback(timer, 0)).toBe(true);
    expect(timeCallback(timer, 1)).toBe(true);
    const begun = callsTo(calls, "beginQuery").length;
    expect(timeCallback(timer, 2)).toBe(false);
    expect(callsTo(calls, "beginQuery")).toHaveLength(begun);
    expect(timer.skipped).toBe(1);
    state.ready = true;
    timer.poll();
    expect(timeCallback(timer, 3)).toBe(true);
    timer.poll();
    expect([...timer.callback.slice(0, timer.samples)]).toEqual([0, 1, 3]);
  });

  it("discards every sample in flight, read or not, after a disjoint event", () => {
    const state = { ready: true, disjoint: true };
    const { gl } = timerGl(state);
    const timer = GpuTimer.create(gl, true, 10, 4) as GpuTimer;
    timeCallback(timer, 0);
    timeCallback(timer, 1);
    timer.poll();
    expect([timer.samples, timer.discarded, timer.inFlight]).toEqual([0, 2, 0]);
    // Later callbacks time normally once the flag clears.
    state.disjoint = false;
    timeCallback(timer, 2);
    timer.poll();
    expect([timer.samples, [...timer.callback.slice(0, 1)]]).toEqual([1, [2]]);
  });

  it("ends an active query on dispose, as after a failure mid-callback", () => {
    const { gl, calls } = timerGl({ ready: false });
    const timer = GpuTimer.create(gl, true, 10, 2) as GpuTimer;
    timer.beginSimulation(0);
    timer.dispose();
    expect(callsTo(calls, "endQuery")).toHaveLength(1);
    expect(callsTo(calls, "deleteQuery")).toHaveLength(4);
    timer.dispose();
    expect(callsTo(calls, "endQuery")).toHaveLength(1);
  });
});
