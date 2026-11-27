import { LOOK } from "../config";
import { INSTANCE_FLOATS } from "../sim/particles";
import { createProgram, createTarget, deleteTarget, type Program, type Target } from "./gl";
import fadeFrag from "./shaders/fade.frag?raw";
import fullscreenVert from "./shaders/fullscreen.vert?raw";
import particleFrag from "./shaders/particle.frag?raw";
import particleVert from "./shaders/particle.vert?raw";
import presentFrag from "./shaders/present.frag?raw";

/**
 * Particles drawn from state the renderer never sees, such as the experimental GPU simulation.
 * Called once per deposit pass with blending set up; it must leave TEXTURE0 active and its own
 * vertex array, buffers and textures unbound. `pixel` is world units per device pixel.
 */
export interface GpuDrawSource {
  draw(aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number, depositScale: number, pixel: number): void;
}

/** A particle pool as the renderer reads it (`ParticleSystem`): per-slot `instances`, drawn up to `drawCount`. */
export interface ParticleInstances {
  readonly instances: Float32Array;
  readonly drawCount: number;
}
const TRAIL_STEP = 1 / 60;
const REFERENCE_DEPOSIT = -Math.expm1(-TRAIL_STEP / LOOK.trailTau);

/**
 * Fade the previous image into the other target, add particles, then tone-map to the screen.
 * 8-bit trails accumulate at 60 Hz so small high-refresh deposits do not vanish on quantization.
 */
