import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { clamp01, FEATURES, type Feature, type Features } from "./features.js";

/** Channels the mixer produces; `width` and `alive` come from the host table instead. */
export const MIXED = ["flow", "density", "turbulence", "pulse", "heat"] as const;
export type Mixed = (typeof MIXED)[number];

/**
 * channel = clamp01(bias + Σ weight × (feature − center)), then smoothed with time constant `tau`
 * seconds (0 = none). `pulse` is not smoothed: it rises to each sample's value (at once or scattered,
 * see `SampleKind`) and decays between samples.
 */
export interface Recipe {
  bias: number;
  center: number;
  tau: number;
  inputs: Partial<Record<Feature, number>>;
}

/**
 * filament = clamp01(bias + weight × (core − center)), smoothed with time constant `tau` seconds, where
 * `core` is one value of the resampled per-core profile (0..1).
 */
export interface FilamentRecipe {
  bias: number;
  center: number;
  weight: number;
  tau: number;
}

/** Used when `mix.json` has no `filaments` entry (files from before M6). */
export const DEFAULT_FILAMENTS: FilamentRecipe = { bias: 0, center: 0, weight: 1, tau: 3 };

/**
 * How the pulse p of a minute record is spread out, so hosts do not all flash at the top of the minute
 * and the river keeps pulsing between records. The first pulse fires at full strength within `jitter`
 * seconds (0 = at once). Then a Poisson-distributed number of weaker ones (mean `rate` × p, at most `max`,
 * 0.4–0.8 × p) at random times within `window` seconds of the first, each at least `pulseDecay` + `TICK_S`
 * after the one before, so that one has faded below the weakest later pulse.
 */
export interface PulseScatter {
  jitter: number;
  rate: number;
  max: number;
  window: number;
}

/** Used for what `mix.json` leaves out of `pulseScatter`: one to three pulses per record. */
export const DEFAULT_PULSE_SCATTER: PulseScatter = { jitter: 5, rate: 2, max: 2, window: 50 };

/** Used when `mix.json` has no `glide`: the time to the next minute record. */
export const DEFAULT_GLIDE = 60;

export interface MixConfig {
  channels: Record<Mixed, Recipe>;
  filaments: FilamentRecipe;
  pulseScatter: PulseScatter;
  /** Pulse decay time constant, seconds. */
  pulseDecay: number;
  /** A minute record's other channels and filaments move to their new values over this long, seconds; 0 = at once. */
  glide: number;
}

/**
 * How `Mixer.apply` brings a sample in:
 * - `realtime`: 1 s data; channels and pulse change at once.
 * - `minute`: a live minute record; channels glide over `glide` and the pulse is scattered
 *   (`PulseScatter`), so hosts that all report in the same second or two do not all change together.
 * - `seed`: a record replayed at startup or an `info` summary; channels change at once and the pulse is
 *   left out, since it is old news.
 */
export type SampleKind = "realtime" | "minute" | "seed";

/** Interval of `Mixer.tick`, seconds. */
export const TICK_S = 2;
/**
 * Latest a scattered pulse may be due after its record, seconds: the tick fires it up to `TICK_S` late,
 * and the next record, about 60 s after this one, drops what is still pending.
 */
const SCATTER_SPAN_S = 55;
/** Strength of the later scattered pulses, as a fraction of the first. */
const LATER_PULSE = [0.4, 0.8] as const;
/** Pulse values below this are not visible. */
const VISIBLE = 0.005;
/** Smallest glide move per tick worth a frame: half the frames' resolution of three decimals. */
const GLIDE_STEP = 0.0005;

interface Pulse {
  /** Due time, ms. */
  at: number;
  value: number;
}

interface Glide {
  /** Start and end, ms. */
  start: number;
  end: number;
  from: Record<Mixed, number>;
  to: Record<Mixed, number>;
  /** Null when the filaments switch at once, because the record started or stopped them. */
  filaments: { from: number[]; to: number[] } | null;
}

