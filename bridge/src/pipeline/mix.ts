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

export interface MixConfig {
  channels: Record<Mixed, Recipe>;
  filaments: FilamentRecipe;
  /** Pulse decay time constant, seconds. */
  pulseDecay: number;
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
  const pulseDecay = number(json.pulseDecay, "pulseDecay");
  if (pulseDecay <= 0) fail("pulseDecay must be > 0");
  return { channels, filaments, pulseDecay };
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

  constructor(private readonly config: MixConfig) {}

  /** Mixes new features in; `dt` is the time since the previous sample, seconds. */
  apply(features: Features, dt: number): void {
    for (const channel of MIXED) {
      const recipe = this.config.channels[channel];
      let raw = recipe.bias;
      for (const [feature, weight] of Object.entries(recipe.inputs) as [Feature, number][]) {
        raw += weight * (features[feature] - recipe.center);
      }
      raw = clamp01(raw);

      const current = this.values[channel];
      if (channel === "pulse") this.values.pulse = Math.max(current, raw);
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

  /** Lets `pulse` fade between samples; returns whether it changed visibly. */
  decay(dt: number): boolean {
    const before = this.values.pulse;
    const after = before * Math.exp(-dt / this.config.pulseDecay);
    this.values.pulse = after < 0.005 ? 0 : after;
    return Math.abs(before - this.values.pulse) >= 0.005;
  }
}
