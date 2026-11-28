import { LOOK } from "../config";
import { createProgram, type Program } from "../render/gl";
import vertexSource from "../render/shaders/simulate.vert?raw";
import fragmentSource from "../render/shaders/simulate.frag?raw";
import { fract } from "../util/math";
import { GPU_FEEDBACK_VARYINGS, GPU_IDENTITY_OFFSET_BYTES, GPU_LIFETIME_OFFSET_BYTES,
  GPU_MOTION_OFFSET_BYTES, GPU_SPAWN_OFFSET_BYTES, GPU_STATE_STRIDE_BYTES } from "./gpu-layout";
import { FLOW_CELL, type FlowField } from "./noise";
import { GpuFreeScan } from "./gpu-free-scan";
import { effectiveGpuStep, GPU_DRAIN_SECONDS, GpuLifecycle } from "./gpu-lifecycle";
import { MAX_STREAMS, type StreamSet } from "./streams";

/** Steps between live-count readbacks while counting; one is in flight at a time. */
export const GPU_COUNT_EVERY = 12;

/**
 * Isolated transform-feedback experiment; production continues to use ParticleSystem.
 *
 * Steps and draws cover only the slots below an active horizon. Free ranks run upwards from slot 0
 * and births never exceed `limit - live`, so every birth lands below `limit`, and below 0 on a step
 * without requests. Once that reach has stayed under a lower value for the drain deadline, every
 * slot from there up has died; two more full steps write that into both state buffers, and the
 * horizon drops to it. A higher reach raises the horizon at once, since the slots above are dead.
 * This assumes every live particle was born here: test fixtures that preload state keep spawning
 * off, or run for less than the deadline.
 */
export class GpuParticles {
  readonly lifecycle: GpuLifecycle;
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
  private scan: GpuFreeScan | null = null;
  private readonly uniforms!: Record<"dt" | "bounds" | "physics" | "limit" | "enabled" | "capacity", WebGLUniformLocation | null>;
  private horizon: number;
  private horizonSet: number;
  // Live count: read back from the free scan without waiting, so it describes a step a few frames ago.
  private live: number | null = null;
  private counting = false;
  private countBuffer: WebGLBuffer | null = null;
  private countSync: WebGLSync | null = null;
  private countHorizon = 0;
  private stepsSinceCount = 0;
  private readonly countOut = new Uint32Array(4);
  // Simulation seconds, and the claim that since `reachSince` no birth could land at or above `reach`.
  private clock = 0;
  private reach = 0;
  private reachSince = 0;
  private settledSteps = 0;
  private readonly streamData = new Float32Array(24 * MAX_STREAMS * 4);
  private cols = 0;
  private rows = 0;
  private readonly maxTextureSize: number;

