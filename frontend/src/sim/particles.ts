import { LOOK } from "../config";
import { clamp, fract, gaussian, lerp, type Random } from "../util/math";
import type { FlowField } from "./noise";
import { CENTER_MAX_Y, CENTER_MIN_Y, CENTER_SAMPLES, CENTER_SCALE, MIN_SHARE, laneCenter, type StreamSet } from "./streams";

/**
 * Per-slot floats rewritten by `step`, in attribute order: tail x, tail y, head x, head y, hue (turns),
 * intensity. A dead slot keeps intensity 0, which the vertex shader clips.
 */
export const INSTANCE_FLOATS = 6;
/** Per-slot floats written on spawn: stream slot index, size jitter (half-width in `LOOK.sizePx`). */
export const METADATA_FLOATS = 2;

/**
 * Fixed-size particle pool simulated on the CPU. Particles keep their slot for life, so `instances`
 * and `metadata` are indexed by slot: the renderer uploads the first `drawCount` slots of `instances`
 * every frame, and of `metadata` only the slots flagged in `metadataDirty`.
 */
export class ParticleSystem {
  readonly instances: Float32Array;
  readonly metadata: Float32Array;
  /** 1 for each slot whose metadata changed since `clearMetadataDirty`, all within `dirtyStart`..`dirtyEnd`. */
  readonly metadataDirty: Uint8Array;
  /** First flagged slot, or `capacity` when none is. */
  dirtyStart: number;
  /** One past the last flagged slot, or 0 when none is. */
  dirtyEnd = 0;
  /** Highest live slot plus one; every live particle lies below it. */
  drawCount = 0;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly hueJitter: Float32Array;
  private readonly size: Float32Array;
  private readonly speedJitter: Float32Array;
  /** Steering target, band half-widths from the centre line: the spawn offset in a lane, or 0 outside lanes. */
  private readonly offset: Float32Array;
  private readonly slot: Uint8Array;
  private readonly active: Uint8Array;
  private readonly free: Int32Array;
  private freeTop: number;
  private globalHue = 0;
  /** Most particles alive at once (`ParticleBudget`), at most `capacity`. */
  limit: number;
  /** Brightness factor for a thinned pool. */
  intensityScale = 1;

  constructor(
    readonly capacity: number,
    private readonly random: Random,
  ) {
    this.instances = new Float32Array(capacity * INSTANCE_FLOATS);
    this.metadata = new Float32Array(capacity * METADATA_FLOATS);
    this.metadataDirty = new Uint8Array(capacity);
    this.dirtyStart = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.hueJitter = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.speedJitter = new Float32Array(capacity);
    this.offset = new Float32Array(capacity);
    this.slot = new Uint8Array(capacity);
    this.active = new Uint8Array(capacity);
    this.free = Int32Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
    this.freeTop = capacity;
    this.limit = capacity;
  }

  get count(): number {
    return this.capacity - this.freeTop;
  }

  /** Called by the renderer once it has uploaded the flagged metadata. */
  clearMetadataDirty(): void {
    if (this.dirtyStart < this.dirtyEnd) this.metadataDirty.fill(0, this.dirtyStart, this.dirtyEnd);
    this.dirtyStart = this.capacity;
    this.dirtyEnd = 0;
  }