export function parseMixConfig(json: unknown): MixConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid mix config: ${message}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const number = (v: unknown, path: string, fallback?: number): number => {
    if (v === undefined && fallback !== undefined) return fallback;
    return typeof v === "number" && Number.isFinite(v) ? v : fail(`${path} must be a number`);
  };
  /** An optional entry of numbers; it and each of its fields default to `defaults`. */
  const section = <T extends object>(raw: unknown, name: string, defaults: T): T => {
    if (raw === undefined) return defaults;
    if (!isObject(raw)) return fail(`${name} must be an object`);
    const result = {} as T;
    for (const field in defaults) {
      if (Object.prototype.hasOwnProperty.call(defaults, field)) {
        result[field] = number(raw[field], `${name}.${field}`, defaults[field] as number) as any;
      }
    }
    return result;
  };

  if (!isObject(json)) return fail("expected an object");
  const channels = {} as Record<Mixed, Recipe>;
  for (const channel of MIXED) {
    const raw = json[channel];
    if (!isObject(raw)) return fail(`"${channel}" is missing`);
    if (!isObject(raw.inputs)) return fail(`${channel}.inputs must be an object`);
    const inputs: Partial<Record<Feature, number>> = {};
    for (const [feature, weight] of Object.entries(raw.inputs)) {
      if (!(FEATURES as readonly string[]).includes(feature)) fail(`${channel}.inputs.${feature} is not a feature (${FEATURES.join(", ")})`);
      inputs[feature as Feature] = number(weight, `${channel}.inputs.${feature}`);
    }
    const tau = number(raw.tau, `${channel}.tau`, 0);
    if (tau < 0) fail(`${channel}.tau must be >= 0`);
    channels[channel] = { bias: number(raw.bias, `${channel}.bias`, 0), center: number(raw.center, `${channel}.center`, 0), tau, inputs };
  }
  const pulseDecay = number(json.pulseDecay, "pulseDecay");
  if (pulseDecay <= 0) fail("pulseDecay must be > 0");
  const filaments = section(json.filaments, "filaments", DEFAULT_FILAMENTS);
  if (filaments.tau < 0) fail("filaments.tau must be >= 0");
  const pulseScatter = section(json.pulseScatter, "pulseScatter", DEFAULT_PULSE_SCATTER);
  const { jitter, rate, max, window } = pulseScatter;
  if (jitter < 0) fail("pulseScatter.jitter must be >= 0");
  if (rate < 0) fail("pulseScatter.rate must be >= 0");
  if (!Number.isInteger(max) || max < 0) fail("pulseScatter.max must be a whole number >= 0");
  const room = max * (pulseDecay + TICK_S);
  if (window < room) fail(`pulseScatter.window must be >= max × (pulseDecay + ${TICK_S}) = ${room}, the room the later pulses need`);
  if (jitter + window > SCATTER_SPAN_S) fail(`pulseScatter.jitter + pulseScatter.window must be <= ${SCATTER_SPAN_S}, so every pulse fires before the next record`);
  const glide = number(json.glide, "glide", DEFAULT_GLIDE);
  if (glide < 0) fail("glide must be >= 0");
  return { channels, filaments, pulseScatter, pulseDecay, glide };
}

export function loadMixConfig(path: string): MixConfig {
  return parseMixConfig(JSON.parse(readFileSync(path, "utf8")));
}


function secureRandom(): number {
  const array = new Uint32Array(1);
  webcrypto.getRandomValues(array);
  return array[0] / 4294967296;
}

/** Per-host channel state. */
export class Mixer {
  readonly values: Record<Mixed, number> = { flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 };
  /** Mixed per-core profile; null while the host reports no per-core usage. */
  filaments: number[] | null = null;
  private primed = false;
  /** The record's own pulse while it waits for its time. */
  private firstPulse: Pulse | null = null;
  /** Weaker scattered pulses still to fire, in time order. */
  private readonly laterPulses: Pulse[] = [];
  private glide: Glide | null = null;

  constructor(
    private readonly config: MixConfig,
    private readonly random: () => number = secureRandom,
  ) {}

  /**
   * Mixes in new features and a per-core profile (`coreProfile`; null drops the filaments). `dt` is the
   * time since the previous sample, seconds; `now` the current time, ms. Pulses still pending from the
   * previous sample are dropped, except its first one, which rises at once if it has not yet.
   */
  apply(features: Features, profile: readonly number[] | null, dt: number, kind: SampleKind, now: number): void {
    // The new sample continues from wherever the river is now.
    this.glideTo(now);
    this.glide = null;
    const from = { ...this.values };
    const fromFilaments = this.filaments;

    for (const channel of MIXED) {
      const recipe = this.config.channels[channel];
      let raw = recipe.bias;
      for (const [feature, weight] of Object.entries(recipe.inputs) as [Feature, number][]) {
        raw += weight * (features[feature] - recipe.center);
      }
      raw = clamp01(raw);

      const current = this.values[channel];
      if (channel === "pulse") this.pulse(raw, kind, now);
      else if (!this.primed || recipe.tau === 0) this.values[channel] = raw;
      else this.values[channel] = current + (raw - current) * (1 - Math.exp(-Math.max(dt, 0) / recipe.tau));
    }
    this.applyFilaments(profile, dt);

    if (kind === "minute" && this.primed && this.config.glide > 0) {
      const to = { ...this.values };
      // `to` is a copy, since gliding writes to `this.filaments` in place.
      const filaments = fromFilaments && this.filaments?.length === fromFilaments.length ? { from: fromFilaments, to: [...this.filaments] } : null;
      this.glide = { start: now, end: now + this.config.glide * 1000, from, to, filaments };
      this.glideTo(now);
    }
    this.primed = true;
  }

