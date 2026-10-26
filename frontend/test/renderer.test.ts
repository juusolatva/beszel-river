import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";
import { INSTANCE_FLOATS } from "../src/sim/particles";
import { callsTo, createFakeGl, type Call } from "./fake-gl";

/** Texture each frame's present pass reads, and the framebuffer its fade pass writes. */
function passes(calls: Call[]): { read: unknown; wrote: unknown } {
  const binds = callsTo(calls, "bindFramebuffer").filter(([, framebuffer]) => framebuffer !== null);
  const textures = callsTo(calls, "bindTexture").filter(([, texture]) => texture !== null);
  return { wrote: binds.at(-1)?.[1], read: textures.at(-1)?.[1] };
}

describe("Renderer", () => {
  it("allocates the instance buffer for the whole pool and sets up per-instance attributes", () => {
    const { gl, calls } = createFakeGl({ halfFloat: true });
    new Renderer(gl, 1000);
    expect(callsTo(calls, "bufferData")[1]).toEqual(["ARRAY_BUFFER", 1000 * INSTANCE_FLOATS * 4, "DYNAMIC_DRAW"]);
    expect(callsTo(calls, "vertexAttribDivisor")).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    const stride = INSTANCE_FLOATS * 4;
    expect(callsTo(calls, "vertexAttribPointer").slice(1)).toEqual([
      [1, 4, "FLOAT", false, stride, 0],
      [2, 4, "FLOAT", false, stride, 16],
      [3, 1, "FLOAT", false, stride, 32],
    ]);
    // Three programs: particles, fade and present.
    expect(callsTo(calls, "linkProgram")).toHaveLength(3);
  });

  it("draws nothing before the first resize", () => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 10);
    calls.length = 0;
    renderer.render(new Float32Array(10 * INSTANCE_FLOATS), 5, 1 / 60, 1);
    expect(calls).toEqual([]);
  });

  it("uses half-float targets when available, and replaces them only when the size changes", () => {
    const { gl, calls } = createFakeGl({ halfFloat: true });
    const renderer = new Renderer(gl, 10);
    renderer.resize(800, 600);
    expect(callsTo(calls, "texImage2D").map(([, , format]) => format)).toEqual(["RGBA16F", "RGBA16F"]);

    calls.length = 0;
    renderer.resize(800, 600);
    expect(calls).toEqual([]);

    renderer.resize(1024, 768);
    expect(callsTo(calls, "deleteTexture")).toHaveLength(2);
    expect(callsTo(calls, "texImage2D").map(([, , , width, height]) => [width, height])).toEqual([
      [1024, 768],
      [1024, 768],
    ]);
  });

  it("falls back to 8-bit targets when half-float ones are advertised but not renderable, and stays there", () => {
    const { gl, calls } = createFakeGl({ halfFloat: true, complete: { RGBA16F: false } });
    const renderer = new Renderer(gl, 10);
    renderer.resize(800, 600);
    expect(callsTo(calls, "texImage2D").map(([, , format]) => format)).toEqual(["RGBA16F", "RGBA16F", "RGBA8", "RGBA8"]);

    calls.length = 0;
    renderer.resize(400, 300);
    expect(callsTo(calls, "texImage2D").map(([, , format]) => format)).toEqual(["RGBA8", "RGBA8"]);

    // The fade floor follows the 8-bit precision.
    calls.length = 0;
    renderer.render(new Float32Array(0), 0, 1 / 60, 1);
    expect(callsTo(calls, "uniform1f")).toContainEqual([{ uniform: "u_floor" }, 1.5 / 255]);
  });

  it("fails when no render target can be made", () => {
    const { gl } = createFakeGl({ complete: { RGBA8: false } });
    const renderer = new Renderer(gl, 10);
    expect(() => renderer.resize(800, 600)).toThrow("Cannot create render targets");
  });

  it("fades into one target, adds the particles, presents it, and swaps the targets every frame", () => {
    const { gl, calls } = createFakeGl({ halfFloat: true });
    const renderer = new Renderer(gl, 100);
    renderer.resize(800, 600);
    const instances = new Float32Array(100 * INSTANCE_FLOATS);

    calls.length = 0;
    renderer.render(instances, 40, 0.02, 4 / 3);
    const first = passes(calls);
    expect(callsTo(calls, "viewport")).toEqual([[0, 0, 800, 600]]);
    expect(callsTo(calls, "bufferSubData")).toEqual([["ARRAY_BUFFER", 0, instances, 0, 40 * INSTANCE_FLOATS]]);
    expect(callsTo(calls, "drawArraysInstanced")).toEqual([["TRIANGLE_STRIP", 0, 4, 40]]);
    expect(callsTo(calls, "drawArrays")).toHaveLength(2);
    expect(callsTo(calls, "blendFunc")).toEqual([["ONE", "ONE"]]);
    const uniforms = new Map(callsTo(calls, "uniform1f").map(([location, value]) => [(location as { uniform: string }).uniform, value]));
    expect(uniforms.get("u_decay")).toBeCloseTo(Math.exp(-0.02 / LOOK.trailTau));
    expect(uniforms.get("u_floor")).toBe(0.0005);
    expect(uniforms.get("u_aspect")).toBe(4 / 3);
    expect(uniforms.get("u_pixel")).toBe(1 / 600);
    expect(uniforms.get("u_exposure")).toBe(LOOK.exposure);
    // Ends on the default framebuffer.
    expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);

    calls.length = 0;
    renderer.render(instances, 40, 0.02, 4 / 3);
    const second = passes(calls);
    expect(second.wrote).not.toBe(first.wrote);
    expect(second.read).not.toBe(first.read);

    calls.length = 0;
    renderer.render(instances, 40, 0.02, 4 / 3);
    expect(passes(calls)).toEqual(first);
  });

  it("skips the particle pass without particles", () => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 10);
    renderer.resize(100, 100);
    calls.length = 0;
    renderer.render(new Float32Array(10 * INSTANCE_FLOATS), 0, 1 / 60, 1);
    expect(callsTo(calls, "drawArraysInstanced")).toEqual([]);
    expect(callsTo(calls, "bufferSubData")).toEqual([]);
    expect(callsTo(calls, "drawArrays")).toHaveLength(2);
  });
});
