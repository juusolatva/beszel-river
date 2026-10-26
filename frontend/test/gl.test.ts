import { describe, expect, it } from "vitest";
import { createProgram, createTarget, deleteTarget } from "../src/render/gl";
import { callsTo, createFakeGl } from "./fake-gl";

describe("createProgram", () => {
  it("compiles and links both shaders, and caches uniform locations", () => {
    const { gl, calls } = createFakeGl();
    const program = createProgram(gl, "vertex source", "fragment source");
    expect(callsTo(calls, "shaderSource").map(([, source]) => source)).toEqual(["vertex source", "fragment source"]);
    expect(callsTo(calls, "createShader").map(([type]) => type)).toEqual(["VERTEX_SHADER", "FRAGMENT_SHADER"]);
    expect(callsTo(calls, "attachShader")).toHaveLength(2);
    expect(callsTo(calls, "linkProgram")).toEqual([[program.program]]);

    const location = program.uniform("u_aspect");
    expect(location).toEqual({ uniform: "u_aspect" });
    expect(program.uniform("u_aspect")).toBe(location);
    expect(callsTo(calls, "getUniformLocation")).toHaveLength(1);
  });

  it("caches a missing uniform as null too", () => {
    // Uniforms the compiler optimized away come back null.
    const { gl, calls } = createFakeGl({ overrides: { getUniformLocation: () => null } });
    const program = createProgram(gl, "v", "f");
    expect(program.uniform("u_unused")).toBeNull();
    expect(program.uniform("u_unused")).toBeNull();
    expect(callsTo(calls, "getUniformLocation")).toHaveLength(1);
  });

  it("reports the compile and link logs", () => {
    expect(() => createProgram(createFakeGl({ compileLog: "ERROR: 0:3: 'x' : undeclared identifier" }).gl, "v", "f")).toThrow(
      "Shader compile failed: ERROR: 0:3: 'x' : undeclared identifier",
    );
    expect(() => createProgram(createFakeGl({ linkLog: "varying mismatch" }).gl, "v", "f")).toThrow("Program link failed: varying mismatch");
  });

  it("fails when the context cannot create a shader", () => {
    const { gl } = createFakeGl({ overrides: { createShader: () => null } });
    expect(() => createProgram(gl, "v", "f")).toThrow("createShader failed");
  });
});

describe("createTarget", () => {
  it("creates a half-float or 8-bit texture with a framebuffer, nearest filtering and clamped edges", () => {
    for (const [half, format, type] of [
      [true, "RGBA16F", "HALF_FLOAT"],
      [false, "RGBA8", "UNSIGNED_BYTE"],
    ] as const) {
      const { gl, calls } = createFakeGl();
      const target = createTarget(gl, 640, 360, half);
      expect(target).not.toBeNull();
      expect(callsTo(calls, "texImage2D")).toEqual([["TEXTURE_2D", 0, format, 640, 360, 0, "RGBA", type, null]]);
      expect(callsTo(calls, "texParameteri").map(([, name, value]) => `${name}=${value}`)).toEqual([
        "TEXTURE_MIN_FILTER=NEAREST",
        "TEXTURE_MAG_FILTER=NEAREST",
        "TEXTURE_WRAP_S=CLAMP_TO_EDGE",
        "TEXTURE_WRAP_T=CLAMP_TO_EDGE",
      ]);
      expect(callsTo(calls, "framebufferTexture2D")).toEqual([["FRAMEBUFFER", "COLOR_ATTACHMENT0", "TEXTURE_2D", target!.texture, 0]]);
      // Leaves the default framebuffer bound.
      expect(callsTo(calls, "bindFramebuffer").at(-1)).toEqual(["FRAMEBUFFER", null]);
    }
  });

  it("deletes what it made and returns null when the framebuffer is incomplete", () => {
    const { gl, calls } = createFakeGl({ complete: { RGBA16F: false } });
    expect(createTarget(gl, 4, 4, true)).toBeNull();
    expect(callsTo(calls, "deleteFramebuffer")).toHaveLength(1);
    expect(callsTo(calls, "deleteTexture")).toHaveLength(1);
  });
});

describe("deleteTarget", () => {
  it("deletes the framebuffer and the texture", () => {
    const { gl, calls } = createFakeGl();
    const target = createTarget(gl, 4, 4, false)!;
    deleteTarget(gl, target);
    expect(callsTo(calls, "deleteFramebuffer")).toEqual([[target.framebuffer]]);
    expect(callsTo(calls, "deleteTexture")).toEqual([[target.texture]]);
  });
});
