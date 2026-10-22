import type { Frame, Stream } from "@beszel-river/shared";
import { LOOK } from "../config";
import { ease, fract, hashString, lerp } from "../util/math";

/** Slot count; particles store their slot index in a byte. Extra streams are ignored. */
export const MAX_STREAMS = 32;
/** Filament count in the message format. */
export const FILAMENTS = 6;

/** Centre of filament lane `j`, in band half-widths from the centre line. */
export function laneCenter(j: number): number {
  return (((j + 0.5) / FILAMENTS) * 2 - 1) * LOOK.filamentSpan;
}

/** One stream's eased state, layout and the motion parameters derived from them. */
export class StreamSlot {
  used = false;
  id = "";
  /** Present in the latest frame; otherwise the stream is draining. */
  inFrame = false;
  order = 0;
  latest: Stream | null = null;

  // Eased channels.
  width = 0;
  flow = 0;
  density = 0;
  turbulence = 0;
  pulse = 0;
  heat = 0;
  /** 1 while the host reports, eases to 0 when it stops. */
  vitality = 0;
  /** 1 while in the frame, eases to 0 after removal. */
  presence = 0;
  /** Eased per-lane activity. */
  readonly filaments = new Float32Array(FILAMENTS);
  /** Share of spawns that follow the lanes: 1 with filaments, easing to 0 without. */
  filamentMix = 0;
  /** Cumulative spawn weight per lane, for `pickLane`. */
  readonly laneWeights = new Float32Array(FILAMENTS);

  // Layout, world units.
  center = 0;
  half = 0;
  centerTarget = 0;
  halfTarget = 0;
  snapLayout = false;

  hueOffset = 0;
  phase = 0;
  particles = 0;
  spawnCarry = 0;

  // Derived in `StreamSet.update`.
  speed = 0;
  turbulenceAmp = 0;
  /** Relative spawn rate; `shareWeight` is the same without the channel factors, used to normalize. */
  spawnWeight = 0;
  shareWeight = 0;
  brightness = 0;
  chroma = 0;
  streakSeconds = 0;

  /** Lane index for a uniform random number `u` in [0, 1), weighted by lane activity. */
  pickLane(u: number): number {
    const target = u * this.laneWeights[FILAMENTS - 1];
    for (let j = 0; j < FILAMENTS - 1; j++) if (target < this.laneWeights[j]) return j;
    return FILAMENTS - 1;
  }

  /** Centre line of the band at height `y`; it swings sideways so neighbouring streams braid. */
  centerAt(y: number, t: number): number {
    return this.center + this.half * LOOK.braid * Math.sin(2 * Math.PI * (y * LOOK.braidWaves + this.phase) + t * LOOK.braidSpeed);
  }
}

export class StreamSet {
  readonly slots: StreamSlot[] = Array.from({ length: MAX_STREAMS }, () => new StreamSlot());
  private readonly byId = new Map<string, StreamSlot>();
  private started = false;

  constructor(private readonly motion: number) {}

  apply(frame: Frame): void {
    for (const slot of this.slots) slot.inFrame = false;
    frame.streams.forEach((stream, order) => {
      let slot = this.byId.get(stream.id);
      if (!slot) {
        slot = this.slots.find((s) => !s.used);
        if (!slot) return;
        this.claim(slot, stream);
      }
      slot.inFrame = true;
      slot.order = order;
      slot.latest = stream;
    });
    this.started = true;
  }