export class Renderer {
  private readonly fade: Program;
  private readonly present: Program;
  private readonly emptyVao: WebGLVertexArrayObject;
  // The CPU pool's program, vertex array and instance buffer; made by `prepareParticles`, so a GPU
  // session links one program less and allocates no instance buffer.
  private particles: Program | null = null;
  private particleVao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  // The CPU pool of the current `render` call, uploaded at its first deposit; null in GPU frames.
  private pool: ParticleInstances | null = null;
  private chroma: Float32Array | null = null;
  private sizeScale = 0;
  private uploaded = false;
  private half: boolean;
  private targets: [Target, Target] | null = null;
  private width = 0;
  private height = 0;
  private trailTime = 0;
  // Per-frame GPU draw arguments, held in fields so a deposit pass allocates nothing.
  private gpuPixelRatio = 1;
  private gpuHue = 0;
  private gpuIntensity = 1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly capacity: number,
  ) {
    this.half = gl.getExtension("EXT_color_buffer_float") !== null;
    this.fade = createProgram(gl, fullscreenVert, fadeFrag);
    this.present = createProgram(gl, fullscreenVert, presentFrag);
    this.emptyVao = gl.createVertexArray();
  }

  /**
   * Sets up drawing the CPU pool: its program, vertex array and an instance buffer for `capacity`
   * particles. `render` does this on first use; call it before the first frame so a shader that does not
   * compile fails at startup. Further calls do nothing.
   */
  prepareParticles(): void {
    if (this.particles) return;
    const { gl } = this;
    const program = createProgram(gl, particleVert, particleFrag);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const attribute = (location: number, size: number, stride: number, offset: number): void => {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
    };
    // One record per slot, uploaded whole every frame: segment, hue and intensity, then stream index
    // and size jitter. Updating spawn-time values separately, in small writes to a second buffer the
    // GPU may still be reading, more than quadrupled GPU time in some runs on the X280 (Task 5).
    const instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    attribute(1, 4, INSTANCE_FLOATS * 4, 0);
    attribute(2, 2, INSTANCE_FLOATS * 4, 16);
    attribute(3, 2, INSTANCE_FLOATS * 4, 24);
    gl.bindVertexArray(null);
    // Assigned last: a failed setup is retried rather than left half made.
    this.particleVao = vao;
    this.instanceBuffer = instanceBuffer;
    this.particles = program;
  }

  /** Whether trails use RGBA16F targets; false once `resize` has fallen back to RGBA8. */
  get halfFloat(): boolean {
    return this.half;
  }

  /** Whether the GL context is lost; its `webglcontextlost` event can arrive after the loss. */
  get contextLost(): boolean {
    return this.gl.isContextLost();
  }

  /**
   * Recreates both trail targets at the new size. Does nothing while the context is lost: every target
   * would come back incomplete, which would drop half-float trails for good and then throw.
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const { gl } = this;
    if (gl.isContextLost()) return;
    if (this.targets) for (const target of this.targets) deleteTarget(gl, target);

    let a = createTarget(gl, width, height, this.half);
    let b = createTarget(gl, width, height, this.half);
    if (!a || !b) {
      // Half-float targets advertised but not renderable: fall back to 8-bit.
      if (a) deleteTarget(gl, a);
      if (b) deleteTarget(gl, b);
      this.half = false;
      a = createTarget(gl, width, height, false);
      b = createTarget(gl, width, height, false);
    }
    if (!a || !b) throw new Error("Cannot create render targets");
    this.targets = [a, b];
    this.width = width;
    this.height = height;
    this.trailTime = 0;
  }

  /**
   * Draws the CPU pool. `chroma` is each stream slot's current chroma (`StreamSet.chroma`); half-widths
   * scale with `devicePixelRatio`. The pool is uploaded once, at the first deposit: a callback without
   * one (8-bit trails above 60 Hz) uploads nothing.
   */
  render(particles: ParticleInstances, chroma: Float32Array, devicePixelRatio: number, dt: number, aspect: number): void {
    this.prepareParticles();
    this.pool = particles;
    this.chroma = chroma;
    this.sizeScale = LOOK.sizePx * devicePixelRatio;
    this.uploaded = false;
    try {
      this.frame(dt, aspect, null);
    } finally {
      this.pool = null;
      this.chroma = null;
    }
  }

  /**
   * The same trails and present pass, with particles drawn by `source` on every deposit. An
   * 8-bit fallback may deposit several times per callback; all of them draw the one simulated state.
   */
  renderGpu(source: GpuDrawSource, dt: number, aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number): void {
    this.gpuPixelRatio = devicePixelRatio;
    this.gpuHue = globalHue;
    this.gpuIntensity = intensityScale;
    this.frame(dt, aspect, source);
  }

  private frame(dt: number, aspect: number, source: GpuDrawSource | null): void {
    const { gl, targets } = this;
    if (!targets) return;
    gl.viewport(0, 0, this.width, this.height);

    try {
      if (this.half) this.accumulate(dt, aspect, source);
      else {
        this.trailTime += dt;
        // Retain fractional time, allowing a tiny tolerance at exact display-period boundaries.
        // Each step is consumed before it is drawn, so a failed deposit is not repeated next frame.
        while (this.trailTime + 1e-9 >= TRAIL_STEP) {
          this.trailTime = Math.max(0, this.trailTime - TRAIL_STEP);
          this.accumulate(TRAIL_STEP, aspect, source);
        }
      }
    } finally {
      // Also after a failed draw, so later GL work does not land in a trail target.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.useProgram(this.present.program);
    // Frames without an accumulate pass would otherwise bind to whichever unit was left active.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets[0].texture);
    gl.uniform1i(this.present.uniform("u_image"), 0);
    gl.uniform1f(this.present.uniform("u_exposure"), LOOK.exposure);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private accumulate(dt: number, aspect: number, source: GpuDrawSource | null): void {
    const { gl } = this;
    const targets = this.targets!;
    const [previous, next] = targets;
    const depositScale = -Math.expm1(-dt / LOOK.trailTau) / REFERENCE_DEPOSIT;

    // Trails: next = previous dimmed.
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
    gl.disable(gl.BLEND);
    gl.useProgram(this.fade.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, previous.texture);
    gl.uniform1i(this.fade.uniform("u_previous"), 0);
    gl.uniform1f(this.fade.uniform("u_decay"), Math.exp(-dt / LOOK.trailTau));
    gl.uniform1f(this.fade.uniform("u_floor"), (this.half ? 0.0005 : 1.5 / 255) * depositScale);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Particles, added on top. A GPU source draws every slot below its horizon: only the GPU knows the live count.
    if (source) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      try {
        source.draw(aspect, this.gpuPixelRatio, this.gpuHue, this.gpuIntensity, depositScale, 1 / this.height);
      } finally {
        gl.disable(gl.BLEND);
      }
    } else if (this.pool && this.pool.drawCount > 0) {
      const pool = this.pool;
      const particles = this.particles!;
      if (!this.uploaded) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pool.instances, 0, pool.drawCount * INSTANCE_FLOATS);
        this.uploaded = true;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(particles.program);
      gl.uniform1f(particles.uniform("u_aspect"), aspect);
      gl.uniform1f(particles.uniform("u_pixel"), 1 / this.height);
      gl.uniform1f(particles.uniform("u_sizeScale"), this.sizeScale);
      gl.uniform1f(particles.uniform("u_lightness"), LOOK.lightness);
      gl.uniform1fv(particles.uniform("u_chroma"), this.chroma!);
      // Match the trail decay at any frame rate, retaining the original deposit at 60 Hz.
      gl.uniform1f(particles.uniform("u_depositScale"), depositScale);
      gl.bindVertexArray(this.particleVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pool.drawCount);
      gl.disable(gl.BLEND);
    }

    targets[0] = next;
    targets[1] = previous;
  }
}
