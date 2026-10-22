import { readFileSync } from "node:fs";
import { clamp01, FEATURES, type Feature, type Features } from "./features.js";

/** Channels the mixer produces; `width` and `alive` come from the host table instead. */
export const MIXED = ["flow", "density", "turbulence", "pulse", "heat"] as const;
export type Mixed = (typeof MIXED)[number];

/**
 * channel = clamp01(bias + Σ weight × (feature − center)), then smoothed with time constant `tau`
 * seconds (0 = none). `pulse` is not smoothed: it jumps to each new value and decays between samples.
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
 * How the pulse from a minute record is spread out, so hosts do not all flash at the top of the minute
 * and the river keeps pulsing between records. The first pulse fires at full strength within
 * `FIRST_PULSE_JITTER_S`; then a Poisson-distributed number of weaker ones (mean `rate` × pulse, at most
 * `max`) at random times over the next `window` seconds. Realtime samples pulse at once instead.
 */
export interface PulseScatter {
  rate: number;
  max: number;
  window: number;
}

/** Used when `mix.json` has no `pulseScatter` entry: one to three pulses per record. */
export const DEFAULT_PULSE_SCATTER: PulseScatter = { rate: 2, max: 2, window: 50 };

export interface MixConfig {
  channels: Record<Mixed, Recipe>;
  filaments: FilamentRecipe;
  pulseScatter: PulseScatter;
  /** Pulse decay time constant, seconds. */
  pulseDecay: number;
}

/** Spread of the first scattered pulse, seconds: short enough to stay within the update, long enough to spread hosts over two or three 2 s ticks. */
const FIRST_PULSE_JITTER_S = 5;
/** Strength of the later scattered pulses, as a fraction of the first. */
const LATER_PULSE = [0.4, 0.8] as const;
/** Pulse values below this are not visible. */
const VISIBLE = 0.005;

export function parseMixConfig(json: unknown): MixConfig {
  const fail = (message: string): never => {
    throw new Error(`Invalid mix config: ${message}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const number = (v: unknown, path: string, fallback?: number): number => {
    if (v === undefined && fallback !== undefined) return fallback;
    return typeof v === "number" && Number.isFinite(v) ? v : fail(`${path} must be a number`);
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
  let filaments = DEFAULT_FILAMENTS;
  if (json.filaments !== undefined) {
    const raw = json.filaments;
    if (!isObject(raw)) return fail("filaments must be an object");
    filaments = {
      bias: number(raw.bias, "filaments.bias", DEFAULT_FILAMENTS.bias),
      center: number(raw.center, "filaments.center", DEFAULT_FILAMENTS.center),
      weight: number(raw.weight, "filaments.weight", DEFAULT_FILAMENTS.weight),
      tau: number(raw.tau, "filaments.tau", DEFAULT_FILAMENTS.tau),
    };
    if (filaments.tau < 0) fail("filaments.tau must be >= 0");
  }
  let pulseScatter = DEFAULT_PULSE_SCATTER;
  if (json.pulseScatter !== undefined) {
    const raw = json.pulseScatter;
    if (!isObject(raw)) return fail("pulseScatter must be an object");
    pulseScatter = {
      rate: number(raw.rate, "pulseScatter.rate", DEFAULT_PULSE_SCATTER.rate),
      max: number(raw.max, "pulseScatter.max", DEFAULT_PULSE_SCATTER.max),
      window: number(raw.window, "pulseScatter.window", DEFAULT_PULSE_SCATTER.window),
    };
    if (pulseScatter.rate < 0) fail("pulseScatter.rate must be >= 0");
    if (!Number.isInteger(pulseScatter.max) || pulseScatter.max < 0) fail("pulseScatter.max must be a whole number >= 0");
    if (pulseScatter.window <= 0) fail("pulseScatter.window must be > 0");
  }
  const pulseDecay = number(json.pulseDecay, "pulseDecay");
  if (pulseDecay <= 0) fail("pulseDecay must be > 0");
  return { channels, filaments, pulseScatter, pulseDecay };
}

export function loadMixConfig(path: string): MixConfig {
  return parseMixConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** Per-host channel state. */
export class Mixer {
  readonly values: Record<Mixed, number> = { flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 };
  /** Mixed per-core profile; null while the host reports no per-core usage. */
  filaments: number[] | null = null;
  private primed = false;
  /** Scattered pulses still to fire; `at` is a time in ms. */
  private readonly pending: { at: number; value: number }[] = [];

  constructor(
    private readonly config: MixConfig,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Mixes new features in; `dt` is the time since the previous sample, seconds. With `scatterAt`
   * (the current time, ms) the pulse is spread out as `PulseScatter` describes; without it, it rises at
   * once. Either way, pulses still pending from the previous sample are dropped.
   */
  apply(features: Features, dt: number, scatterAt?: number): void {
    for (const channel of MIXED) {
      const recipe = this.config.channels[channel];
      let raw = recipe.bias;
      for (const [feature, weight] of Object.entries(recipe.inputs) as [Feature, number][]) {
        raw += weight * (features[feature] - recipe.center);
      }
      raw = clamp01(raw);

      const current = this.values[channel];
      if (channel === "pulse") this.pulse(raw, scatterAt);
      else if (!this.primed || recipe.tau === 0) this.values[channel] = raw;
      else this.values[channel] = current + (raw - current) * (1 - Math.exp(-Math.max(dt, 0) / recipe.tau));
    }
    this.primed = true;
  }

  /** Mixes a new per-core profile (`coreProfile`) in; null drops the filaments. */
  applyFilaments(profile: readonly number[] | null, dt: number): void {
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

  /** Lets `pulse` fade and fires the scattered pulses due by `now` (ms); returns whether it changed visibly. */
  decay(dt: number, now = Date.now()): boolean {
    const before = this.values.pulse;
    let after = before * Math.exp(-dt / this.config.pulseDecay);
    if (after < VISIBLE) after = 0;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > now) continue;
      after = Math.max(after, this.pending[i].value);
      this.pending.splice(i, 1);
    }
    this.values.pulse = after;
    return Math.abs(before - after) >= VISIBLE;
  }

  private pulse(strength: number, scatterAt: number | undefined): void {
    this.pending.length = 0;
    if (scatterAt === undefined) {
      this.values.pulse = Math.max(this.values.pulse, strength);
      return;
    }
    if (strength < VISIBLE) return;
    const { rate, max, window } = this.config.pulseScatter;
    this.pending.push({ at: scatterAt + this.random() * FIRST_PULSE_JITTER_S * 1000, value: strength });
    const later = poisson(rate * strength, max, this.random);
    for (let i = 0; i < later; i++) {
      const at = scatterAt + this.random() * window * 1000;
      this.pending.push({ at, value: strength * (LATER_PULSE[0] + (LATER_PULSE[1] - LATER_PULSE[0]) * this.random()) });
    }
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
