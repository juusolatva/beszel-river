import { createProgram, type Program } from "../render/gl";
import flagsVertex from "../render/shaders/free-flags.vert?raw";
import flagsFragment from "../render/shaders/free-flags.frag?raw";
import fullscreenVertex from "../render/shaders/fullscreen.vert?raw";
import scanFragment from "../render/shaders/free-scan.frag?raw";
import { GPU_IDENTITY_OFFSET_BYTES, GPU_STATE_STRIDE_BYTES } from "./gpu-layout";

/** GPU-local inclusive prefix of pre-step inactive slots. */
export class GpuFreeScan {
  readonly width: number;
  readonly height: number;
  private readonly textures: WebGLTexture[] = [];
  private readonly framebuffers: WebGLFramebuffer[] = [];
  private readonly vaos: WebGLVertexArrayObject[] = [];
  private readonly programs: Program[] = [];
  private readonly zero = new Uint32Array(4);
  private current = 0;
  private uniforms!: Record<"flagWidth" | "flagHeight" | "source" | "width" | "capacity" | "offset", WebGLUniformLocation | null>;

  constructor(private readonly gl: WebGL2RenderingContext, private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid GPU scan capacity");
    this.width = Math.min(128, capacity);
    this.height = Math.ceil(capacity / this.width);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.width > max || this.height > max) throw new Error("GPU scan exceeds texture size");
    try {
      this.programs.push(createProgram(gl, flagsVertex, flagsFragment));
      this.programs.push(createProgram(gl, fullscreenVertex, scanFragment));
      this.uniforms = {
        flagWidth: this.programs[0].uniform("u_width"), flagHeight: this.programs[0].uniform("u_height"),
        source: this.programs[1].uniform("u_source"), width: this.programs[1].uniform("u_width"),
        capacity: this.programs[1].uniform("u_capacity"), offset: this.programs[1].uniform("u_offset"),
      };
      for (let i = 0; i < 2; i++) {
        this.vaos.push(this.resource(gl.createVertexArray()));
        const texture = this.resource(gl.createTexture()); this.textures.push(texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, this.width, this.height, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, null);
        const framebuffer = this.resource(gl.createFramebuffer()); this.framebuffers.push(framebuffer);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("GPU scan integer target unavailable");
      }
    } catch (error) { this.dispose(); throw error; }
    finally { this.clearBindings(); }
  }

  get prefixTexture(): WebGLTexture { return this.textures[this.current]; }

  /** One flag pass followed by ceil(log2(capacity)) disjoint integer passes. */
  scan(stateBuffer: WebGLBuffer): void {
    const gl = this.gl, u = this.uniforms;
    try {
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, this.width, this.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[0]);
      gl.clearBufferuiv(gl.COLOR, 0, this.zero);
      gl.useProgram(this.programs[0].program);
      gl.uniform1i(u.flagWidth, this.width); gl.uniform1i(u.flagHeight, this.height);
      gl.bindVertexArray(this.vaos[0]);
      gl.bindBuffer(gl.ARRAY_BUFFER, stateBuffer);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, GPU_STATE_STRIDE_BYTES, GPU_IDENTITY_OFFSET_BYTES);
      gl.drawArrays(gl.POINTS, 0, this.capacity);
      gl.bindVertexArray(this.vaos[1]);
      gl.useProgram(this.programs[1].program);
      gl.uniform1i(u.source, 0); gl.uniform1i(u.width, this.width); gl.uniform1i(u.capacity, this.capacity);
      this.current = 0;
      for (let offset = 1; offset < this.capacity; offset *= 2) {
        // Unbind the old source before it becomes the next destination.
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[1 - this.current]);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.current]);
        gl.uniform1i(u.offset, offset);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.current = 1 - this.current;
      }
    } finally { this.clearBindings(); }
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.programs) gl.deleteProgram(p.program);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    for (const f of this.framebuffers) gl.deleteFramebuffer(f);
    for (const t of this.textures) gl.deleteTexture(t);
    this.programs.length = this.vaos.length = this.framebuffers.length = this.textures.length = 0;
  }

  private resource<T>(value: T | null): T {
    if (!value) throw new Error("GPU scan resource allocation failed");
    return value;
  }

  private clearBindings(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
