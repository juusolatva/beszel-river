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

const NO_INSTANCES = new Float32Array(0);
const TRAIL_STEP = 1 / 60;
const REFERENCE_DEPOSIT = -Math.expm1(-TRAIL_STEP / LOOK.trailTau);

/**
 * Fade the previous image into the other target, add particles, then tone-map to the screen.
 * 8-bit trails accumulate at 60 Hz so small high-refresh deposits do not vanish on quantization.
 */
export class Renderer {
  private readonly particles: Program;
  private readonly fade: Program;
  private readonly present: Program;
  private readonly particleVao: WebGLVertexArrayObject;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
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
    capacity: number,
  ) {
    this.half = gl.getExtension("EXT_color_buffer_float") !== null;
    this.particles = createProgram(gl, particleVert, particleFrag);
    this.fade = createProgram(gl, fullscreenVert, fadeFrag);
    this.present = createProgram(gl, fullscreenVert, presentFrag);
    this.emptyVao = gl.createVertexArray();

    this.particleVao = gl.createVertexArray();
    gl.bindVertexArray(this.particleVao);

    const cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    const attributes: [location: number, size: number, offset: number][] = [
      [1, 4, 0],
      [2, 4, 16],
      [3, 1, 32],
    ];
    for (const [location, size, offset] of attributes) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    const { gl } = this;
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

  render(instances: Float32Array, count: number, dt: number, aspect: number): void {
    this.frame(dt, aspect, instances, count, null);
  }

  /**
   * The same trails and present pass, with particles drawn by `source` on every deposit. An
   * 8-bit fallback may deposit several times per callback; all of them draw the one simulated state.
   */
  renderGpu(source: GpuDrawSource, dt: number, aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number): void {
    this.gpuPixelRatio = devicePixelRatio;
    this.gpuHue = globalHue;
    this.gpuIntensity = intensityScale;
    this.frame(dt, aspect, NO_INSTANCES, 0, source);
  }

  private frame(dt: number, aspect: number, instances: Float32Array, count: number, source: GpuDrawSource | null): void {
    const { gl, targets } = this;
    if (!targets) return;
    gl.viewport(0, 0, this.width, this.height);

    if (this.half) this.accumulate(dt, aspect, instances, count, source);
    else {
      this.trailTime += dt;
      // Retain fractional time, allowing a tiny tolerance at exact display-period boundaries.
      while (this.trailTime + 1e-9 >= TRAIL_STEP) {
        this.accumulate(TRAIL_STEP, aspect, instances, count, source);
        this.trailTime = Math.max(0, this.trailTime - TRAIL_STEP);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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

  private accumulate(dt: number, aspect: number, instances: Float32Array, count: number, source: GpuDrawSource | null): void {
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

    // Particles, added on top. A GPU source draws its whole pool: only the GPU knows the live count.
    if (source) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      source.draw(aspect, this.gpuPixelRatio, this.gpuHue, this.gpuIntensity, depositScale, 1 / this.height);
      gl.disable(gl.BLEND);
    } else if (count > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.particles.program);
      gl.uniform1f(this.particles.uniform("u_aspect"), aspect);
      gl.uniform1f(this.particles.uniform("u_pixel"), 1 / this.height);
      // Match the trail decay at any frame rate, retaining the original deposit at 60 Hz.
      gl.uniform1f(this.particles.uniform("u_depositScale"), depositScale);
      gl.bindVertexArray(this.particleVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * INSTANCE_FLOATS);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.disable(gl.BLEND);
    }

    targets[0] = next;
    targets[1] = previous;
  }
}