  constructor(private readonly gl: WebGL2RenderingContext, readonly capacity: number, private readonly seed: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid GPU capacity");
    this.lifecycle = new GpuLifecycle(capacity);
    this.limit = capacity;
    this.horizon = this.horizonSet = capacity;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 4 || gl.getParameter(gl.MAX_VERTEX_ATTRIBS) < 5 ||
      gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS) < 16 || this.maxTextureSize < 32) {
      throw new Error("GPU motion unsupported: insufficient WebGL2 limits");
    }
    try {
      this.program = createProgram(gl, vertexSource, fragmentSource, GPU_FEEDBACK_VARYINGS);
      const program = this.program, uniform = (name: string) => program.uniform(name);
      this.uniforms = {
        dt: uniform("u_dt"), bounds: uniform("u_bounds"), physics: uniform("u_physics"),
        limit: uniform("u_limit"), enabled: uniform("u_enabled"), capacity: uniform("u_capacity"),
      };
      this.feedback = gl.createTransformFeedback();
      if (!this.feedback) throw new Error("GPU resource allocation failed");
      this.createStateBuffers();
      this.createDataTextures();
      this.scan = new GpuFreeScan(gl, capacity, this.buffers);
      this.countBuffer = gl.createBuffer() as WebGLBuffer | null;
      if (!this.countBuffer) throw new Error("GPU resource allocation failed");
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.countBuffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.setConstantUniforms(this.scan.width);
    } catch (error) {
      this.dispose();
      throw error;
    } finally { this.clearBindings(); }
  }

  get stateBuffer(): WebGLBuffer { return this.buffers[this.current]; }
  /** Both state buffers, which `step` alternates between; for drawers that set up ahead of time. */
  get stateBuffers(): readonly WebGLBuffer[] { return this.buffers; }
  get streamTexture(): WebGLTexture { return this.textures[1]; }
  get commandTexture(): WebGLTexture { return this.textures[2]; }
  get globalHue(): number { return this.hue; }
  /** Slots the next step and draw cover, from 0: every slot at or above it is dead in both buffers. */
  get activeSlots(): number { return this.horizon; }
  /**
   * Live particles while `countingLive` is on: the exact count before the step that asked for it,
   * delivered a few steps later (asked every `GPU_COUNT_EVERY` steps), or 0 from a step whose horizon
   * was empty. Null before the first one and whenever counting is off. For the budget and `?debug`;
   * never an estimate.
   */
  get liveCount(): number | null { return this.live; }

  /**
   * Whether to read the live count back. Off by default: in Chrome reading the buffer waits for the GPU
   * process, which took 2–13 ms per readback on a UHD 620 laptop. Turning it on forgets any earlier count,
   * so the next one describes a step from now on, and asks for it on the next step.
   */
  get countingLive(): boolean { return this.counting; }
  set countingLive(on: boolean) {
    if (on === this.counting) return;
    this.counting = on;
    this.forgetLiveCount();
  }

  /** Drops the current count and any readback in flight; while counting, asks again on the next step. */
  forgetLiveCount(): void {
    this.dropCount();
    this.live = null;
    this.stepsSinceCount = GPU_COUNT_EVERY - 1;
  }

  /** Advance using a Float32-effective step shared by prototype replay, easing and CPU reference. */
  step(dt: number, streams: StreamSet, field: FlowField, aspect: number): void {
    if (dt <= 0) return;
    dt = effectiveGpuStep(dt);
    this.pollCount();
    this.clock += dt;
    let births = false;
    if (this.spawningEnabled) {
      this.lifecycle.prepare(dt, streams, this.limit);
      births = this.lifecycle.commands[MAX_STREAMS * 4 - 1] > 0;
      this.trackHorizon(births ? this.limit : 0);
    } else {
      // Preloaded state may live anywhere; never shrink while spawning is off.
      this.restartReach(this.horizon);
    }
    if (this.horizon === 0) {
      // Nothing is alive and nothing is born: no pass to run, nothing for the drawer to read. A
      // readback still in flight describes an earlier state, so it is dropped. Without counting nothing
      // would replace the 0 once the river refills, so it is reported only while counting.
      this.dropCount();
      this.live = this.counting ? 0 : null;
      this.hue = fract(this.hue + LOOK.hueRotate * dt);
      return;
    }
    const gl = this.gl;
    let begun = false;
    const count = this.counting && this.countSync === null && ++this.stepsSinceCount >= GPU_COUNT_EVERY;
    try {
      // Without requests no slot reads a free rank, so the scan would be wasted unless a count is
      // due. The commands are still uploaded: the drawer hides stale generations with them.
      if (births || count) this.scan!.scan(this.stateBuffer, this.horizon);
      if (count) this.requestCount();
      this.uploadInputs(streams, field);
      const u = this.uniforms;
      gl.useProgram(this.program!.program);
      if (this.horizonSet !== this.horizon) {
        gl.uniform1i(u.capacity, this.horizon);
        this.horizonSet = this.horizon;
      }
      gl.uniform1ui(u.limit, this.limit);
      gl.uniform1i(u.enabled, births ? 1 : 0);
      gl.uniform1f(u.dt, dt);
      // Float32(-0.1) is below the CPU double bound; Float32(1.08) is above it.
      // Equality at those rounded values is therefore a death on the CPU too.
      const upper = Math.fround(aspect + 0.1);
      gl.uniform4f(u.bounds, Math.fround(-0.1), Math.fround(1.08), upper, upper > aspect + 0.1 ? 1 : 0);
      gl.uniform3f(u.physics, LOOK.steer, LOOK.maxSlope, 1 - Math.exp(-dt / LOOK.inertia));
      gl.bindVertexArray(this.vaos[this.current]);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[1 - this.current]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS);
      begun = true;
      gl.drawArrays(gl.POINTS, 0, this.horizon);
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
    this.scan?.dispose();
    this.scan = null;
    this.dropCount();
    if (this.countBuffer) gl.deleteBuffer(this.countBuffer);
    this.countBuffer = null;
    this.vaos.length = this.buffers.length = this.textures.length = 0;
    this.feedback = null;
    this.program = null;
  }

  /**
   * Copies the free-slot total of the scan just run and fences it. Slots from the horizon up are dead
   * in the scanned buffer, so live = horizon − free.
   */
  private requestCount(): void {
    const gl = this.gl;
    this.scan!.copyTotal(this.horizon, this.countBuffer!);
    this.countSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) as WebGLSync | null;
    this.countHorizon = this.horizon;
    this.stepsSinceCount = 0;
  }

  /** Reads a fenced count once the GPU has written it; never waits. */
  private pollCount(): void {
    const sync = this.countSync;
    if (!sync) return;
    const gl = this.gl;
    const status = gl.clientWaitSync(sync, 0, 0);
    if (status === gl.WAIT_FAILED) {
      this.dropCount();
      return;
    }
    if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.countBuffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.countOut);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.dropCount();
    this.live = Math.max(0, this.countHorizon - this.countOut[0]);
  }

  private dropCount(): void {
    if (this.countSync) this.gl.deleteSync(this.countSync);
    this.countSync = null;
  }

  /** Moves the horizon for this step, given the slot count below which any birth must land. */
  private trackHorizon(reach: number): void {
    if (reach > this.horizon) this.horizon = reach;
    if (reach > this.reach) this.reach = reach;
    if (this.reach >= this.horizon) {
      this.restartReach(reach);
      return;
    }
    if (this.clock - this.reachSince <= GPU_DRAIN_SECONDS) return;
    // Particles above `reach` were born before `reachSince` and die by this step's output; the
    // next step copies them dead into the other buffer. Shrink on the step after that.
    if (++this.settledSteps < 3) return;
    this.horizon = this.reach;
    this.restartReach(reach);
  }

  private restartReach(reach: number): void {
    this.reach = reach;
    this.reachSince = this.clock;
    this.settledSteps = 0;
  }

  /** Samplers, sizes and `LOOK` values, which never change after linking. */
  private setConstantUniforms(scanWidth: number): void {
    const gl = this.gl, program = this.program!, uniform = (name: string) => program.uniform(name);
    gl.useProgram(program.program);
    gl.uniform1i(uniform("u_flow"), 0);
    gl.uniform1i(uniform("u_stream"), 1);
    gl.uniform1i(uniform("u_command"), 2);
    gl.uniform1i(uniform("u_prefix"), 3);
    gl.uniform1i(uniform("u_width"), scanWidth);
    gl.uniform1i(uniform("u_capacity"), this.capacity);
    gl.uniform1ui(uniform("u_seed"), this.seed >>> 0);
    gl.uniform4f(uniform("u_birth"), LOOK.speedJitter[0], LOOK.speedJitter[1], LOOK.spawnSpread, LOOK.hueJitter);
    gl.uniform4f(uniform("u_lifeSize"), LOOK.lifeRange[0], LOOK.lifeRange[1], LOOK.sizeJitter[0], LOOK.sizeJitter[1]);
    gl.uniform4f(uniform("u_filament"), LOOK.filamentSpread[0], LOOK.filamentSpread[1], LOOK.filamentSpeed[0], LOOK.filamentSpeed[1]);
    gl.uniform1f(uniform("u_span"), LOOK.filamentSpan);
    gl.uniform1f(uniform("u_cell"), FLOW_CELL);
    gl.uniform2f(uniform("u_braid"), LOOK.braid, LOOK.braidWaves);
  }

  private createStateBuffers(): void {
    const gl = this.gl;
    const offsets = [GPU_MOTION_OFFSET_BYTES, GPU_LIFETIME_OFFSET_BYTES, GPU_SPAWN_OFFSET_BYTES];
    for (let i = 0; i < 2; i++) {
      const buffer = this.own(this.buffers, gl.createBuffer());
      const vao = this.own(this.vaos, gl.createVertexArray());
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * GPU_STATE_STRIDE_BYTES, gl.DYNAMIC_COPY);
      for (let j = 0; j < offsets.length; j++) {
        gl.enableVertexAttribArray(j);
        gl.vertexAttribPointer(j, 4, gl.FLOAT, false, GPU_STATE_STRIDE_BYTES, offsets[j]);
      }
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, GPU_STATE_STRIDE_BYTES, GPU_IDENTITY_OFFSET_BYTES);
    }
  }

  private createDataTextures(): void {
    const gl = this.gl;
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cols, rows, 0, gl.RG, gl.FLOAT, null);
      this.cols = cols;
      this.rows = rows;
    }
    // texSubImage2D copies before returning, so the field's own grid can be uploaded directly.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.FLOAT, field.vectors);
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
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.commandTexture);
    if (this.spawningEnabled) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, MAX_STREAMS, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.lifecycle.commands);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.scan!.prefixTexture);
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
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
