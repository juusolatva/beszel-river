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
  private readonly programs: Program[] = [];
  private emptyVao: WebGLVertexArrayObject | null = null;
  // One flag vertex array per state buffer, set up at construction or on its first scan.
  private readonly stateBuffers: (WebGLBuffer | null)[] = [null, null];
  private readonly flagVaos: (WebGLVertexArrayObject | null)[] = [null, null];
  private readonly zero = new Uint32Array(4);
  private current = 0;
  private readonly offset!: WebGLUniformLocation | null;
  private readonly count!: WebGLUniformLocation | null;
  private countSet = 0;

  /** `stateBuffers`, at most two, get their flag vertex arrays now instead of on their first scan. */
  constructor(private readonly gl: WebGL2RenderingContext, private readonly capacity: number, stateBuffers: readonly WebGLBuffer[] = []) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid GPU scan capacity");
    this.width = Math.min(128, capacity);
    this.height = Math.ceil(capacity / this.width);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.width > max || this.height > max) throw new Error("GPU scan exceeds texture size");
    try {
      // Register each program before the next creation can throw, so dispose owns it.
      this.programs.push(createProgram(gl, flagsVertex, flagsFragment));
      this.programs.push(createProgram(gl, fullscreenVertex, scanFragment));
      // Only the pass offset changes between scans; everything else is set once here.
      gl.useProgram(this.programs[0].program);
      gl.uniform1i(this.programs[0].uniform("u_width"), this.width);
      gl.uniform1i(this.programs[0].uniform("u_height"), this.height);
      gl.useProgram(this.programs[1].program);
      gl.uniform1i(this.programs[1].uniform("u_source"), 0);
      gl.uniform1i(this.programs[1].uniform("u_width"), this.width);
      this.count = this.programs[1].uniform("u_capacity");
      gl.uniform1i(this.count, capacity);
      this.countSet = capacity;
      this.offset = this.programs[1].uniform("u_offset");
      this.emptyVao = this.resource(gl.createVertexArray());
      for (let i = 0; i < 2; i++) {
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
      for (const buffer of stateBuffers) this.flagVaoFor(buffer);
    } catch (error) { this.dispose(); throw error; }
    finally { this.clearBindings(); }
  }

  get prefixTexture(): WebGLTexture { return this.textures[this.current]; }

  /**
   * Queues a copy of the prefix at slot `count - 1` (the inactive slots among the first `count`) from
   * the last `scan`, which must have covered at least `count` slots, into `buffer` (16 bytes), as a
   * `PIXEL_PACK_BUFFER`. Nothing waits for it: fence it, and read the buffer once the fence signals.
   */
  copyTotal(count: number, buffer: WebGLBuffer): void {
    if (!Number.isInteger(count) || count < 1 || count > this.capacity) throw new Error("Invalid GPU scan count");
    const gl = this.gl;
    const last = count - 1;
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffers[this.current]);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      // RGBA_INTEGER with UNSIGNED_INT is the read format WebGL2 guarantees for an unsigned integer target.
      gl.readPixels(last % this.width, Math.floor(last / this.width), 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }
  }

  /**
   * Prefix of the first `count` slots (default all): one flag pass followed by ceil(log2(count))
   * disjoint integer passes over the rows that hold them. Later slots keep stale prefixes; read none.
   */
  scan(stateBuffer: WebGLBuffer, count = this.capacity): void {
    if (!Number.isInteger(count) || count < 1 || count > this.capacity) throw new Error("Invalid GPU scan count");
    const gl = this.gl;
    try {
      const flagVao = this.flagVaoFor(stateBuffer);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.disable(gl.BLEND); gl.disable(gl.DITHER); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, this.width, this.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[0]);
      gl.clearBufferuiv(gl.COLOR, 0, this.zero);
      gl.useProgram(this.programs[0].program);
      gl.bindVertexArray(flagVao);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.bindVertexArray(this.emptyVao);
      gl.useProgram(this.programs[1].program);
      if (count !== this.countSet) {
        gl.uniform1i(this.count, count);
        this.countSet = count;
      }
      // Window coordinates index texels, so a shorter viewport just skips the rows past `count`.
      gl.viewport(0, 0, this.width, Math.ceil(count / this.width));
      this.current = 0;
      for (let offset = 1; offset < count; offset *= 2) {
        // Unbind the old source before it becomes the next destination.
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[1 - this.current]);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.current]);
        gl.uniform1i(this.offset, offset);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.current = 1 - this.current;
      }
    } finally { this.clearBindings(); }
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.programs) gl.deleteProgram(p.program);
    for (const v of [this.emptyVao, ...this.flagVaos]) if (v) gl.deleteVertexArray(v);
    for (const f of this.framebuffers) gl.deleteFramebuffer(f);
    for (const t of this.textures) gl.deleteTexture(t);
    this.programs.length = this.framebuffers.length = this.textures.length = 0;
    this.emptyVao = null;
    this.flagVaos.fill(null);
    this.stateBuffers.fill(null);
  }

  private flagVaoFor(buffer: WebGLBuffer): WebGLVertexArrayObject {
    if (this.stateBuffers[0] === buffer) return this.flagVaos[0]!;
    if (this.stateBuffers[1] === buffer) return this.flagVaos[1]!;
    const free = this.stateBuffers.indexOf(null);
    if (free < 0) throw new Error("GPU scan state buffer changed; create a new scan");
    const gl = this.gl;
    const vao = this.resource(gl.createVertexArray());
    this.flagVaos[free] = vao;
    this.stateBuffers[free] = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, GPU_STATE_STRIDE_BYTES, GPU_IDENTITY_OFFSET_BYTES);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
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
