import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { Renderer, type GpuDrawSource } from "../src/render/renderer";
import { INSTANCE_FLOATS } from "../src/sim/particles";
import { callsTo, createFakeGl, type Call } from "./fake-gl";

/** Texture each frame's present pass reads, and the framebuffer its fade pass writes. */
function passes(calls: Call[]): { read: unknown; wrote: unknown } {
  const binds = callsTo(calls, "bindFramebuffer").filter(([, framebuffer]) => framebuffer !== null);
  const textures = callsTo(calls, "bindTexture").filter(([, texture]) => texture !== null);
  return { wrote: binds.at(-1)?.[1], read: textures.at(-1)?.[1] };
}

/** Records every deposit pass; may leave another texture unit active, as a GPU pass could. */
function recordingSource(gl?: WebGL2RenderingContext): GpuDrawSource & { draws: number[][] } {
  const draws: number[][] = [];
  return {
    draws,
    draw(...args) {
      draws.push(args);
      gl?.activeTexture(gl.TEXTURE1);
    },
  };
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
    expect(renderer.halfFloat).toBe(true);

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
    expect(renderer.halfFloat).toBe(false);

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

  describe("GPU draw source", () => {
    it("draws nothing before the first resize", () => {
      const { gl, calls } = createFakeGl();
      const source = recordingSource();
      new Renderer(gl, 10).renderGpu(source, 1 / 60, 1, 1, 0, 1);
      expect(source.draws).toEqual([]);
      expect(callsTo(calls, "drawArrays")).toEqual([]);
    });

    it("passes the frame's parameters to one half-float deposit per callback, between blend state changes", () => {
      const { gl, calls } = createFakeGl({ halfFloat: true });
      const renderer = new Renderer(gl, 10);
      renderer.resize(800, 600);
      const source = recordingSource(gl);
      calls.length = 0;
      renderer.renderGpu(source, 0.02, 4 / 3, 1.5, 0.25, 0.6);
      const depositScale = -Math.expm1(-0.02 / LOOK.trailTau) / -Math.expm1(-(1 / 60) / LOOK.trailTau);
      expect(source.draws).toHaveLength(1);
      expect(source.draws[0].slice(0, 4)).toEqual([4 / 3, 1.5, 0.25, 0.6]);
      expect(source.draws[0][4]).toBeCloseTo(depositScale, 12);
      expect(source.draws[0][5]).toBe(1 / 600);
      expect(callsTo(calls, "blendFunc")).toEqual([["ONE", "ONE"]]);
      expect(callsTo(calls, "enable")).toEqual([["BLEND"]]);
      expect(callsTo(calls, "disable").at(-1)).toEqual(["BLEND"]);
      // The source draws itself; no instance upload, fade and present still run.
      expect(callsTo(calls, "bufferSubData")).toEqual([]);
      expect(callsTo(calls, "drawArraysInstanced")).toEqual([]);
      expect(callsTo(calls, "drawArrays")).toHaveLength(2);
      expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    });

    it("draws even when the pool may be empty, since the live count stays on the GPU", () => {
      const { gl } = createFakeGl({ halfFloat: true });
      const renderer = new Renderer(gl, 10);
      renderer.resize(100, 100);
      const source = recordingSource();
      renderer.renderGpu(source, LOOK.maxDt, 1, 1, 0, 1);
      expect(source.draws).toHaveLength(1);
    });

    it("adds no energy at zero dt in either format", () => {
      for (const halfFloat of [true, false]) {
        const { gl } = createFakeGl({ halfFloat });
        const renderer = new Renderer(gl, 10);
        renderer.resize(100, 100);
        const source = recordingSource();
        renderer.renderGpu(source, 0, 1, 1, 0, 1);
        expect(source.draws.map((args) => args[4])).toEqual(halfFloat ? [0] : []);
      }
    });

    it.each([30, 60, 120, 240])("repeats the same 8-bit deposit from one simulated state at %i Hz", (hz) => {
      const { gl, calls } = createFakeGl();
      const renderer = new Renderer(gl, 10);
      renderer.resize(100, 100);
      calls.length = 0;
      const source = recordingSource();
      const perCallback: number[] = [];
      for (let i = 0; i < hz; i++) {
        const before = source.draws.length;
        // Hue and intensity identify the callback's simulated state.
        renderer.renderGpu(source, 1 / hz, 1, 1, i / hz, 0.5);
        perCallback.push(source.draws.length - before);
        for (const args of source.draws.slice(before)) expect(args).toEqual([1, 1, i / hz, 0.5, 1, 1 / 100]);
      }
      expect(source.draws).toHaveLength(60);
      expect(Math.max(...perCallback)).toBe(Math.max(1, Math.round(60 / hz)));
      expect(callsTo(calls, "drawArrays")).toHaveLength(hz + 60);
    });

    it.each([0, 1 / 240, 1 / 120])("presents from texture unit 0 after a source leaves unit 1 active (dt %f)", (dt) => {
      for (const halfFloat of [true, false]) {
        const { gl, calls } = createFakeGl({ halfFloat });
        const renderer = new Renderer(gl, 1);
        renderer.resize(100, 100);
        // Also start from unit 1, as the GPU simulation step could leave it.
        renderer.renderGpu(recordingSource(gl), 1 / 60, 1, 1, 0, 1);
        gl.activeTexture(gl.TEXTURE1);
        calls.length = 0;
        renderer.renderGpu(recordingSource(gl), dt, 1, 1, 0, 1);
        const present = calls.findLastIndex(([name, , texture]) => name === "bindTexture" && texture !== null);
        const select = calls.findLastIndex(([name]) => name === "activeTexture");
        expect(calls[select]).toEqual(["activeTexture", "TEXTURE0"]);
        expect(select).toBeLessThan(present);
        expect(calls.findLastIndex(([name]) => name === "useProgram")).toBeLessThan(present);
      }
    });

    it("restores blending and the default framebuffer when a source fails, and renders again afterwards", () => {
      for (const halfFloat of [true, false]) {
        const { gl, calls } = createFakeGl({ halfFloat });
        const renderer = new Renderer(gl, 10);
        renderer.resize(100, 100);
        calls.length = 0;
        const failing: GpuDrawSource = { draw: () => { throw new Error("draw failed"); } };
        expect(() => renderer.renderGpu(failing, 1 / 60, 1, 1, 0, 1)).toThrow("draw failed");
        expect(callsTo(calls, "disable").at(-1)).toEqual(["BLEND"]);
        expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
        expect(callsTo(calls, "drawArrays")).toHaveLength(1); // the fade, but no present
        calls.length = 0;
        const source = recordingSource();
        renderer.renderGpu(source, 1 / 60, 1, 1, 0, 1);
        expect(source.draws).toHaveLength(1);
        expect(callsTo(calls, "drawArrays")).toHaveLength(2);
      }
    });

    it("leaves the CPU path unchanged after GPU frames", () => {
      const { gl, calls } = createFakeGl({ halfFloat: true });
      const renderer = new Renderer(gl, 10);
      renderer.resize(100, 100);
      renderer.renderGpu(recordingSource(), 1 / 60, 1, 1, 0, 1);
      calls.length = 0;
      const instances = new Float32Array(10 * INSTANCE_FLOATS);
      renderer.render(instances, 3, 1 / 60, 1);
      expect(callsTo(calls, "bufferSubData")).toEqual([["ARRAY_BUFFER", 0, instances, 0, 3 * INSTANCE_FLOATS]]);
      expect(callsTo(calls, "drawArraysInstanced")).toEqual([["TRIANGLE_STRIP", 0, 4, 3]]);
    });
  });
});
