import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { GPU_DRAIN_SECONDS } from "../src/sim/gpu-lifecycle";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { MAX_STREAMS, StreamSet } from "../src/sim/streams";
import { callsTo, createFakeGl, type Call } from "./fake-gl";

/** Values set for uniform `name` of the simulation program (the one with feedback varyings) from call `start`. */
function uniformCalls(calls: Call[], name: string, start = 0): unknown[][] {
  const simulation = calls.find(([method]) => method === "transformFeedbackVaryings")?.[1];
  let program: unknown;
  const values: unknown[][] = [];
  for (const [i, [method, location, ...rest]] of calls.entries()) {
    if (method === "useProgram") program = location;
    else if (i >= start && program === simulation && method.startsWith("uniform") && (location as { uniform?: string })?.uniform === name) values.push(rest);
  }
  return values;
}

function inputs() {
  const streams = new StreamSet(1);
  streams.apply({ streams: [{ id: "one", width: 0.6, flow: 0.5, density: 0.5, turbulence: 0.5,
    pulse: 0, heat: 0.5, alive: true }], v: 1, t: 0 });
  streams.update(0.1, 1);
  const field = new FlowField(() => 0.5);
  field.update(0, 1);
  return { streams, field };
}

describe("GPU motion orchestration", () => {
  it("prepares commands and scans before feedback only when spawning is enabled", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 1000, 42);
    const { streams, field } = inputs();
    gpu.spawningEnabled = true;
    gpu.lifecycle.advanceTime(Math.fround(0.1));
    gpu.step(0.1, streams, field, 1);
    expect(gpu.lifecycle.commands[MAX_STREAMS * 4 - 1]).toBeGreaterThan(0);
    const draws = callsTo(calls, "drawArrays");
    expect(draws).toHaveLength(12); // flag + 10 scan + feedback
    expect(draws.at(-1)).toEqual(["POINTS", 0, 1000]);
    const uploads = callsTo(calls, "texSubImage2D");
    expect(uploads.at(-1)!.slice(4, 8)).toEqual([1, 32, "RGBA_INTEGER", "UNSIGNED_INT"]);
    expect(uploads.at(-1)![8]).toBe(gpu.lifecycle.commands);
    expect(callsTo(calls, "getBufferSubData")).toHaveLength(0);
    expect(callsTo(calls, "finish")).toHaveLength(0);
    expect(uniformCalls(calls, "u_enabled").at(-1)).toEqual([1]);
    gpu.dispose();
  });

  it("skips the free scan without birth requests but still uploads the commands", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 1000, 42);
    const { streams, field } = inputs();
    gpu.spawningEnabled = true;
    gpu.limit = 0; // no room, so every stream requests nothing
    let start = calls.length;
    gpu.step(0.1, streams, field, 1);
    let step = calls.slice(start);
    expect(gpu.lifecycle.commands[MAX_STREAMS * 4 - 1]).toBe(0);
    expect(callsTo(step, "drawArrays")).toEqual([["POINTS", 0, 1000]]);
    expect(callsTo(step, "clearBufferuiv")).toHaveLength(0);
    expect(uniformCalls(calls, "u_enabled", start)).toEqual([[0]]);
    expect(callsTo(step, "texSubImage2D").at(-1)![8]).toBe(gpu.lifecycle.commands);
    // Requests return with room; the scan runs again.
    gpu.limit = 1000;
    start = calls.length;
    gpu.step(0.1, streams, field, 1);
    step = calls.slice(start);
    expect(callsTo(step, "drawArrays")).toHaveLength(12);
    expect(uniformCalls(calls, "u_enabled", start)).toEqual([[1]]);
    gpu.dispose();
  });

  it("sets samplers, sizes and LOOK uniforms once at setup and only per-step values in a step", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 33, 42);
    const constants = ["u_flow", "u_stream", "u_command", "u_prefix", "u_width", "u_capacity", "u_seed",
      "u_birth", "u_lifeSize", "u_filament", "u_span", "u_cell", "u_braid"];
    for (const name of constants) expect(uniformCalls(calls, name), name).toHaveLength(1);
    expect(uniformCalls(calls, "u_width")).toEqual([[33]]);
    expect(uniformCalls(calls, "u_capacity")).toEqual([[33]]);
    expect(uniformCalls(calls, "u_seed")).toEqual([[42]]);
    expect(uniformCalls(calls, "u_prefix")).toEqual([[3]]);
    const { streams, field } = inputs();
    expect(uniformCalls(calls, "u_cell")).toEqual([[field.gridCell]]);
    expect(uniformCalls(calls, "u_braid")).toEqual([[LOOK.braid, LOOK.braidWaves]]);
    const start = calls.length;
    gpu.step(1 / 60, streams, field, 1);
    gpu.step(1 / 60, streams, field, 1);
    for (const name of constants) expect(uniformCalls(calls, name, start), name).toHaveLength(0);
    for (const name of ["u_limit", "u_enabled", "u_dt", "u_bounds", "u_physics"]) expect(uniformCalls(calls, name, start), name).toHaveLength(2);
    gpu.dispose();
  });

  it("uploads the flow field's own grid without copying it", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 8, 42);
    const { streams, field } = inputs();
    gpu.step(1 / 60, streams, field, 1);
    const flow = callsTo(calls, "texSubImage2D").find((args) => args[6] === "RG")!;
    expect(flow.slice(4, 6)).toEqual([field.gridCols, field.gridRows]);
    expect(flow[8]).toBe(field.vectors);
    gpu.dispose();
  });

  describe("active horizon", () => {
    const dt = Math.fround(0.1);
    /** Steps until the drain deadline has passed since the first step, then two more: the shrink step. */
    function shrinkStep(): number {
      let clock = 0, n = 0;
      while (clock <= GPU_DRAIN_SECONDS) { clock += dt; n++; }
      return n + 2;
    }
    function feedbackCounts(calls: Call[], start: number): number[] {
      // The feedback pass is the only POINTS draw issued with transform feedback begun.
      const counts: number[] = [];
      let begun = false;
      for (const [name, ...args] of calls.slice(start)) {
        if (name === "beginTransformFeedback") begun = true;
        if (name === "endTransformFeedback") begun = false;
        if (name === "drawArrays" && begun) counts.push(args[2] as number);
      }
      return counts;
    }

    it("drops to zero after the drain deadline without requests, then rises at once with them", () => {
      const { gl, calls } = createFakeGl();
      const gpu = new GpuParticles(gl, 1000, 42);
      const { streams, field } = inputs();
      gpu.spawningEnabled = true;
      gpu.limit = 0;
      const last = shrinkStep();
      for (let n = 1; n < last; n++) {
        gpu.step(dt, streams, field, 1);
        expect(gpu.activeSlots, `step ${n}`).toBe(1000);
      }
      const before = calls.length, hue = gpu.globalHue, buffer = gpu.stateBuffer;
      gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(0);
      // No pass, upload or binding at all; only the hue moves on.
      expect(calls.slice(before)).toEqual([]);
      expect(gpu.globalHue).toBeCloseTo(hue + LOOK.hueRotate * dt);
      expect(gpu.stateBuffer).toBe(buffer);

      gpu.limit = 600;
      const start = calls.length;
      gpu.step(dt, streams, field, 1);
      expect(gpu.lifecycle.commands[MAX_STREAMS * 4 - 1]).toBeGreaterThan(0);
      expect(gpu.activeSlots).toBe(600);
      expect(feedbackCounts(calls, start)).toEqual([600]);
      // The flag pass covers 600 slots and the prefix passes the five rows that hold them.
      const step = calls.slice(start);
      expect(callsTo(step, "drawArrays")[0]).toEqual(["POINTS", 0, 600]);
      expect(callsTo(step, "drawArrays").filter(([mode]) => mode === "TRIANGLES")).toHaveLength(10);
      expect(callsTo(step, "viewport")).toContainEqual([0, 0, 128, 5]);
      expect(uniformCalls(calls, "u_capacity", start)).toEqual([[600]]);
      gpu.dispose();
    });

    it("shrinks to a lowered limit only after the deadline and two full steps", () => {
      const { gl, calls } = createFakeGl();
      const gpu = new GpuParticles(gl, 1000, 42);
      const { streams, field } = inputs();
      gpu.spawningEnabled = true;
      gpu.step(dt, streams, field, 1);
      gpu.limit = 400;
      const start = calls.length;
      // The claim starts on the step that first sees the lower limit, one step later than a claim
      // that holds from construction.
      const last = shrinkStep() + 1;
      for (let n = 1; n < last; n++) gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(1000);
      expect(feedbackCounts(calls, start).every((count) => count === 1000)).toBe(true);
      const mark = calls.length;
      gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(400);
      expect(feedbackCounts(calls, mark)).toEqual([400]);
      expect(uniformCalls(calls, "u_capacity", mark)).toEqual([[400]]);
      const mark2 = calls.length;
      gpu.step(dt, streams, field, 1);
      // Set once per change.
      expect(uniformCalls(calls, "u_capacity", mark2)).toEqual([]);
      gpu.dispose();
    });

    it("restarts the wait when the reach climbs back to the horizon", () => {
      const { gl } = createFakeGl();
      const gpu = new GpuParticles(gl, 1000, 42);
      const { streams, field } = inputs();
      gpu.spawningEnabled = true;
      gpu.limit = 0;
      const last = shrinkStep();
      for (let n = 1; n < last - 5; n++) gpu.step(dt, streams, field, 1);
      gpu.limit = 1000;
      gpu.step(dt, streams, field, 1);
      gpu.limit = 0;
      for (let n = 0; n < 10; n++) gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(1000);
      gpu.dispose();
    });

    it("never shrinks while spawning is off, since preloaded particles may live anywhere", () => {
      const { gl } = createFakeGl();
      const gpu = new GpuParticles(gl, 1000, 42);
      const { streams, field } = inputs();
      for (let n = 0; n < 2 * shrinkStep(); n++) gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(1000);
      // Turning spawning on starts the wait from that step.
      gpu.spawningEnabled = true;
      gpu.limit = 0;
      for (let n = 1; n < shrinkStep() + 1; n++) gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(1000);
      gpu.step(dt, streams, field, 1);
      expect(gpu.activeSlots).toBe(0);
      gpu.dispose();
    });
  });

  it("bounds the simulation shader's stream loop by MAX_STREAMS", () => {
    const source = readFileSync(new URL("../src/render/shaders/simulate.vert", import.meta.url), "utf8");
    expect(source).toContain(`#define MAX_STREAMS ${MAX_STREAMS}\n`);
    expect(source.replace(/#define MAX_STREAMS \d+/, "")).not.toMatch(/\b3[12]u?\b/);
  });

  it("allocates two fixed buffers and binds the integer identity without conversion", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 8, 42);
    expect(gpu.capacity).toBe(8);
    expect(gpu.limit).toBe(8);
    expect(gpu.spawningEnabled).toBe(false);
    expect(gpu.stateStrideBytes).toBe(64);
    expect(gpu.streamTexture).not.toBe(gpu.commandTexture);
    expect(callsTo(calls, "bufferData")).toEqual([["ARRAY_BUFFER", 512, "DYNAMIC_COPY"], ["ARRAY_BUFFER", 512, "DYNAMIC_COPY"]]);
    // Simulation and free-scan vertex arrays, one of each per state buffer.
    expect(callsTo(calls, "vertexAttribIPointer")).toEqual(Array(4).fill([3, 4, "UNSIGNED_INT", 64, 48]));
    expect(callsTo(calls, "vertexAttribPointer").slice(0, 3)).toEqual([
      [0, 4, "FLOAT", false, 64, 0], [1, 4, "FLOAT", false, 64, 16], [2, 4, "FLOAT", false, 64, 32],
    ]);
    gpu.dispose();
    expect(callsTo(calls, "deleteBuffer")).toHaveLength(2);
    expect(callsTo(calls, "deleteTexture")).toHaveLength(5);
    // Two state arrays, and the scan's empty array and one flag array per state buffer.
    expect(callsTo(calls, "deleteVertexArray")).toHaveLength(5);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
    expect(callsTo(calls, "deleteProgram")).toHaveLength(3);
  });

  it("swaps distinct buffers, uploads cached textures and reallocates only a resized flow grid", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 8, 42);
    const { streams, field } = inputs();
    const first = gpu.stateBuffer;
    gpu.step(0, streams, field, 1);
    gpu.step(-1, streams, field, 1);
    expect(gpu.stateBuffer).toBe(first);
    expect(gpu.globalHue).toBe(0);
    expect(callsTo(calls, "drawArrays")).toHaveLength(0);
    gpu.step(1 / 60, streams, field, 1);
    expect(gpu.stateBuffer).not.toBe(first);
    expect(gpu.globalHue).toBeCloseTo(LOOK.hueRotate / 60);
    // CPU compares Float32 positions against double-precision world bounds.
    expect(callsTo(calls, "uniform4f").find(args => (args[0] as { uniform: string }).uniform === "u_bounds")!.slice(1)).toEqual([Math.fround(-0.1), Math.fround(1.08), Math.fround(1.1), 1]);
    const images = callsTo(calls, "texImage2D").length;
    const queries = callsTo(calls, "getParameter").length;
    const uniformQueries = callsTo(calls, "getUniformLocation").length;
    gpu.step(1 / 60, streams, field, 1);
    expect(gpu.stateBuffer).toBe(first);
    expect(callsTo(calls, "texImage2D")).toHaveLength(images);
    expect(callsTo(calls, "getParameter")).toHaveLength(queries);
    expect(callsTo(calls, "getUniformLocation")).toHaveLength(uniformQueries);
    expect(callsTo(calls, "texSubImage2D")).toHaveLength(4);
    expect(callsTo(calls, "texSubImage2D")[1][8]).toBeInstanceOf(Float32Array);
    const streamData = callsTo(calls, "texSubImage2D")[1][8] as Float32Array;
    expect(streamData[0]).toBeCloseTo(streams.slots[0].center);
    expect(streamData[32]).toBeCloseTo(streams.slots[0].centerAt(-0.02));
    field.update(1, 2);
    gpu.step(0.1, streams, field, 2);
    expect(callsTo(calls, "texImage2D")).toHaveLength(images + 1);
    expect(callsTo(calls, "drawArrays")).toEqual(Array(3).fill(["POINTS", 0, 8]));
    expect(callsTo(calls, "bindBufferBase").at(-1)).toEqual(["TRANSFORM_FEEDBACK_BUFFER", 0, null]);
    expect(callsTo(calls, "bindBuffer").at(-1)).toEqual(["ARRAY_BUFFER", null]);
    expect(callsTo(calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
    expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    gpu.dispose();
  });

  it("cleans up a begun feedback pass after a draw failure without swapping", () => {
    const { gl, calls } = createFakeGl({ overrides: { drawArrays: () => { throw new Error("draw failed"); } } });
    const gpu = new GpuParticles(gl, 2, 1);
    const first = gpu.stateBuffer;
    const { streams, field } = inputs();
    expect(() => gpu.step(0.1, streams, field, 1)).toThrow("draw failed");
    expect(gpu.stateBuffer).toBe(first);
    expect(gpu.globalHue).toBe(0);
    expect(callsTo(calls, "endTransformFeedback")).toHaveLength(1);
    expect(callsTo(calls, "disable").at(-1)).toEqual(["RASTERIZER_DISCARD"]);
    expect(callsTo(calls, "bindBufferBase").at(-1)).toEqual(["TRANSFORM_FEEDBACK_BUFFER", 0, null]);
    expect(callsTo(calls, "bindTransformFeedback").at(-1)).toEqual(["TRANSFORM_FEEDBACK", null]);
    gpu.dispose();
  });

  it("cleans bindings when begin or input upload fails before feedback starts", () => {
    for (const method of ["beginTransformFeedback", "texSubImage2D"]) {
      const { gl, calls } = createFakeGl({ overrides: { [method]: () => { throw new Error(method); } } });
      const gpu = new GpuParticles(gl, 1, 1);
      const { streams, field } = inputs();
      expect(() => gpu.step(0.1, streams, field, 1)).toThrow(method);
      expect(callsTo(calls, "endTransformFeedback")).toHaveLength(0);
      expect(callsTo(calls, "bindBufferBase").at(-1)).toEqual(["TRANSFORM_FEEDBACK_BUFFER", 0, null]);
      expect(callsTo(calls, "bindVertexArray").at(-1)).toEqual([null]);
      expect(callsTo(calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
      gpu.dispose();
    }
  });

  it("clears bindings even if ending feedback fails", () => {
    const { gl, calls } = createFakeGl({ overrides: { endTransformFeedback: () => { throw new Error("end failed"); } } });
    const gpu = new GpuParticles(gl, 1, 1);
    const { streams, field } = inputs();
    const first = gpu.stateBuffer;
    expect(() => gpu.step(0.1, streams, field, 1)).toThrow("end failed");
    expect(callsTo(calls, "endTransformFeedback")).toHaveLength(1);
    expect(callsTo(calls, "bindBufferBase").at(-1)).toEqual(["TRANSFORM_FEEDBACK_BUFFER", 0, null]);
    expect(callsTo(calls, "disable").at(-1)).toEqual(["RASTERIZER_DISCARD"]);
    expect(gpu.stateBuffer).toBe(first);
    gpu.dispose();
  });

  it("the fake rejects indexed feedback outputs reused as vertex attributes", () => {
    const { gl } = createFakeGl();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(gl.createVertexArray());
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, 64, 48);
    expect(() => gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer)).toThrow("also feedback output");
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    expect(() => gl.bindVertexArray(null)).not.toThrow();
  });

  it("rejects invalid capacities, missing resources, unsupported limits and unprepared grids", () => {
    for (const n of [0, -1, 1.5, NaN]) expect(() => new GpuParticles(createFakeGl().gl, n, 1)).toThrow("capacity");
    for (const name of ["createBuffer", "createTexture", "createVertexArray", "createTransformFeedback"])
      expect(() => new GpuParticles(createFakeGl({ overrides: { [name]: () => null } }).gl, 1, 1)).toThrow("GPU resource");
    for (const name of ["MAX_VERTEX_TEXTURE_IMAGE_UNITS", "MAX_VERTEX_ATTRIBS", "MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS", "MAX_TEXTURE_SIZE"]) {
      const { gl } = createFakeGl({ overrides: { getParameter: (p) => p === name ? 0 : 4096 } });
      expect(() => new GpuParticles(gl, 1, 1)).toThrow("GPU motion unsupported");
    }
    const gpu = new GpuParticles(createFakeGl().gl, 1, 1);
    const ready = inputs();
    for (const dt of [NaN, Infinity, 1 / 360, 0.2]) expect(() => gpu.step(dt, ready.streams, ready.field, 1)).toThrow("GPU step");
    expect(() => gpu.step(0.1, new StreamSet(1), new FlowField(() => 0.5), 1)).toThrow("flow grid");
    gpu.dispose();
  });
});
