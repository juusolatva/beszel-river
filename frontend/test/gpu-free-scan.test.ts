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
});
