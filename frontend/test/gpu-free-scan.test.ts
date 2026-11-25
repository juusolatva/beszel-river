import { describe, expect, it } from "vitest";
import { GpuFreeScan } from "../src/sim/gpu-free-scan";
import { callsTo, createFakeGl } from "./fake-gl";

describe("GPU integer free scan", () => {
  for (const [capacity, width, height, passes] of [[1, 1, 1, 1], [31, 31, 1, 6], [33, 33, 1, 7], [100, 100, 1, 8], [10000, 128, 79, 15]]) {
    it(`scans all ${capacity} slots with complete integer targets and disjoint passes`, () => {
      const { gl, calls } = createFakeGl();
      const scan = new GpuFreeScan(gl, capacity);
      expect([scan.width, scan.height]).toEqual([width, height]);
      const buffer = gl.createBuffer()!;
      scan.scan(buffer);
      expect(callsTo(calls, "texImage2D")).toEqual(Array(2).fill(["TEXTURE_2D", 0, "R32UI", width, height, 0, "RED_INTEGER", "UNSIGNED_INT", null]));
      expect(callsTo(calls, "drawArrays")).toHaveLength(passes);
      expect(callsTo(calls, "drawArrays")[0]).toEqual(["POINTS", 0, capacity]);
      expect(callsTo(calls, "clearBufferuiv")[0]).toEqual(["COLOR", 0, new Uint32Array(4)]);
      expect(callsTo(calls, "vertexAttribIPointer")[0]).toEqual([3, 4, "UNSIGNED_INT", 64, 48]);
      expect(scan.prefixTexture).toBeTruthy();
      expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
      expect(callsTo(calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
      expect(callsTo(calls, "bindVertexArray").at(-1)).toEqual([null]);
      expect(callsTo(calls, "getBufferSubData")).toHaveLength(0);
      scan.dispose();
      expect(callsTo(calls, "deleteTexture")).toHaveLength(2);
      expect(callsTo(calls, "deleteFramebuffer")).toHaveLength(2);
      expect(callsTo(calls, "deleteProgram")).toHaveLength(2);
    });
  }

  it("rejects unavailable targets and cleans up both setup and draw failures", () => {
    for (const capacity of [0, -1, 1.5, NaN]) expect(() => new GpuFreeScan(createFakeGl().gl, capacity)).toThrow();
    for (const method of ["createTexture", "createFramebuffer", "createVertexArray"]) {
      const { gl, calls } = createFakeGl({ overrides: { [method]: () => null } });
      expect(() => new GpuFreeScan(gl, 1)).toThrow("GPU scan resource");
      expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    }
    const { gl } = createFakeGl({ overrides: { checkFramebufferStatus: () => "bad" } });
    expect(() => new GpuFreeScan(gl, 1)).toThrow("integer target");
    const failure = createFakeGl({ overrides: { drawArrays: () => { throw new Error("scan draw"); } } });
    const scan = new GpuFreeScan(failure.gl, 1);
    expect(() => scan.scan(failure.gl.createBuffer()!)).toThrow("scan draw");
    expect(callsTo(failure.calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    scan.dispose();
  });

  it("never samples its current attachment, including consecutive scans", () => {
    const { gl, calls } = createFakeGl();
    const scan = new GpuFreeScan(gl, 10000);
    scan.scan(gl.createBuffer()!); scan.scan(gl.createBuffer()!);
    const attachments = new Map<unknown, unknown>();
    let framebuffer: unknown, texture: unknown;
    for (const [name, ...args] of calls) {
      if (name === "bindFramebuffer") framebuffer = args[1];
      if (name === "framebufferTexture2D") attachments.set(framebuffer, args[3]);
      if (name === "bindTexture") texture = args[1];
      if (name === "drawArrays") expect(texture).not.toBe(attachments.get(framebuffer));
    }
    scan.dispose();
  });

  it("sets up one flag vertex array per state buffer and only the pass offset per scan", () => {
    const { gl, calls } = createFakeGl();
    const scan = new GpuFreeScan(gl, 100);
    const constants = callsTo(calls, "uniform1i").map(([location, value]) => [(location as { uniform: string }).uniform, value]);
    expect(constants).toEqual([["u_width", 100], ["u_height", 1], ["u_source", 0], ["u_width", 100], ["u_capacity", 100]]);
    const [a, b] = [gl.createBuffer()!, gl.createBuffer()!];
    scan.scan(a); scan.scan(b);
    expect(callsTo(calls, "createVertexArray")).toHaveLength(3);
    expect(callsTo(calls, "vertexAttribIPointer")).toHaveLength(2);
    const start = calls.length;
    scan.scan(a); scan.scan(b); scan.scan(a);
    const later = calls.slice(start);
    expect(callsTo(later, "createVertexArray")).toEqual([]);
    expect(callsTo(later, "vertexAttribIPointer")).toEqual([]);
    expect(callsTo(later, "enableVertexAttribArray")).toEqual([]);
    expect(new Set(callsTo(later, "uniform1i").map(([location]) => (location as { uniform: string }).uniform))).toEqual(new Set(["u_offset"]));
    const bound = callsTo(later, "bindVertexArray").filter(([vao]) => vao !== null).map(([vao]) => vao);
    // Per scan: its buffer's flag array, then the shared empty array.
    expect(bound).toHaveLength(6);
    expect(bound[0]).toBe(bound[4]);
    expect(bound[0]).not.toBe(bound[2]);
    expect(new Set([bound[1], bound[3], bound[5]]).size).toBe(1);
    expect(() => scan.scan(gl.createBuffer()!)).toThrow("state buffer changed");
    // Buffers named at construction are set up there, before any scan.
    const early = createFakeGl();
    const buffers = [early.gl.createBuffer()!, early.gl.createBuffer()!];
    const prepared = new GpuFreeScan(early.gl, 100, buffers);
    expect(callsTo(early.calls, "vertexAttribIPointer")).toHaveLength(2);
    expect(callsTo(early.calls, "bindVertexArray").at(-1)).toEqual([null]);
    const mark = early.calls.length;
    prepared.scan(buffers[1]);
    expect(callsTo(early.calls.slice(mark), "createVertexArray")).toEqual([]);
    prepared.dispose();
    expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    calls.length = 0;
    scan.dispose();
    expect(callsTo(calls, "deleteVertexArray")).toHaveLength(3);
  });

  it("scans only the rows holding the first `count` slots and sets the count only when it changes", () => {
    const { gl, calls } = createFakeGl();
    const scan = new GpuFreeScan(gl, 10000);
    const buffer = gl.createBuffer()!;
    for (const [count, rows, passes, setsCount] of [[300, 3, 9, true], [300, 3, 9, false], [1, 1, 0, true], [10000, 79, 14, true]] as const) {
      const start = calls.length;
      scan.scan(buffer, count);
      const step = calls.slice(start);
      expect(callsTo(step, "drawArrays")[0]).toEqual(["POINTS", 0, count]);
      expect(callsTo(step, "drawArrays").filter(([mode]) => mode === "TRIANGLES")).toHaveLength(passes);
      // The flag pass keeps the full viewport, which its point positions assume.
      expect(callsTo(step, "viewport")).toEqual([[0, 0, 128, 79], [0, 0, 128, rows]]);
      const counts = callsTo(step, "uniform1i").filter(([location]) => (location as { uniform: string }).uniform === "u_capacity");
      expect(counts).toEqual(setsCount ? [[{ uniform: "u_capacity" }, count]] : []);
    }
    for (const count of [0, -1, 1.5, 10001, NaN]) expect(() => scan.scan(buffer, count)).toThrow("Invalid GPU scan count");
    scan.dispose();
  });

  it("releases the first program when linking the second program fails", () => {
    let linked = 0;
    const { gl, calls } = createFakeGl({ overrides: { getProgramParameter: () => ++linked === 1 } });
    expect(() => new GpuFreeScan(gl, 31)).toThrow("Program link failed");
    const firstProgram = callsTo(calls, "attachShader")[0][0];
    expect(callsTo(calls, "deleteProgram")).toContainEqual([firstProgram]);
    expect(callsTo(calls, "deleteProgram")).toHaveLength(2);
  });
});
