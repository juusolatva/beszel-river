import { LOOK } from "../config";
import { createProgram, type Program } from "../render/gl";
import vertexSource from "../render/shaders/simulate.vert?raw";
import fragmentSource from "../render/shaders/simulate.frag?raw";
import { fract } from "../util/math";
import { GPU_FEEDBACK_VARYINGS, GPU_IDENTITY_OFFSET_BYTES, GPU_LIFETIME_OFFSET_BYTES,
  GPU_MOTION_OFFSET_BYTES, GPU_SPAWN_OFFSET_BYTES, GPU_STATE_STRIDE_BYTES } from "./gpu-layout";
import type { FlowField } from "./noise";
import { MAX_STREAMS, type StreamSet } from "./streams";

/** Motion-only transform-feedback experiment; production continues to use ParticleSystem. */
export class GpuParticles {
  readonly stateStrideBytes = GPU_STATE_STRIDE_BYTES;
  limit: number;
  spawningEnabled = false;
  private hue = 0;
  private current = 0;
  private readonly buffers: WebGLBuffer[] = [];
  private readonly vaos: WebGLVertexArrayObject[] = [];
  private readonly textures: WebGLTexture[] = [];
  private feedback: WebGLTransformFeedback | null = null;
  private program: Program | null = null;
  private uniforms!: Record<"flow" | "stream" | "dt" | "bounds" | "cell" | "physics" | "braid", WebGLUniformLocation | null>;
  private readonly streamData = new Float32Array(24 * MAX_STREAMS * 4);
  private flowData = new Float32Array(0);
  private cols = 0;
  private rows = 0;
  private readonly maxTextureSize: number;

