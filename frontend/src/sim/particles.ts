import { LOOK } from "../config";
import { clamp, fract, gaussian, lerp, type Random } from "../util/math";
import type { FlowField } from "./noise";
import type { StreamSet } from "./streams";

/**
 * Per-instance floats written by `step`, in attribute order:
 * tail x, tail y, head x, head y, hue (turns), chroma, lightness, intensity, half-width (device px).
 */
export const INSTANCE_FLOATS = 9;

/** Fixed-size particle pool simulated on the CPU. */
export class ParticleSystem {
  readonly instances: Float32Array;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly hueJitter: Float32Array;
  private readonly size: Float32Array;
  private readonly speedJitter: Float32Array;
  private readonly slot: Uint8Array;
  private readonly active: Uint8Array;
  private readonly free: Int32Array;
  private freeTop: number;
  private globalHue = 0;

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
    this.slot = new Uint8Array(capacity);
    this.active = new Uint8Array(capacity);
    this.free = Int32Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
    this.freeTop = capacity;
  }

  get count(): number {
    return this.capacity - this.freeTop;
  }

  /** Spawns along the bottom edge; rates are normalized so the pool turns over every `turnoverSeconds`. */
  spawn(dt: number, t: number, streams: StreamSet): void {
    let share = 0;
    for (const s of streams.slots) if (s.used) share += s.shareWeight;
    if (share <= 0) return;

    const { random } = this;
    const baseRate = this.capacity / LOOK.turnoverSeconds / share;
    streams.slots.forEach((s, slotIndex) => {
      if (!s.used) return;
      s.spawnCarry += baseRate * s.spawnWeight * dt;
      const n = Math.floor(s.spawnCarry);
      s.spawnCarry -= n;
      for (let k = 0; k < n && this.freeTop > 0; k++) {
        const i = this.free[--this.freeTop];
        this.active[i] = 1;
        this.slot[i] = slotIndex;
        this.x[i] = s.centerAt(0, t) + gaussian(random) * s.half * LOOK.spawnSpread;
        this.y[i] = -0.02 * random();
        this.vx[i] = 0;
        this.vy[i] = s.speed;
        this.age[i] = 0;
        this.life[i] = lerp(LOOK.lifeRange[0], LOOK.lifeRange[1], random());
        this.hueJitter[i] = (random() - 0.5) * 2 * LOOK.hueJitter;
        this.size[i] = lerp(LOOK.sizeJitter[0], LOOK.sizeJitter[1], random());
        this.speedJitter[i] = lerp(LOOK.speedJitter[0], LOOK.speedJitter[1], random());
        s.particles++;
      }
    });
  }

  /** Advances every particle and writes the live ones to `instances`; returns the instance count. */
  step(dt: number, t: number, streams: StreamSet, field: FlowField, aspect: number, devicePixelRatio: number): number {
    const { x, y, vx, vy, age, life, instances } = this;
    const slots = streams.slots;
    const k = 1 - Math.exp(-dt / LOOK.inertia);
    const sizeScale = LOOK.sizePx * devicePixelRatio;
    this.globalHue = fract(this.globalHue + LOOK.hueRotate * dt);
    let n = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;
      const s = slots[this.slot[i]];
      age[i] += dt;
      if (age[i] > life[i] || y[i] > 1.08 || x[i] < -0.1 || x[i] > aspect + 0.1) {
        this.active[i] = 0;
        this.free[this.freeTop++] = i;
        s.particles--;
        continue;
      }

      // Upward speed from the stream, sideways from curl noise plus a pull to the centre line.
      // The heading stays within ±maxSlope of vertical: data changes speed and wiggle, not direction.
      field.sample(x[i], y[i]);
      const up = s.speed * this.speedJitter[i];
      const limit = LOOK.maxSlope * up;
      const side = clamp(field.sx * s.turbulenceAmp * up + (s.centerAt(y[i], t) - x[i]) * LOOK.steer, -limit, limit);
      vx[i] += (side - vx[i]) * k;
      vy[i] += (up * (1 + 0.3 * field.sy * s.turbulenceAmp) - vy[i]) * k;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;

      const fade = Math.min(age[i] / LOOK.fadeIn, (life[i] - age[i]) / LOOK.fadeOut, 1);
      const o = n * INSTANCE_FLOATS;
      instances[o] = x[i] - vx[i] * s.streakSeconds;
      instances[o + 1] = y[i] - vy[i] * s.streakSeconds;
      instances[o + 2] = x[i];
      instances[o + 3] = y[i];
      instances[o + 4] = fract(this.globalHue + y[i] * LOOK.hueGradient + s.hueOffset + this.hueJitter[i]);
      instances[o + 5] = s.chroma;
      instances[o + 6] = LOOK.lightness;
      instances[o + 7] = LOOK.intensity * fade * s.brightness;
      instances[o + 8] = this.size[i] * sizeScale;
      n++;
    }
    return n;
  }
}