  /**
   * Advances to `now` (ms), `dt` seconds after the previous tick: lets `pulse` fade, fires the scattered
   * pulses that are due and moves gliding channels on. Returns whether anything changed visibly.
   */
  tick(dt: number, now: number): boolean {
    const before = this.values.pulse;
    let after = before * Math.exp(-dt / this.config.pulseDecay);
    if (after < VISIBLE) after = 0;
    if (this.firstPulse && this.firstPulse.at <= now) {
      after = Math.max(after, this.firstPulse.value);
      this.firstPulse = null;
    }
    while (this.laterPulses.length > 0 && this.laterPulses[0].at <= now) {
      after = Math.max(after, this.laterPulses[0].value);
      this.laterPulses.shift();
    }
    this.values.pulse = after;
    const glided = this.glideTo(now) >= GLIDE_STEP;
    return Math.abs(before - after) >= VISIBLE || glided;
  }

  /** Drops the scattered pulses still to fire, for a host that stopped reporting. */
  dropPulses(): void {
    this.firstPulse = null;
    this.laterPulses.length = 0;
  }

  private applyFilaments(profile: readonly number[] | null, dt: number): void {
    if (!profile) {
      this.filaments = null;
      return;
    }
    const { bias, center, weight, tau } = this.config.filaments;
    const previous = this.filaments?.length === profile.length ? this.filaments : null;
    const k = previous && tau > 0 ? 1 - Math.exp(-Math.max(dt, 0) / tau) : 1;
    this.filaments = profile.map((core, i) => {
      const raw = clamp01(bias + weight * (core - center));
      return previous ? previous[i] + (raw - previous[i]) * k : raw;
    });
  }

  /** Moves gliding channels and filaments to where they are at `now` (ms); returns the largest move. */
  private glideTo(now: number): number {
    const glide = this.glide;
    if (!glide) return 0;
    const f = Math.min(1, Math.max(0, (now - glide.start) / (glide.end - glide.start)));
    let moved = 0;
    for (const channel of MIXED) {
      if (channel === "pulse") continue;
      const value = glide.from[channel] + (glide.to[channel] - glide.from[channel]) * f;
      moved = Math.max(moved, Math.abs(value - this.values[channel]));
      this.values[channel] = value;
    }
    const filaments = glide.filaments;
    if (filaments && this.filaments) {
      for (let i = 0; i < this.filaments.length; i++) {
        const value = filaments.from[i] + (filaments.to[i] - filaments.from[i]) * f;
        moved = Math.max(moved, Math.abs(value - this.filaments[i]));
        this.filaments[i] = value;
      }
    }
    if (f === 1) this.glide = null;
    return moved;
  }

  private pulse(strength: number, kind: SampleKind, now: number): void {
    // The record's own strength is real data: a sample that arrives before it fires brings it forward.
    if (this.firstPulse) this.values.pulse = Math.max(this.values.pulse, this.firstPulse.value);
    this.dropPulses();
    if (kind === "seed") return;
    if (kind === "realtime") {
      this.values.pulse = Math.max(this.values.pulse, strength);
      return;
    }
    if (strength < VISIBLE) return;
    const { jitter, rate, max, window } = this.config.pulseScatter;
    const first = now + this.random() * jitter * 1000;
    if (first <= now) this.values.pulse = Math.max(this.values.pulse, strength);
    else this.firstPulse = { at: first, value: strength };

    if (strength * LATER_PULSE[0] < VISIBLE) return;
    const count = poisson(rate * strength, max, this.random);
    // Uniform times in what the gaps leave of the window, sorted, then pushed apart by one gap each.
    const gap = (this.config.pulseDecay + TICK_S) * 1000;
    const slack = window * 1000 - count * gap;
    const offsets = Array.from({ length: count }, () => this.random() * slack).sort((a, b) => a - b);
    offsets.forEach((offset, i) => {
      const value = strength * (LATER_PULSE[0] + (LATER_PULSE[1] - LATER_PULSE[0]) * this.random());
      this.laterPulses.push({ at: first + offset + (i + 1) * gap, value });
    });
  }
}

/** Poisson-distributed count with the given mean, capped at `max` (Knuth's method; the means here are small). */
function poisson(mean: number, max: number, random: () => number): number {
  const limit = Math.exp(-mean);
  let count = 0;
  for (let p = 1; count < max; count++) {
    p *= random();
    if (p <= limit) break;
  }
  return count;
}
