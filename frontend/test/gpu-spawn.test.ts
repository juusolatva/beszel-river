import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import investigation from "../../docs/experiments/2026-11-13-gpu-occupancy.json";
import simulateSource from "../src/render/shaders/simulate.vert?raw";
import { RECORDED_BIRTH, referenceGaussian, replayRecordedBirth, SHADER_GAUSSIAN, shaderSpawnX } from "./fixtures/gpu-birth";

describe("recorded GPU spawn divergence", () => {
  const birth = replayRecordedBirth();

  it("replays the matched CPU control to the recorded birth exactly", () => {
    const recorded = investigation.results.find((r) => r.scenario === "occupancy")!.firstIdentityDifference!;
    expect(recorded.time).toBe(RECORDED_BIRTH.time);
    expect(recorded.index).toBe(RECORDED_BIRTH.index);
    expect(recorded.afterGpu[0]).toBe(RECORDED_BIRTH.gpuX);
    expect({ x: birth.x, y: birth.y, life: birth.life, speedJitter: birth.speedJitter })
      .toEqual({ x: RECORDED_BIRTH.cpuX, y: recorded.beforeCpu.y, life: recorded.beforeCpu.life, speedJitter: recorded.beforeCpu.speedJitter });
    // The GPU's y and lifetime come from later draws of the same key, so its random inputs were the same.
    expect([recorded.afterGpu[1], recorded.afterGpu[5]]).toEqual([birth.y, birth.life]);
  });

  it("evaluates the same gaussian expression as the simulation shader", () => {
    expect(simulateSource).toContain(`return ${SHADER_GAUSSIAN};`);
  });

  it("reproduces the CPU x with the shader's Float32 arithmetic and the exact gaussian", () => {
    expect(Math.abs(shaderSpawnX(birth, referenceGaussian(birth.u, birth.v)) - RECORDED_BIRTH.cpuX)).toBeLessThan(1e-7);
  });

  it("needs a gaussian about 3.8e-5 lower than the exact one to give the GPU's x", () => {
    const exact = referenceGaussian(birth.u, birth.v);
    const implied = exact + (RECORDED_BIRTH.gpuX - shaderSpawnX(birth, exact)) / (birth.half * LOOK.spawnSpread);
    expect(Math.abs(shaderSpawnX(birth, implied) - RECORDED_BIRTH.gpuX)).toBeLessThan(1e-7);
    const error = implied - exact;
    expect(error).toBeCloseTo(-3.84e-5, 6);
    // gaussian = root * cosine with root = sqrt(-2 log u). Alone, each factor's error would have to be:
    const root = Math.sqrt(-2 * Math.log(birth.u)), cosine = Math.cos(2 * Math.PI * birth.v);
    const cosError = error / root;
    const logError = -root * (error / cosine);
    // GLSL ES 3.00 bounds log() on [0.5, 2.0] to an absolute error below 2^-21, about 100x too small;
    // sqrt() is held to a few ULP, and cos() has undefined precision.
    expect(birth.u).toBeGreaterThan(0.5);
    expect(Math.abs(logError)).toBeGreaterThan(50 * 2 ** -21);
    expect(cosError).toBeCloseTo(-3.53e-5, 6);
  });
});
