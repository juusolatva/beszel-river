import { LOOK } from "../src/config";
import { createProgram } from "../src/render/gl";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { compareMotion, preloadCpuState, preloadGpuState } from "./fixtures/gpu-state";
import { replayFrames } from "./fixtures/gpu-replay";

/** Execute real feedback shaders; run separately from coverage and timed benchmarks. */
export function runGpuMotionBrowserChecks(): { cases: number; maxOneStepError: number; maxLongError: number } {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("GPU motion checks require WebGL2");
  const assert = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
  // Both compile and link errors must be observable with a real driver.
  for (const [vertex, fragment, varyings, expected] of [
    ["invalid shader", "invalid shader", undefined, "Shader compile failed"],
    ["#version 300 es\nvoid main(){gl_Position=vec4(0.0);}", "#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(0.0);}", ["missing"], "Program link failed"],
  ] as const) {
    let error = "";
    try { createProgram(gl, vertex, fragment, varyings); } catch (e) { error = String(e); }
    assert(error.includes(expected), `Missing real ${expected}`);
  }
  let cases = 0, maxOneStepError = 0, maxLongError = 0;
  for (const requestedDt of [0, 1 / 240, 1 / 60, 1 / 30, LOOK.maxDt, 0.07793116454949989]) for (const steps of [1, 120]) {
    for (const filament of [false, true]) {
      // Same canonical input as ReplayTrace, including the variable-dt lifetime regression.
      const dt = Math.fround(requestedDt);
      const streams = new StreamSet(1);
      streams.apply(replayFrames[2]);
      streams.update(0.1, 1.5);
      streams.slots[0].filamentMix = filament ? 1 : 0;
      streams.slots[1].half = 0;
      streams.slots[1].rebuildCenters();
      const field = new FlowField(mulberry32(42));
      field.update(0.3, 1.5);
      const count = 16;
      const state = new ArrayBuffer(count * 64);
      const f = new Float32Array(state), u = new Uint32Array(state);
      const xs = [-0.1, 0, 0.2, 1.59, -0.101, 1.601, 0.7, 0.8];
      const ys = [-0.03, -0.02, 0, 1, 1.08, 1.081, 0.4, 0.6];
      for (let i = 0; i < count; i++) {
        f.set([i === 8 || i === 13 || i === 14 ? 0.7 : xs[i % 8], i === 13 ? 0.4 : ys[i % 8], 0.01, 0.12,
          i === 6 ? 1 : i === 14 ? 0.5 : i === 13 ? 7.710000038146973 : 0,
          i === 6 ? 1 : i === 14 ? 0.5 + dt : i === 13 ? 7.787930965423584 : 14, 0.02, 1.2,
          0.9, filament ? 0.4 : 0, 0, 0], i * 16);
        u.set([i % 2, 0xf0000001, i === 15 ? 0 : 1, 53], i * 16 + 12);
      }
      const cpu = preloadCpuState(state, streams);
      const gpu = new GpuParticles(gl, count, 42);
      preloadGpuState(gl, gpu, state);
      const readback = new ArrayBuffer(state.byteLength);
      try {
        for (let j = 0; j < steps; j++) {
          const aspect = j >= 60 ? 1.2 : 1.5;
          field.update(0.3 + j * dt, aspect);
          gpu.step(dt, streams, field, aspect);
          if (dt > 0) cpu.step(dt, streams, field, aspect, 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer);
          gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(readback));
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          assert(gl.getError() === gl.NO_ERROR, `GPU motion WebGL error ${dt}/${steps}/${j}`);
          const error = compareMotion(readback, cpu, steps === 1 ? 1e-5 : 1e-3);
          if (steps === 1) maxOneStepError = Math.max(maxOneStepError, error);
          else maxLongError = Math.max(maxLongError, error);
          const identities = new Uint32Array(readback);
          for (let i = 0; i < count; i++) {
            assert(identities[i * 16 + 13] === 0xf0000001 && identities[i * 16 + 15] === 53, "Generation/counter changed");
          }
          assert(gl.getError() === gl.NO_ERROR, "GPU motion WebGL error");
        }
        cases++;
      } finally { gpu.dispose(); }
    }
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { cases, maxOneStepError, maxLongError };
}
