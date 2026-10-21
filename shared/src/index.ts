// Wire format shared by the bridge and the frontend. Type-only: the package has no runtime entry point,
// so consumers must use `import type`. See docs/PLAN.md "Message format".

/** Version carried in every frame; bumped on incompatible changes. */
export type FormatVersion = 1;

/** SSE event names on `GET /stream`. Both carry a full `Frame`. */
export type FrameEvent = "snapshot" | "update";

/** One SSE event payload: the full state of every stream. */
export interface Frame {
  v: FormatVersion;
  /** Server time, Unix ms. */
  t: number;
  /** All streams, already in band order (left to right). */
  streams: Stream[];
}

/** One host, anonymized. Every channel is a number in 0..1. */
export interface Stream {
  /** Opaque 8-hex-character ID, stable per host. */
  id: string;
  /** Host is reporting. */
  alive: boolean;
  /** Relative band width, quantized. */
  width: number;
  /** Upward speed. */
  flow: number;
  /** Spawn rate. */
  density: number;
  /** Sideways noise strength. */
  turbulence: number;
  /** Burst strength. */
  pulse: number;
  /** Hue drift; 0.5 is neutral. */
  heat: number;
  /** Per-core activity resampled to 6 values; `realtime` source only. */
  filaments?: number[];
}

/** The numeric channels of a `Stream`. */
export type Channel = "width" | "flow" | "density" | "turbulence" | "pulse" | "heat";