  update(dt: number, aspect: number): void {
    this.layout(aspect);
    const { tau } = LOOK;
    for (const slot of this.slots) {
      if (!slot.used || !slot.latest) continue;
      const s = slot.latest;

      slot.width = ease(slot.width, s.width, tau.width, dt);
      slot.flow = ease(slot.flow, s.flow, tau.flow, dt);
      slot.density = ease(slot.density, s.density, tau.density, dt);
      slot.turbulence = ease(slot.turbulence, s.turbulence, tau.turbulence, dt);
      slot.heat = ease(slot.heat, s.heat, tau.heat, dt);
      slot.pulse = ease(slot.pulse, s.pulse, s.pulse > slot.pulse ? tau.pulseRise : tau.pulseFall, dt);
      slot.vitality = ease(slot.vitality, s.alive ? 1 : 0, tau.vitality, dt);
      slot.presence = ease(slot.presence, slot.inFrame ? 1 : 0, tau.presence, dt);
      const filaments = s.filaments;
      slot.filamentMix = ease(slot.filamentMix, filaments ? 1 : 0, tau.filamentMix, dt);
      // Lanes near the edges get less, so the spawn profile keeps the band's soft shape.
      let laneTotal = 0;
      for (let j = 0; j < FILAMENTS; j++) {
        if (filaments) slot.filaments[j] = ease(slot.filaments[j], filaments[j], tau.filaments, dt);
        const c = laneCenter(j) / LOOK.spawnSpread;
        laneTotal += Math.exp(-0.5 * c * c) * (LOOK.filamentFloor + slot.filaments[j]);
        slot.laneWeights[j] = laneTotal;
      }
      if (slot.snapLayout) {
        slot.center = slot.centerTarget;
        slot.half = slot.halfTarget;
        slot.snapLayout = false;
      } else {
        slot.center = ease(slot.center, slot.centerTarget, tau.layout, dt);
        slot.half = ease(slot.half, slot.halfTarget, tau.layout, dt);
      }
      slot.hueOffset = fract(slot.hueOffset + (slot.heat - 0.5) * 2 * LOOK.hueDriftMax * dt);

      const v = slot.vitality;
      slot.speed = LOOK.baseSpeed * lerp(LOOK.speedRange[0], LOOK.speedRange[1], slot.flow) * lerp(0.5, 1, v) * this.motion;
      slot.turbulenceAmp = lerp(LOOK.turbulenceRange[0], LOOK.turbulenceRange[1], slot.turbulence) * this.motion;
      slot.shareWeight = (0.6 + 0.8 * slot.width) * slot.presence;
      slot.spawnWeight = slot.shareWeight * lerp(0.25, 1, slot.density) * (1 + 2 * slot.pulse) * lerp(0.2, 1, v);
      slot.brightness = (1 + 1.2 * slot.pulse) * lerp(0.3, 1, v) * lerp(0.3, 1, slot.presence);
      slot.chroma = LOOK.chroma * lerp(0.1, 1, v);
      slot.streakSeconds = lerp(LOOK.streakRange[0], LOOK.streakRange[1], slot.flow);

      if (!slot.inFrame && slot.presence < 0.01 && slot.particles === 0) this.release(slot);
    }
  }

  private claim(slot: StreamSlot, stream: Stream): void {
    slot.used = true;
    slot.id = stream.id;
    this.byId.set(stream.id, slot);
    slot.width = stream.width;
    slot.flow = stream.flow;
    slot.density = stream.density;
    slot.turbulence = stream.turbulence;
    slot.heat = stream.heat;
    slot.pulse = stream.pulse;
    slot.vitality = stream.alive ? 1 : 0;
    slot.filaments.fill(0);
    if (stream.filaments) slot.filaments.set(stream.filaments);
    slot.filamentMix = stream.filaments ? 1 : 0;
    // Streams in the first frame appear at once; later ones fade in.
    slot.presence = this.started ? 0 : 1;
    slot.snapLayout = true;
    slot.hueOffset = hashString(stream.id);
    slot.phase = hashString(`${stream.id}:phase`);
    slot.particles = 0;
    slot.spawnCarry = 0;
  }

  private release(slot: StreamSlot): void {
    this.byId.delete(slot.id);
    slot.used = false;
    slot.latest = null;
  }

  /** Bands in frame order, widths proportional to `width`; draining streams keep their last place. */
  private layout(aspect: number): void {
    const active = this.slots.filter((s) => s.used && s.inFrame && s.latest).sort((a, b) => a.order - b.order);
    const weights = active.map((s) => 0.6 + 0.8 * (s.latest?.width ?? 0));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const span = aspect * (1 - 2 * LOOK.bandMargin);
    let cumulative = 0;
    active.forEach((slot, i) => {
      const w = weights[i];
      slot.centerTarget = aspect * LOOK.bandMargin + ((cumulative + w / 2) / total) * span;
      slot.halfTarget = ((w / total) * span) / 2;
      cumulative += w;
    });
  }
}
