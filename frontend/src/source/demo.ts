import type { Channel, Frame, Stream } from "@beszel-river/shared";
import { FILAMENTS } from "../sim/streams";
import { clamp, gaussian, type Random } from "../util/math";
import type { FrameSource } from "./source";

export const CHANNELS: readonly Channel[] = ["flow", "density", "turbulence", "pulse", "heat", "width"];

export type Channels = Record<Channel, number>;

export interface DemoStream {
  id: string;
  alive: boolean;
  /** Set by the debug panel: the random walk leaves `values` alone. */
  held: boolean;
  values: Channels;
  means: Channels;
  /** Sends `filaments`, as the bridge does with the `realtime` source; toggled in the debug panel. */
  filaments: boolean;
  /** Per-lane activity, wandering around `flow`. */
  lanes: number[];
}

export interface DemoOptions {
  streams: number;
  intervalMs: number;
  random: Random;
}

/** Generates frames with drifting channels and occasional bursts, standing in for the bridge. */
export class DemoSource implements FrameSource {
  readonly streams: DemoStream[] = [];
  private onFrame: ((frame: Frame) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: DemoOptions) {
    for (let i = 0; i < options.streams; i++) this.streams.push(this.createStream());
  }

  start(onFrame: (frame: Frame) => void): void {
    this.onFrame = onFrame;
    this.emit();
    this.timer = setInterval(() => {
      this.tick();
      this.emit();
    }, this.options.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.onFrame = undefined;
  }

  addStream(): void {
    this.streams.push(this.createStream());
    this.emit();
  }

  removeStream(): void {
    this.streams.pop();
    this.emit();
  }

  emit(): void {
    const streams = this.streams.map((s): Stream => ({ id: s.id, alive: s.alive, ...s.values, ...(s.filaments ? { filaments: [...s.lanes] } : {}) }));
    this.onFrame?.({ v: 1, t: Date.now(), streams });
  }

  private createStream(): DemoStream {
    const { random } = this.options;
    const id = Math.floor(random() * 2 ** 32)
      .toString(16)
      .padStart(8, "0");
    const means: Channels = {
      flow: 0.2 + 0.6 * random(),
      density: 0.2 + 0.6 * random(),
      turbulence: 0.2 + 0.6 * random(),
      pulse: 0,
      heat: 0.3 + 0.4 * random(),
      // Quantized like the bridge's widths.
      width: Math.round(random() * 4) / 4,
    };
    const lanes = Array.from({ length: FILAMENTS }, () => clamp(means.flow + 0.3 * gaussian(random), 0, 1));
    return { id, alive: true, held: false, values: { ...means }, means, filaments: true, lanes };
  }

  private tick(): void {
    const { random } = this.options;
    for (const stream of this.streams) {
      if (stream.held) continue;
      const { values, means } = stream;
      for (const channel of ["flow", "density", "turbulence", "heat"] as const) {
        means[channel] = clamp(means[channel] + 0.01 * gaussian(random), 0.1, 0.9);
        values[channel] = clamp(values[channel] + 0.15 * (means[channel] - values[channel]) + 0.07 * gaussian(random), 0, 1);
      }
      values.pulse = random() < 0.08 ? 0.5 + 0.5 * random() : values.pulse * 0.5;
      // Lanes wander around flow, now and then one of them jumps, like a single busy core.
      stream.lanes = stream.lanes.map((lane) => clamp(lane + 0.2 * (values.flow - lane) + 0.08 * gaussian(random), 0, 1));
      if (random() < 0.1) stream.lanes[Math.floor(random() * FILAMENTS)] = 0.8 + 0.2 * random();
    }
  }
}
