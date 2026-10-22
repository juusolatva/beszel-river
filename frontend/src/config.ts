// World units: the canvas is 1 unit tall and `aspect` units wide, y pointing up.

/** Tunables for the look. */
export const LOOK = {
  /** Upward speed at speed multiplier 1, world units per second. */
  baseSpeed: 0.11,
  /** Speed multiplier range mapped from `flow`. */
  speedRange: [0.6, 2.5],
  /** Steepest allowed heading: tan(18°) sideways per unit upwards. */
  maxSlope: Math.tan((18 * Math.PI) / 180),
  /** Sideways noise strength range mapped from `turbulence`, relative to upward speed. */
  turbulenceRange: [0.05, 0.6],
  /** Pull toward the stream's centre line, 1/s. */
  steer: 0.4,
  /** Particle velocity time constant, s. */
  inertia: 0.25,

  /** Centre-line swing as a fraction of band half-width, waves per screen height, phase speed (rad/s). */
  braid: 0.5,
  braidWaves: 0.7,
  braidSpeed: 0.11,
  /** Empty margin at each side, fraction of width. */
  bandMargin: 0.07,
  /** Spawn spread (standard deviation) as a fraction of band half-width. */
  spawnSpread: 0.85,

  /** Average particle turnover; spawn rates are scaled so the pool refills about this often. */
  turnoverSeconds: 7,
  lifeRange: [5, 14],
  fadeIn: 0.25,
  fadeOut: 1.2,
  /** Streak half-width in CSS px, multiplied by a per-particle factor. */
  sizePx: 0.9,
  sizeJitter: [0.7, 1.6],
  speedJitter: [0.8, 1.2],
  /** Streak length in seconds of motion, mapped from `flow`. */
  streakRange: [0.04, 0.12],

  /** Hue in turns: global rotation per second, change from bottom to top, per-particle spread. */
  hueRotate: 0.008,
  hueGradient: 0.55,
  hueJitter: 0.04,
  /** Fastest per-stream hue drift from `heat`, turns per second. */
  hueDriftMax: 0.03,
  /** OKLCH chroma and lightness. */
  chroma: 0.17,
  lightness: 0.75,
  intensity: 0.3,

  /** Trail fade time constant, s. */
  trailTau: 0.35,
  /** Tone-mapping exposure for the additive buffer. */
  exposure: 1.4,

  /** Easing time constants for incoming channels, s. */
  tau: {
    width: 3,
    flow: 2,
    density: 4,
    turbulence: 3,
    heat: 5,
    pulseRise: 0.3,
    pulseFall: 2,
    vitality: 3,
    presence: 2,
    layout: 3,
  },

  /** Curl-noise grid: rows per screen height, spatial frequency, upward scroll and evolution speed. */
  field: { rows: 28, frequency: 2.2, scroll: 0.08, evolve: 0.05 },

  /** Longest simulated step, s; longer gaps (hidden tab) are clamped. */
  maxDt: 0.1,
  devicePixelRatioCap: 1.5,
} as const;

export interface Config {
  /** Particle pool size. `?particles=N` overrides. */
  particles: number;
  /** Speed and turbulence scale; lowered for `prefers-reduced-motion`. */
  motion: number;
  /** Uses generated frames instead of the bridge. `?demo` enables. */
  demo: boolean;
  /** Demo stream count. `?streams=N` overrides. */
  demoStreams: number;
  /** Demo update interval, ms. `?interval=N` overrides (60000 mimics the `systems` source). */
  demoIntervalMs: number;
  /** PRNG seed. `?seed=N` overrides. */
  seed: number;
  /** Shows the debug panel. `?debug` enables. */
  debug: boolean;
}

export function readConfig(search: string, matches: (mediaQuery: string) => boolean): Config {
  const params = new URLSearchParams(search);
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const value = Number.parseInt(params.get(name) ?? "", 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };

  const reducedMotion = matches("(prefers-reduced-motion: reduce)");
  const budget = matches("(pointer: coarse)") ? 8000 : 20000;

  return {
    particles: int("particles", reducedMotion ? budget / 2 : budget, 100, 200000),
    motion: reducedMotion ? 0.5 : 1,
    demo: params.has("demo"),
    demoStreams: int("streams", 4, 0, 32),
    demoIntervalMs: int("interval", 1000, 100, 600000),
    seed: int("seed", Math.floor(Math.random() * 2 ** 31), 0, 2 ** 31),
    debug: params.has("debug"),
  };
}