  /**
   * Rebuilds `drawCount`, metadata and dead slots' intensity from the particle state, flagging every
   * slot. For test fixtures that write the state directly instead of spawning.
   */
  resync(): void {
    this.drawCount = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i]) {
        this.metadata[i * METADATA_FLOATS] = this.slot[i];
        this.metadata[i * METADATA_FLOATS + 1] = this.size[i];
        this.drawCount = i + 1;
      } else this.instances[i * INSTANCE_FLOATS + 5] = 0;
    }
    this.metadataDirty.fill(1);
    this.dirtyStart = 0;
    this.dirtyEnd = this.capacity;
  }

  /** Spawns along the bottom edge; rates are normalized so `limit` particles turn over every `turnoverSeconds`. */
  spawn(dt: number, streams: StreamSet): void {
    let share = 0;
    for (const s of streams.slots) if (s.used) share += s.shareWeight;
    if (share <= 0) return;

    const { random } = this;
    // Never below one full stream's share: otherwise the last streams fading out would keep the
    // whole pool between them, and the river would never drain.
    const baseRate = this.limit / LOOK.turnoverSeconds / Math.max(share, MIN_SHARE);
    for (let slotIndex = 0; slotIndex < streams.slots.length; slotIndex++) {
      const s = streams.slots[slotIndex];
      if (!s.used) continue;
      s.spawnCarry += baseRate * s.spawnWeight * dt;
      const n = Math.floor(s.spawnCarry);
      s.spawnCarry -= n;
      for (let k = 0; k < n && this.capacity - this.freeTop < this.limit; k++) {
        const i = this.free[--this.freeTop];
        this.active[i] = 1;
        this.slot[i] = slotIndex;
        this.speedJitter[i] = lerp(LOOK.speedJitter[0], LOOK.speedJitter[1], random());
        // With filaments, particles start in a lane picked by its activity and keep their place in it,
        // so a busy lane, scattering little, shows as a strand.
        if (s.filamentMix > 0.001 && random() < s.filamentMix) {
          const lane = s.pickLane(random());
          const activity = s.filaments[lane];
          this.offset[i] = laneCenter(lane) + gaussian(random) * lerp(LOOK.filamentSpread[0], LOOK.filamentSpread[1], activity);
          this.x[i] = s.centerAt(0) + this.offset[i] * s.half;
          this.speedJitter[i] *= lerp(LOOK.filamentSpeed[0], LOOK.filamentSpeed[1], activity);
        } else {
          this.offset[i] = 0;
          this.x[i] = s.centerAt(0) + gaussian(random) * s.half * LOOK.spawnSpread;
        }
        this.y[i] = -0.02 * random();
        this.vx[i] = 0;
        this.vy[i] = s.speed;
        this.age[i] = 0;
        this.life[i] = lerp(LOOK.lifeRange[0], LOOK.lifeRange[1], random());
        this.hueJitter[i] = (random() - 0.5) * 2 * LOOK.hueJitter;
        this.size[i] = lerp(LOOK.sizeJitter[0], LOOK.sizeJitter[1], random());
        s.particles++;
        const m = i * METADATA_FLOATS;
        this.metadata[m] = slotIndex;
        this.metadata[m + 1] = this.size[i];
        this.metadataDirty[i] = 1;
        if (i < this.dirtyStart) this.dirtyStart = i;
        if (i >= this.dirtyEnd) this.dirtyEnd = i + 1;
        if (i >= this.drawCount) this.drawCount = i + 1;
      }
    }
  }

  /** Advances every particle and writes its slot of `instances`; returns the live count. */
  step(dt: number, streams: StreamSet, field: FlowField, aspect: number): number {
    const { x, y, vx, vy, age, life, instances } = this;
    const slots = streams.slots;
    const k = 1 - Math.exp(-dt / LOOK.inertia);
    // Flow grid, read once per step: the same clamped bilinear interpolation as `FlowField.sample`,
    // inlined with locals instead of a call that writes two properties per particle.
    const flow = field.vectors, cols = field.gridCols, cell = field.gridCell;
    const maxFx = cols - 1.001, maxFy = field.gridRows - 1.001;
    // Centre lines, likewise: `StreamSlot.centerAt`'s interpolation over the shared table.
    const centers = streams.centers;
    this.globalHue = fract(this.globalHue + LOOK.hueRotate * dt);
    const end = this.drawCount;
    let highest = -1;

    for (let i = 0; i < end; i++) {
      if (!this.active[i]) continue;
      const slotIndex = this.slot[i];
      const s = slots[slotIndex];
      age[i] += dt;
      if (age[i] > life[i] || y[i] > 1.08 || x[i] < -0.1 || x[i] > aspect + 0.1) {
        this.active[i] = 0;
        this.free[this.freeTop++] = i;
        s.particles--;
        instances[i * INSTANCE_FLOATS + 5] = 0;
        continue;
      }
      highest = i;

      // Upward speed from the stream, sideways from curl noise plus a pull to the centre line (or lane).
      // The heading stays within ±maxSlope of vertical: data changes speed and wiggle, not direction.
      const fx = Math.min(Math.max(x[i] / cell, 0), maxFx);
      const fy = Math.min(Math.max(y[i] / cell, 0), maxFy);
      const c = Math.floor(fx);
      const r = Math.floor(fy);
      const tx = fx - c;
      const ty = fy - r;
      const i00 = (r * cols + c) * 2;
      const i10 = i00 + cols * 2;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      const flowX = flow[i00] * w00 + flow[i00 + 2] * w01 + flow[i10] * w10 + flow[i10 + 2] * w11;
      const flowY = flow[i00 + 1] * w00 + flow[i00 + 3] * w01 + flow[i10 + 1] * w10 + flow[i10 + 3] * w11;
      const py = y[i];
      let center: number;
      if (py < CENTER_MIN_Y || py > CENTER_MAX_Y) {
        center = s.centerAt(py);
      } else {
        const position = (py - CENTER_MIN_Y) * CENTER_SCALE;
        const sample = Math.min(Math.floor(position), CENTER_SAMPLES - 2);
        const c = slotIndex * CENTER_SAMPLES + sample;
        center = centers[c] + (centers[c + 1] - centers[c]) * (position - sample);
      }
      const up = s.speed * this.speedJitter[i];
      const limit = LOOK.maxSlope * up;
      const side = clamp(flowX * s.turbulenceAmp * up + (center + this.offset[i] * s.half - x[i]) * LOOK.steer, -limit, limit);
      vx[i] += (side - vx[i]) * k;
      vy[i] += (up * (1 + 0.3 * flowY * s.turbulenceAmp) - vy[i]) * k;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;

      const fade = Math.min(age[i] / LOOK.fadeIn, (life[i] - age[i]) / LOOK.fadeOut, 1);
      const o = i * INSTANCE_FLOATS;
      instances[o] = x[i] - vx[i] * s.streakSeconds;
      instances[o + 1] = y[i] - vy[i] * s.streakSeconds;
      instances[o + 2] = x[i];
      instances[o + 3] = y[i];
      instances[o + 4] = fract(this.globalHue + y[i] * LOOK.hueGradient + s.hueOffset + this.hueJitter[i]);
      instances[o + 5] = LOOK.intensity * this.intensityScale * fade * s.brightness;
    }
    // Slots above the highest survivor are all dead now: stop drawing them.
    this.drawCount = highest + 1;
    return this.count;
  }
}
