import { LOOK } from "../config";
import type { GpuParticles } from "../sim/gpu-particles";
import { GPU_IDENTITY_OFFSET_BYTES, GPU_LIFETIME_OFFSET_BYTES, GPU_MOTION_OFFSET_BYTES, GPU_SPAWN_OFFSET_BYTES,
  GPU_STATE_STRIDE_BYTES } from "../sim/gpu-layout";
import { createProgram, type Program } from "./gl";
import type { GpuDrawSource } from "./renderer";
import particleFrag from "./shaders/particle.frag?raw";
import particleGpuVert from "./shaders/particle-gpu.vert?raw";

type Uniform = "aspect" | "pixel" | "depositScale" | "hue" | "intensity" | "sizeScale";

/**
 * Draws the experimental GPU simulation's latest state buffer directly, without uploading instances.
 * Every slot is drawn; inactive ones collapse outside the clip volume. Its program, quad and vertex
 * arrays are created on the first draw, so harnesses do that during warmup.
 */
export class GpuParticleDrawer implements GpuDrawSource {
  private program: Program | null = null;
  private quad: WebGLBuffer | null = null;
  private uniforms: Record<Uniform, WebGLUniformLocation | null> | null = null;
  // One vertex array per simulation state buffer; the simulation alternates between exactly two.
  private readonly stateBuffers: (WebGLBuffer | null)[] = [null, null];
  private readonly vaos: (WebGLVertexArrayObject | null)[] = [null, null];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly particles: GpuParticles,
  ) {}

  /** Instances submitted per deposit pass: the full capacity, not the live count. */
  get drawCapacity(): number {
    return this.particles.capacity;
  }

  /**
   * Compile the program and set up both state buffers' vertex arrays now, without drawing, so a
   * harness can fail fast and keep all setup out of timing. Optional: draws do the same lazily.
   */
  prepare(): void {
    const { gl } = this;
    try {
      for (const buffer of this.particles.stateBuffers) this.vertexArrayFor(buffer);
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  draw(aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number, depositScale: number, pixel: number): void {
    const { gl, particles } = this;
    try {
      const vao = this.vertexArrayFor(particles.stateBuffer);
      const u = this.uniforms!;
      gl.useProgram(this.program!.program);
      gl.uniform1f(u.aspect, aspect);
      gl.uniform1f(u.pixel, pixel);
      gl.uniform1f(u.depositScale, depositScale);
      gl.uniform1f(u.hue, globalHue);
      gl.uniform1f(u.intensity, LOOK.intensity * intensityScale);
      gl.uniform1f(u.sizeScale, LOOK.sizePx * devicePixelRatio);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, particles.streamTexture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, particles.commandTexture);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, particles.capacity);
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  /** Release the drawer's own resources; the simulation keeps its buffers and textures. */
  dispose(): void {
    const { gl } = this;
    for (let i = 0; i < 2; i++) {
      if (this.vaos[i]) gl.deleteVertexArray(this.vaos[i]);
      this.vaos[i] = this.stateBuffers[i] = null;
    }
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.program) gl.deleteProgram(this.program.program);
    this.quad = null;
    this.program = null;
    this.uniforms = null;
  }

  private vertexArrayFor(buffer: WebGLBuffer): WebGLVertexArrayObject {
    if (this.stateBuffers[0] === buffer) return this.vaos[0]!;
    if (this.stateBuffers[1] === buffer) return this.vaos[1]!;
    const free = this.stateBuffers.indexOf(null);
    if (free < 0) throw new Error("GPU state buffer changed; create a new drawer");
    try {
      if (!this.program) this.createProgram();
      const vao = this.gl.createVertexArray();
      if (!vao) throw new Error("GPU draw resource allocation failed");
      this.vaos[free] = vao;
      this.stateBuffers[free] = buffer;
      this.bindAttributes(vao, buffer);
      return vao;
    } catch (error) {
      // A partial setup is released whole; the next draw starts again.
      this.dispose();
      throw error;
    }
  }

  private createProgram(): void {
    const { gl } = this;
    this.program = createProgram(gl, particleGpuVert, particleFrag);
    const uniform = (name: string) => this.program!.uniform(name);
    this.uniforms = {
      aspect: uniform("u_aspect"), pixel: uniform("u_pixel"), depositScale: uniform("u_depositScale"),
      hue: uniform("u_hue"), intensity: uniform("u_intensity"), sizeScale: uniform("u_sizeScale"),
    };
    gl.useProgram(this.program.program);
    gl.uniform1i(uniform("u_stream"), 1);
    gl.uniform1i(uniform("u_command"), 2);
    gl.uniform4f(uniform("u_look"), LOOK.lightness, LOOK.hueGradient, LOOK.fadeIn, LOOK.fadeOut);

    this.quad = gl.createBuffer();
    if (!this.quad) throw new Error("GPU draw resource allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  }

  private bindAttributes(vao: WebGLVertexArrayObject, buffer: WebGLBuffer): void {
    const { gl } = this;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const offsets = [GPU_MOTION_OFFSET_BYTES, GPU_LIFETIME_OFFSET_BYTES, GPU_SPAWN_OFFSET_BYTES];
    for (let i = 0; i < offsets.length; i++) {
      gl.enableVertexAttribArray(i + 1);
      gl.vertexAttribPointer(i + 1, 4, gl.FLOAT, false, GPU_STATE_STRIDE_BYTES, offsets[i]);
      gl.vertexAttribDivisor(i + 1, 1);
    }
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_INT, GPU_STATE_STRIDE_BYTES, GPU_IDENTITY_OFFSET_BYTES);
    gl.vertexAttribDivisor(4, 1);
  }
}
