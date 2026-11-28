import { LOOK } from "../config";
import { clamp, fract, gaussian, lerp, type Random } from "../util/math";
import type { FlowField } from "./noise";
import { CENTER_MAX_Y, CENTER_MIN_Y, CENTER_SAMPLES, CENTER_SCALE, MIN_SHARE, laneCenter, type StreamSet, type StreamSlot } from "./streams";

/**
 * Floats per slot of `instances`, in attribute order. `step` rewrites the first six: tail x, tail y,
 * head x, head y, hue (turns), intensity. `spawn` writes the last two: stream slot index and size
 * jitter (half-width in `LOOK.sizePx`). A dead slot keeps intensity 0, which the vertex shader clips.
 */
export const INSTANCE_FLOATS = 8;

/**
 * Fixed-size particle pool simulated on the CPU. Particles keep their slot for life, so `instances`
 * is indexed by slot, and the renderer uploads its first `drawCount` slots every frame in one call.
 */
export class ParticleSystem {
  readonly instances: Float32Array;
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
  /**
   * One bit per slot, set while free. Births take the lowest free slot, so live particles gather at the
   * bottom of the pool and, after `limit` drops, `drawCount` falls to it within one lifetime, as the
   * GPU's active horizon does. A stack of freed slots kept reusing high ones, so `drawCount`, and with it
   * every step, upload and draw, stayed near its peak.
   */
  private readonly freeBits: Uint32Array;
  /** No free slot lies in a word below this one. */
  private lowWord = 0;
  private live = 0;
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
    this.freeBits = new Uint32Array(Math.ceil(capacity / 32));
    this.freeBits.fill(0xffffffff);
    // Slots past the capacity in the last word are never free.
    if (capacity % 32) this.freeBits[this.freeBits.length - 1] = (1 << (capacity % 32)) - 1;
    this.limit = capacity;
  }

  get count(): number {
    return this.live;
  }

  /**
   * Rebuilds `drawCount`, the free slots and live count, each live slot's stream index and size and
   * dead slots' intensity from the particle state. For test fixtures that write the state directly.
   */
  resync(): void {
    this.drawCount = 0;
    this.live = 0;
    this.lowWord = 0;
    this.freeBits.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      const o = i * INSTANCE_FLOATS;
      if (!this.active[i]) this.freeBits[i >>> 5] |= 1 << (i & 31);
      else this.live++;
      if (this.active[i]) {
        this.instances[o + 6] = this.slot[i];
        this.instances[o + 7] = this.size[i];
        this.drawCount = i + 1;
      } else this.instances[o + 5] = 0;
    }
  }

  /** Spawns along the bottom edge; rates are normalized so `limit` particles turn over every `turnoverSeconds`. */
  spawn(dt: number, streams: StreamSet): void {
    let share = 0;
    for (const s of streams.slots) if (s.used) share += s.shareWeight;
    if (share <= 0) return;

    // Never below one full stream's share: otherwise the last streams fading out would keep the
    // whole pool between them, and the river would never drain.
    const baseRate = this.limit / LOOK.turnoverSeconds / Math.max(share, MIN_SHARE);
    for (let slotIndex = 0; slotIndex < streams.slots.length; slotIndex++) {
      const s = streams.slots[slotIndex];
      if (!s.used) continue;
      s.spawnCarry += baseRate * s.spawnWeight * dt;
      const n = Math.floor(s.spawnCarry);
      s.spawnCarry -= n;
      for (let k = 0; k < n && this.live < this.limit; k++) this.birth(this.takeLowestFree(), slotIndex, s);
    }
  }

  /** Claims the lowest free slot. Only called while `live < limit <= capacity`, so one exists. */
  private takeLowestFree(): number {
    const bits = this.freeBits;
    let w = this.lowWord;
    while (bits[w] === 0) w++;
    const word = bits[w];
    // The lowest set bit, and its index from the count of zeros above it.
    const bit = 31 - Math.clz32(word & -word);
    bits[w] = word & (word - 1);
    this.lowWord = w;
    this.live++;
    return w * 32 + bit;
  }

  /** Starts a particle in free pool slot `i` for stream slot `slotIndex` and writes its spawn-time floats. */
  private birth(i: number, slotIndex: number, s: StreamSlot): void {
    const { random } = this;
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
    const o = i * INSTANCE_FLOATS;
    this.instances[o + 6] = slotIndex;
    this.instances[o + 7] = this.size[i];
    if (i >= this.drawCount) this.drawCount = i + 1;
  }

  /** Advances every particle and rewrites the dynamic floats of its slot of `instances`; returns the live count. */
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
    const freeBits = this.freeBits;
    let highest = -1, lowWord = this.lowWord, died = 0;

    for (let i = 0; i < end; i++) {
      if (!this.active[i]) continue;
      const slotIndex = this.slot[i];
      const s = slots[slotIndex];
      age[i] += dt;
      if (age[i] > life[i] || y[i] > 1.08 || x[i] < -0.1 || x[i] > aspect + 0.1) {
        this.active[i] = 0;
        // Back to the free set, inline: with a method call here Firefox ran dense pools about 5 % slower
        // (2026-11-28 X280 tie-break), as Task 3 found for the centre lookup.
        const w = i >>> 5;
        freeBits[w] |= 1 << (i & 31);
        if (w < lowWord) lowWord = w;
        died++;
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
    this.lowWord = lowWord;
    this.live -= died;
    // Slots above the highest survivor are all dead now: stop drawing them.
    this.drawCount = highest + 1;
    return this.count;
  }
}
