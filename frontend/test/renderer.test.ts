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
  it("normalizes deposits and the trail floor against 60 Hz decay", () => {
    const { gl, calls } = createFakeGl({ halfFloat: true });
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    const instances = new Float32Array(INSTANCE_FLOATS);
    const referenceBrightness = (1 - 0.0005) / (1 - Math.exp(-(1 / 60) / LOOK.trailTau));
    for (const dt of [0, 1 / 240, 1 / 60, 1 / 30, LOOK.maxDt]) {
      calls.length = 0;
      renderer.render(instances, 1, dt, 1);
      const uniforms = new Map(callsTo(calls, "uniform1f").map(([location, value]) => [(location as { uniform: string }).uniform, value as number]));
      const scale = uniforms.get("u_depositScale");
      expect(scale).toBeDefined();
      expect(Number.isFinite(scale)).toBe(true);
      const floor = uniforms.get("u_floor")!;
      expect(floor).toBeCloseTo(0.0005 * scale!, 12);
      const decay = uniforms.get("u_decay")!;
      expect(decay).toBeCloseTo(Math.exp(-dt / LOOK.trailTau), 12);
      if (dt === 0) expect(scale).toBe(0);
      else {
        // The entire recurrence, including the floor, has the same positive equilibrium.
        expect((scale! - floor) / (1 - decay)).toBeCloseTo(referenceBrightness, 10);
        expect(scale).toBeGreaterThan(0);
      }
      if (dt === 1 / 60) expect(scale).toBe(1);
    }
  });

  it("accumulates 8-bit trails at 60 Hz while presenting every high-refresh callback", () => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    const instances = new Float32Array(INSTANCE_FLOATS);
    for (let frame = 0; frame < 4; frame++) {
      calls.length = 0;
      renderer.render(instances, 1, 1 / 240, 1);
      expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(frame === 3 ? 1 : 0);
      expect(callsTo(calls, "drawArrays")).toHaveLength(frame === 3 ? 2 : 1);
    }
    expect(callsTo(calls, "uniform1f")).toContainEqual([{ uniform: "u_depositScale" }, 1]);
    expect(callsTo(calls, "uniform1f")).toContainEqual([{ uniform: "u_decay" }, Math.exp(-(1 / 60) / LOOK.trailTau)]);
    expect(callsTo(calls, "uniform1f")).toContainEqual([{ uniform: "u_floor" }, 1.5 / 255]);
  });

  it.each([30, 60, 120, 144, 240])("uses the same number of 8-bit deposits per second at %i Hz", (hz) => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    calls.length = 0;
    const instances = new Float32Array(INSTANCE_FLOATS);
    for (let i = 0; i < hz; i++) renderer.render(instances, 1, 1 / hz, 1);
    expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(60);
    const deposits = callsTo(calls, "uniform1f").filter(([location]) => (location as { uniform: string }).uniform === "u_depositScale");
    expect(deposits).toHaveLength(60);
    expect(deposits.every(([, value]) => value === 1)).toBe(true);
  });

  it("retains fractional fallback time but clears it when render targets are resized", () => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    const instances = new Float32Array(INSTANCE_FLOATS);
    renderer.render(instances, 1, 1 / 120, 1);
    renderer.resize(200, 100);
    calls.length = 0;
    renderer.render(instances, 1, 1 / 120, 2);
    expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(0);
    calls.length = 0;
    renderer.render(instances, 1, 1 / 120, 2);
    expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(1);
  });

  it("does not fade or deposit in the 8-bit target at zero dt", () => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    calls.length = 0;
    renderer.render(new Float32Array(INSTANCE_FLOATS), 1, 0, 1);
    expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(0);
    expect(callsTo(calls, "drawArrays")).toHaveLength(1);
  });

  it.each([0, 1 / 240, 1 / 120])("presents the 8-bit trail from texture unit 0 when dt %f skips accumulation", (dt) => {
    const { gl, calls } = createFakeGl();
    const renderer = new Renderer(gl, 1);
    renderer.resize(100, 100);
    // Another user of the context, such as a GPU simulation pass, may leave a different unit active.
    gl.activeTexture(gl.TEXTURE1);
    calls.length = 0;
    renderer.render(new Float32Array(INSTANCE_FLOATS), 1, dt, 1);
    expect(callsTo(calls, "drawArraysInstanced")).toHaveLength(0);
    const present = calls.findIndex(([name, , texture]) => name === "bindTexture" && texture !== null);
    const select = calls.findLastIndex(([name, unit]) => name === "activeTexture" && unit === gl.TEXTURE0);
    expect(select).toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(present);
  });

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
    expect(uniforms.get("u_floor")).toBeCloseTo(0.0005 * (1 - Math.exp(-0.02 / LOOK.trailTau)) / (1 - Math.exp(-(1 / 60) / LOOK.trailTau)), 12);
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