  constructor(private readonly gl: WebGL2RenderingContext, readonly capacity: number, seed: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid GPU capacity");
    // Reserved for deterministic spawning in the next increment.
    void seed;
    this.limit = capacity;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 4 || gl.getParameter(gl.MAX_VERTEX_ATTRIBS) < 5 ||
      gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS) < 16 || this.maxTextureSize < 32) {
      throw new Error("GPU motion unsupported: insufficient WebGL2 limits");
    }
    try {
      this.program = createProgram(gl, vertexSource, fragmentSource, GPU_FEEDBACK_VARYINGS);
      this.uniforms = {
        flow: this.program.uniform("u_flow"), stream: this.program.uniform("u_stream"),
        dt: this.program.uniform("u_dt"), bounds: this.program.uniform("u_bounds"),
        cell: this.program.uniform("u_cell"), physics: this.program.uniform("u_physics"), braid: this.program.uniform("u_braid"),
      };
      this.feedback = gl.createTransformFeedback();
      if (!this.feedback) throw new Error("GPU resource allocation failed");
      for (let i = 0; i < 2; i++) {
        const buffer = this.own(this.buffers, gl.createBuffer());
        const vao = this.own(this.vaos, gl.createVertexArray());
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * GPU_STATE_STRIDE_BYTES, gl.DYNAMIC_COPY);
        for (let j = 0; j < 3; j++) {
          gl.enableVertexAttribArray(j);
          const offset = j === 0 ? GPU_MOTION_OFFSET_BYTES : j === 1 ? GPU_LIFETIME_OFFSET_BYTES : GPU_SPAWN_OFFSET_BYTES;
          gl.vertexAttribPointer(j, 4, gl.FLOAT, false, GPU_STATE_STRIDE_BYTES, offset);
        }
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, GPU_STATE_STRIDE_BYTES, GPU_IDENTITY_OFFSET_BYTES);
      }
      for (let i = 0; i < 3; i++) {
        const texture = this.own(this.textures, gl.createTexture());
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (i === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 24, MAX_STREAMS, 0, gl.RGBA, gl.FLOAT, null);
        if (i === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 1, MAX_STREAMS, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
      }
    } catch (error) {
      this.dispose();
      throw error;
    } finally { this.clearBindings(); }
  }

  get stateBuffer(): WebGLBuffer { return this.buffers[this.current]; }
  get streamTexture(): WebGLTexture { return this.textures[1]; }
  get commandTexture(): WebGLTexture { return this.textures[2]; }
  get globalHue(): number { return this.hue; }

  /** Advance using a Float32-effective step shared by prototype replay, easing and CPU reference. */
  step(dt: number, streams: StreamSet, field: FlowField, aspect: number): void {
    dt = Math.fround(dt);
    if (dt <= 0) return;
    const gl = this.gl;
    let begun = false;
    try {
      this.uploadInputs(streams, field);
      const u = this.uniforms;
      gl.useProgram(this.program!.program);
      gl.uniform1i(u.flow, 0);
      gl.uniform1i(u.stream, 1);
      gl.uniform1f(u.dt, dt);
      // Float32(-0.1) is below the CPU double bound; Float32(1.08) is above it.
      // Equality at those rounded values is therefore a death on the CPU too.
      const upper = Math.fround(aspect + 0.1);
      gl.uniform4f(u.bounds, Math.fround(-0.1), Math.fround(1.08), upper, upper > aspect + 0.1 ? 1 : 0);
      gl.uniform1f(u.cell, field.gridCell);
      gl.uniform3f(u.physics, LOOK.steer, LOOK.maxSlope, 1 - Math.exp(-dt / LOOK.inertia));
      gl.uniform2f(u.braid, LOOK.braid, LOOK.braidWaves);
      gl.bindVertexArray(this.vaos[this.current]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[1 - this.current]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      begun = true;
      gl.drawArrays(gl.POINTS, 0, this.capacity);
      begun = false;
      gl.endTransformFeedback();
      this.current = 1 - this.current;
      this.hue = fract(this.hue + LOOK.hueRotate * dt);
    } finally {
      try { if (begun) gl.endTransformFeedback(); } finally { this.clearBindings(); }
    }
  }

  /** Release all resources, including partially constructed experiments. */
  dispose(): void {
    const gl = this.gl;
    for (const vao of this.vaos) gl.deleteVertexArray(vao);
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const texture of this.textures) gl.deleteTexture(texture);
    if (this.feedback) gl.deleteTransformFeedback(this.feedback);
    if (this.program) gl.deleteProgram(this.program.program);
    this.vaos.length = this.buffers.length = this.textures.length = 0;
    this.feedback = null;
    this.program = null;
  }

  private own<T>(resources: T[], value: T | null): T {
    if (!value) throw new Error("GPU resource allocation failed");
    resources.push(value);
    return value;
  }

  private uploadInputs(streams: StreamSet, field: FlowField): void {
    const gl = this.gl;
    const cols = field.gridCols, rows = field.gridRows;
    if (cols < 2 || cols > this.maxTextureSize || rows > this.maxTextureSize) throw new Error("Invalid GPU flow grid");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    if (cols !== this.cols || rows !== this.rows) {
      this.flowData = new Float32Array(cols * rows * 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cols, rows, 0, gl.RG, gl.FLOAT, null);
      this.cols = cols;
      this.rows = rows;
    }
    field.writeVelocityGrid(this.flowData);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.FLOAT, this.flowData);
    const data = this.streamData;
    for (let i = 0; i < MAX_STREAMS; i++) {
      const s = streams.slots[i], o = i * 96;
      data[o] = s.center; data[o + 1] = s.half; data[o + 2] = s.speed; data[o + 3] = s.turbulenceAmp;
      data[o + 4] = s.phase; data[o + 5] = s.braidAngle; data[o + 6] = s.hueOffset; data[o + 7] = s.filamentMix;
      data[o + 8] = s.brightness; data[o + 9] = s.chroma; data[o + 10] = s.streakSeconds; data[o + 11] = s.presence;
      for (let j = 0; j < 6; j++) { data[o + 12 + j] = s.filaments[j]; data[o + 18 + j] = s.laneWeights[j]; }
      data[o + 24] = s.spawnWeight; data[o + 25] = s.shareWeight;
      s.writeCenters(data, o + 32);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.streamTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 24, MAX_STREAMS, gl.RGBA, gl.FLOAT, data);
  }

  private clearBindings(): void {
    const gl = this.gl;
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
