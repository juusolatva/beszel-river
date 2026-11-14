import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { GpuParticleDrawer } from "../src/render/gpu-particle-drawer";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { callsTo, createFakeGl, type Call } from "./fake-gl";

function inputs() {
  const streams = new StreamSet(1);
  streams.apply({ streams: [{ id: "one", width: 0.6, flow: 0.5, density: 0.5, turbulence: 0.5,
    pulse: 0, heat: 0.5, alive: true }], v: 1, t: 0 });
  streams.update(0.1, 1);
  const field = new FlowField(() => 0.5);
  field.update(0, 1);
  return { streams, field };
}

function uniforms(calls: Call[], method: string): Map<string, unknown[]> {
  return new Map(callsTo(calls, method).map(([location, ...values]) => [(location as { uniform: string }).uniform, values]));
}

function setup(options: Parameters<typeof createFakeGl>[0] = {}) {
  const { gl, calls } = createFakeGl(options);
  const particles = new GpuParticles(gl, 12, 42);
  calls.length = 0;
  return { gl, calls, particles, drawer: new GpuParticleDrawer(gl, particles) };
}

describe("GpuParticleDrawer", () => {
  it("creates nothing until its first draw", () => {
    const { calls, drawer } = setup();
    expect(calls).toEqual([]);
    expect(drawer.drawCapacity).toBe(12);
  });

  it("draws full capacity straight from the latest state buffer with integer identities", () => {
    const { calls, particles, drawer } = setup();
    drawer.draw(1.5, 1.25, 0.3, 0.5, 0.75, 1 / 600);
    expect(callsTo(calls, "linkProgram")).toHaveLength(1);
    expect(callsTo(calls, "drawArraysInstanced")).toEqual([["TRIANGLE_STRIP", 0, 4, 12]]);
    expect(callsTo(calls, "bufferSubData")).toEqual([]);
    expect(callsTo(calls, "vertexAttribPointer")).toEqual([
      [0, 2, "FLOAT", false, 0, 0],
      [1, 4, "FLOAT", false, 64, 0],
      [2, 4, "FLOAT", false, 64, 16],
      [3, 4, "FLOAT", false, 64, 32],
    ]);
    expect(callsTo(calls, "vertexAttribIPointer")).toEqual([[4, 4, "UNSIGNED_INT", 64, 48]]);
    expect(callsTo(calls, "vertexAttribDivisor")).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]]);
    // The particle attributes read the simulation's current buffer, not the corner quad.
    const binds = callsTo(calls, "bindBuffer").filter(([target, buffer]) => target === "ARRAY_BUFFER" && buffer !== null);
    expect(binds.at(-1)).toEqual(["ARRAY_BUFFER", particles.stateBuffer]);
  });

  it("applies the intensity scale, deposit scale, DPR and hue once as uniforms", () => {
    const { calls, drawer } = setup();
    drawer.draw(1.5, 1.25, 0.3, 0.5, 0.75, 1 / 600);
    const floats = uniforms(calls, "uniform1f");
    expect(floats.get("u_intensity")).toEqual([LOOK.intensity * 0.5]);
    expect(floats.get("u_depositScale")).toEqual([0.75]);
    expect(floats.get("u_sizeScale")).toEqual([LOOK.sizePx * 1.25]);
    expect(floats.get("u_hue")).toEqual([0.3]);
    expect(floats.get("u_aspect")).toEqual([1.5]);
    expect(floats.get("u_pixel")).toEqual([1 / 600]);
    expect(uniforms(calls, "uniform4f").get("u_look")).toEqual([LOOK.lightness, LOOK.hueGradient, LOOK.fadeIn, LOOK.fadeOut]);
    expect(uniforms(calls, "uniform1i")).toEqual(new Map([["u_stream", [1]], ["u_command", [2]]]));
    for (const name of ["u_intensity", "u_depositScale"]) {
      expect(callsTo(calls, "uniform1f").filter(([location]) => (location as { uniform: string }).uniform === name)).toHaveLength(1);
    }
  });

  it("binds stream and command data to units 1 and 2 and restores the shared GL state", () => {
    const { gl, calls, particles, drawer } = setup();
    gl.activeTexture(gl.TEXTURE1);
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    const draw = calls.findIndex(([name]) => name === "drawArraysInstanced");
    const before = calls.slice(0, draw);
    const unit = (texture: unknown) => {
      const bind = before.findLastIndex(([name, , value]) => name === "bindTexture" && value === texture);
      return before.slice(0, bind).findLast(([name]) => name === "activeTexture")?.[1];
    };
    expect(unit(particles.streamTexture)).toBe("TEXTURE1");
    expect(unit(particles.commandTexture)).toBe("TEXTURE2");
    expect(callsTo(calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
    const after = calls.slice(draw);
    expect(after).toContainEqual(["bindVertexArray", null]);
    expect(after).toContainEqual(["bindBuffer", "ARRAY_BUFFER", null]);
    expect(callsTo(after, "bindTexture").filter(([, texture]) => texture !== null)).toEqual([]);
    expect(callsTo(after, "bindTexture")).toHaveLength(2);
    expect(callsTo(calls, "enable")).toEqual([]);
    expect(callsTo(calls, "disable")).toEqual([]);
  });

  it("follows buffer swaps with one cached vertex array per state buffer", () => {
    const { calls, particles, drawer } = setup();
    const { streams, field } = inputs();
    const first = particles.stateBuffer;
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    particles.step(1 / 60, streams, field, 1);
    expect(particles.stateBuffer).not.toBe(first);
    calls.length = 0;
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    expect(callsTo(calls, "createVertexArray")).toHaveLength(1);
    expect(callsTo(calls, "vertexAttribIPointer")).toHaveLength(1);
    const latest = callsTo(calls, "bindBuffer").filter(([target, buffer]) => target === "ARRAY_BUFFER" && buffer !== null).at(-1);
    expect(latest).toEqual(["ARRAY_BUFFER", particles.stateBuffer]);
    const secondVao = callsTo(calls, "bindVertexArray").find(([vao]) => vao !== null)?.[0];

    particles.step(1 / 60, streams, field, 1);
    calls.length = 0;
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    expect(callsTo(calls, "createVertexArray")).toEqual([]);
    expect(callsTo(calls, "linkProgram")).toEqual([]);
    expect(callsTo(calls, "getUniformLocation")).toEqual([]);
    expect(callsTo(calls, "bufferData")).toEqual([]);
    const thirdVao = callsTo(calls, "bindVertexArray").find(([vao]) => vao !== null)?.[0];
    expect(thirdVao).not.toBe(secondVao);
    expect(callsTo(calls, "drawArraysInstanced")).toEqual(Array(2).fill(["TRIANGLE_STRIP", 0, 4, 12]));
  });

  it("never draws from a buffer that is still bound as a feedback output", () => {
    const { gl, particles, drawer } = setup();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, particles.stateBuffer);
    expect(() => drawer.draw(1, 1, 0, 1, 1, 0.01)).toThrow("also feedback output");
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    const { streams, field } = inputs();
    particles.step(1 / 60, streams, field, 1);
    expect(() => drawer.draw(1, 1, 0, 1, 1, 0.01)).not.toThrow();
  });

  it("rejects a state buffer it did not see from its particle system", () => {
    const { gl, particles, drawer } = setup();
    const { streams, field } = inputs();
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    particles.step(1 / 60, streams, field, 1);
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    Object.defineProperty(particles, "stateBuffer", { value: gl.createBuffer() });
    expect(() => drawer.draw(1, 1, 0, 1, 1, 0.01)).toThrow("state buffer changed");
  });

  it("cleans up after a failed draw and releases a partial setup", () => {
    const failing = setup({ overrides: { drawArraysInstanced: () => { throw new Error("draw failed"); } } });
    failing.gl.activeTexture(failing.gl.TEXTURE2);
    expect(() => failing.drawer.draw(1, 1, 0, 1, 1, 0.01)).toThrow("draw failed");
    expect(callsTo(failing.calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
    expect(callsTo(failing.calls, "bindVertexArray").at(-1)).toEqual([null]);

    // Fail only the drawer's lazy setup; the simulation was built before the switch flips.
    let fail = "";
    const lazy = setup({ overrides: {
      getProgramParameter: () => fail !== "link",
      getProgramInfoLog: () => "bad link",
      createBuffer: () => (fail === "createBuffer" ? null : { kind: "Buffer" }),
      createVertexArray: () => (fail === "createVertexArray" ? null : { kind: "VertexArray" }),
    } });
    for (const name of ["link", "createBuffer", "createVertexArray"]) {
      fail = name;
      lazy.calls.length = 0;
      lazy.gl.activeTexture(lazy.gl.TEXTURE1);
      expect(() => lazy.drawer.draw(1, 1, 0, 1, 1, 0.01)).toThrow(name === "link" ? "Program link failed" : "GPU draw resource");
      expect(callsTo(lazy.calls, "deleteProgram")).toHaveLength(1);
      expect(callsTo(lazy.calls, "deleteBuffer")).toHaveLength(name === "createVertexArray" ? 1 : 0);
      expect(callsTo(lazy.calls, "drawArraysInstanced")).toEqual([]);
      expect(callsTo(lazy.calls, "activeTexture").at(-1)).toEqual(["TEXTURE0"]);
    }
    // A later draw retries the whole setup.
    fail = "";
    lazy.calls.length = 0;
    lazy.drawer.draw(1, 1, 0, 1, 1, 0.01);
    expect(callsTo(lazy.calls, "linkProgram")).toHaveLength(1);
    expect(callsTo(lazy.calls, "drawArraysInstanced")).toHaveLength(1);
  });

  it("disposes its own program, vertex arrays and quad but not the simulation buffers", () => {
    const { calls, particles, drawer } = setup();
    const { streams, field } = inputs();
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    particles.step(1 / 60, streams, field, 1);
    drawer.draw(1, 1, 0, 1, 1, 0.01);
    calls.length = 0;
    drawer.dispose();
    drawer.dispose();
    expect(callsTo(calls, "deleteProgram")).toHaveLength(1);
    expect(callsTo(calls, "deleteVertexArray")).toHaveLength(2);
    expect(callsTo(calls, "deleteBuffer")).toHaveLength(1);
    expect(callsTo(calls, "deleteBuffer")).not.toContainEqual([particles.stateBuffer]);
  });

  it("shares colour conversion and fragment shading with the CPU particle shader", () => {
    const read = (name: string) => readFileSync(new URL(`../src/render/shaders/${name}`, import.meta.url), "utf8");
    const oklch = (source: string) => source.slice(source.indexOf("vec3 oklchToLinearSrgb"), source.indexOf("void main"));
    expect(oklch(read("particle-gpu.vert"))).toBe(oklch(read("particle.vert")));
    const drawer = readFileSync(new URL("../src/render/gpu-particle-drawer.ts", import.meta.url), "utf8");
    expect(drawer).toContain('from "./shaders/particle.frag?raw"');
  });
});
