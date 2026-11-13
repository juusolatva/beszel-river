import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { callsTo, createFakeGl } from "./fake-gl";

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
  it("allocates two fixed buffers and binds the integer identity without conversion", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 8, 42);
    expect(gpu.capacity).toBe(8);
    expect(gpu.limit).toBe(8);
    expect(gpu.spawningEnabled).toBe(false);
    expect(gpu.stateStrideBytes).toBe(64);
    expect(gpu.streamTexture).not.toBe(gpu.commandTexture);
    expect(callsTo(calls, "bufferData")).toEqual([["ARRAY_BUFFER", 512, "DYNAMIC_COPY"], ["ARRAY_BUFFER", 512, "DYNAMIC_COPY"]]);
    expect(callsTo(calls, "vertexAttribIPointer")).toEqual([[3, 4, "UNSIGNED_INT", 64, 48], [3, 4, "UNSIGNED_INT", 64, 48]]);
    expect(callsTo(calls, "vertexAttribPointer").slice(0, 3)).toEqual([
      [0, 4, "FLOAT", false, 64, 0], [1, 4, "FLOAT", false, 64, 16], [2, 4, "FLOAT", false, 64, 32],
    ]);
    gpu.dispose();
    expect(callsTo(calls, "deleteBuffer")).toHaveLength(2);
    expect(callsTo(calls, "deleteTexture")).toHaveLength(3);
    expect(callsTo(calls, "deleteVertexArray")).toHaveLength(2);
    expect(callsTo(calls, "deleteTransformFeedback")).toHaveLength(1);
    expect(callsTo(calls, "deleteProgram")).toHaveLength(1);
  });

  it("swaps distinct buffers, uploads cached textures and reallocates only a resized flow grid", () => {
    const { gl, calls } = createFakeGl();
    const gpu = new GpuParticles(gl, 8, 42);
    const { streams, field } = inputs();
    const first = gpu.stateBuffer;
    gpu.step(0, streams, field, 1);
    expect(gpu.stateBuffer).toBe(first);
    expect(gpu.globalHue).toBe(0);
    expect(callsTo(calls, "drawArrays")).toHaveLength(0);
    gpu.step(1 / 60, streams, field, 1);
    expect(gpu.stateBuffer).not.toBe(first);
    expect(gpu.globalHue).toBeCloseTo(LOOK.hueRotate / 60);
    // CPU compares Float32 positions against double-precision world bounds.
    expect(callsTo(calls, "uniform4f")[0].slice(1)).toEqual([Math.fround(-0.1), Math.fround(1.08), Math.fround(1.1), 1]);
    const images = callsTo(calls, "texImage2D").length;
    const queries = callsTo(calls, "getParameter").length;
    gpu.step(1 / 60, streams, field, 1);
    expect(gpu.stateBuffer).toBe(first);
    expect(callsTo(calls, "texImage2D")).toHaveLength(images);
    expect(callsTo(calls, "getParameter")).toHaveLength(queries);
    expect(callsTo(calls, "getUniformLocation")).toHaveLength(7);
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
    expect(() => gpu.step(0.1, new StreamSet(1), new FlowField(() => 0.5), 1)).toThrow("flow grid");
    gpu.dispose();
  });
});
