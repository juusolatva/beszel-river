import { createProgram } from "../src/render/gl";
import { RECORDED_BIRTH, referenceGaussian, replayRecordedBirth, SHADER_GAUSSIAN, shaderSpawnX } from "./fixtures/gpu-birth";

const VERTEX = `#version 300 es
precision highp float;
in vec2 a_uv;
out vec4 v_parts;
float gaussian(float u, float v) { return ${SHADER_GAUSSIAN}; }
void main() {
  float u = a_uv.x, v = a_uv.y;
  v_parts = vec4(log(u), cos(6.283185307179586 * v), sqrt(-2.0 * log(u)), gaussian(u, v));
  gl_Position = vec4(0.0);
}`;
const FRAGMENT = "#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(0.0); }";
const SWEEP = 1 << 16;

/** Float32 spacing at `value`. */
function ulp(value: number): number {
  return 2 ** (Math.floor(Math.log2(Math.abs(value))) - 23);
}

/**
 * Evaluates simulate.vert's gaussian() and its parts with real shaders for the recorded divergent birth
 * and for sweeps over u and v, and predicts the GPU's spawn x from the readback. Untimed; run it apart
 * from coverage and benchmarks.
 */
export function runGpuSpawnPrecisionCheck() {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) throw new Error("Spawn precision check requires WebGL2");
  const birth = replayRecordedBirth();
  // Row 0: the recorded birth; then a v sweep at its u, then a u sweep over (0, 1] at its v.
  const count = 1 + 2 * SWEEP;
  const inputs = new Float32Array(count * 2);
  inputs[0] = birth.u; inputs[1] = birth.v;
  for (let k = 0; k < SWEEP; k++) {
    inputs[2 + 2 * k] = birth.u; inputs[3 + 2 * k] = k / SWEEP;
    inputs[2 + 2 * (SWEEP + k)] = (k + 1) / SWEEP; inputs[3 + 2 * (SWEEP + k)] = birth.v;
  }
  const program = createProgram(gl, VERTEX, FRAGMENT, ["v_parts"]);
  const input = gl.createBuffer(), output = gl.createBuffer(), vao = gl.createVertexArray(), feedback = gl.createTransformFeedback();
  const parts = new Float32Array(count * 4);
  try {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, input);
    gl.bufferData(gl.ARRAY_BUFFER, inputs, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program.program, "a_uv");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, output);
    gl.bufferData(gl.ARRAY_BUFFER, parts.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.useProgram(program.program);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, output);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, parts);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("Spawn precision WebGL error");
  } finally {
    gl.deleteTransformFeedback(feedback); gl.deleteVertexArray(vao);
    gl.deleteBuffer(input); gl.deleteBuffer(output); gl.deleteProgram(program.program);
  }

  // cos() is compared with the cosine of its Float32 argument, so argument rounding is not counted.
  const cosOf = (v: number) => Math.cos(Math.fround(Math.fround(6.283185307179586) * v));
  let maxCosError = 0, worstCosV = 0, maxLogErrorInside = 0, maxLogUlpBelow = 0, maxGaussianError = 0, worstGaussianAt = [0, 0];
  for (let row = 1; row < count; row++) {
    const u = inputs[2 * row], v = inputs[2 * row + 1], o = 4 * row;
    if (row <= SWEEP) {
      const cosError = Math.abs(parts[o + 1] - cosOf(v));
      if (cosError > maxCosError) { maxCosError = cosError; worstCosV = v; }
    } else {
      const reference = Math.log(u), logError = Math.abs(parts[o] - reference);
      if (u >= 0.5) maxLogErrorInside = Math.max(maxLogErrorInside, logError);
      else maxLogUlpBelow = Math.max(maxLogUlpBelow, logError / ulp(reference));
    }
    // u = 1 gives log 0 and a zero gaussian; the sweeps never pass u = 0.
    const gaussianError = Math.abs(parts[o + 3] - referenceGaussian(u, v));
    if (gaussianError > maxGaussianError) { maxGaussianError = gaussianError; worstGaussianAt = [u, v]; }
  }
  const exact = { log: Math.log(birth.u), cos: cosOf(birth.v), root: Math.sqrt(-2 * Math.log(birth.u)), gaussian: referenceGaussian(birth.u, birth.v) };
  const gpu = { log: parts[0], cos: parts[1], root: parts[2], gaussian: parts[3] };
  const predictedX = shaderSpawnX(birth, gpu.gaussian);
  // Firefox masks RENDERER (for example "Intel(R) HD Graphics 400, or similar"); the unmasked name may be null.
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const metadata = { userAgent: navigator.userAgent, renderer: gl.getParameter(gl.RENDERER) as string,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : null, sweep: SWEEP };
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    metadata,
    birth: { u: birth.u, v: birth.v, exact, gpu,
      errors: { log: gpu.log - exact.log, cos: gpu.cos - exact.cos, root: gpu.root - exact.root, gaussian: gpu.gaussian - exact.gaussian },
      predictedX, recordedGpuX: RECORDED_BIRTH.gpuX, recordedCpuX: RECORDED_BIRTH.cpuX,
      // Explained if this gaussian reproduces the recorded x far closer than the 2.1e-5 CPU/GPU gap.
      explainsRecordedX: Math.abs(predictedX - RECORDED_BIRTH.gpuX) < 1e-6 },
    sweeps: { maxCosError, worstCosV, maxLogErrorInside, logBoundInside: 2 ** -21, maxLogUlpBelow, maxGaussianError, worstGaussianAt },
  };
}
