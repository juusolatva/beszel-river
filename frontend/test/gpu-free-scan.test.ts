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

  it("copies the total at the last counted slot from the final prefix target into a pack buffer", () => {
    const { gl, calls } = createFakeGl();
    const scan = new GpuFreeScan(gl, 10000);
    const state = gl.createBuffer()!, pack = gl.createBuffer()!;
    scan.scan(state, 1000);
    // The read must name the framebuffer the final prefix texture is attached to.
    const attachments = new Map<unknown, unknown>();
    let bound: unknown;
    for (const [name, ...args] of calls) {
      if (name === "bindFramebuffer") bound = args[1];
      if (name === "framebufferTexture2D") attachments.set(args[3], bound);
    }
    const prefixFramebuffer = attachments.get(scan.prefixTexture);
    expect(prefixFramebuffer).toBeTruthy();
    calls.length = 0;
    scan.copyTotal(1000, pack);
    // Slot 999 is texel (999 % 128, floor(999 / 128)) = (103, 7).
    expect(callsTo(calls, "readPixels")).toEqual([[103, 7, 1, 1, "RGBA_INTEGER", "UNSIGNED_INT", 0]]);
    expect(callsTo(calls, "bindBuffer")).toEqual([["PIXEL_PACK_BUFFER", pack], ["PIXEL_PACK_BUFFER", null]]);
    expect(callsTo(calls, "bindFramebuffer")).toEqual([["READ_FRAMEBUFFER", prefixFramebuffer], ["READ_FRAMEBUFFER", null]]);
    calls.length = 0;
    scan.copyTotal(1, pack);
    expect(callsTo(calls, "readPixels")[0].slice(0, 2)).toEqual([0, 0]);
    for (const count of [0, 10001, 1.5]) expect(() => scan.copyTotal(count, pack)).toThrow("Invalid GPU scan count");
  });

  it("reads the target the last pass wrote, for even and odd pass counts", () => {
    for (const [count, expected] of [[1, 0], [2, 1], [3, 0], [5, 1]] as const) {
      const { gl, calls } = createFakeGl();
      const scan = new GpuFreeScan(gl, 16);
      // Framebuffers are labelled objects; recover them in creation order from their bind calls.
      const order: unknown[] = [];
      for (const [target, framebuffer] of callsTo(calls, "bindFramebuffer")) if (target === "FRAMEBUFFER" && framebuffer && !order.includes(framebuffer)) order.push(framebuffer);
      scan.scan(gl.createBuffer()!, count);
      calls.length = 0;
      scan.copyTotal(count, gl.createBuffer()!);
      expect(callsTo(calls, "bindFramebuffer")[0]).toEqual(["READ_FRAMEBUFFER", order[expected]]);
    }
  });
});
