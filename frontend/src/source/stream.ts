import type { Frame, FrameEvent, Stream } from "@beszel-river/shared";
import { clamp } from "../util/math";
import type { FrameSource } from "./source";

const EVENTS: readonly FrameEvent[] = ["snapshot", "update"];
const CHANNELS = ["width", "flow", "density", "turbulence", "pulse", "heat"] as const;

/** Reconnect delays after the connection fails for good, ms. */
const RETRY_MIN = 5_000;
const RETRY_MAX = 60_000;

export interface StreamOptions {
  url: string;
  /** Called once if the first connection fails before any frame arrives (dev falls back to the demo). */
  onUnavailable?: () => void;
}

/**
 * Frames from the bridge's `GET /stream`. The connection is closed while the tab is hidden; showing the
 * tab reconnects, and the snapshot event restores the full state.
 */
export class StreamSource implements FrameSource {
  private onFrame: ((frame: Frame) => void) | undefined;
  private events: EventSource | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = RETRY_MIN;
  private received = false;

  constructor(private readonly options: StreamOptions) {}

  start(onFrame: (frame: Frame) => void): void {
    this.onFrame = onFrame;
    document.addEventListener("visibilitychange", this.onVisibility);
    if (!document.hidden) this.open();
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.close();
    this.onFrame = undefined;
  }

  private open(): void {
    if (this.events) return;
    const events = new EventSource(this.options.url);
    for (const name of EVENTS) events.addEventListener(name, this.onMessage);
    events.addEventListener("error", this.onError);
    this.events = events;
  }

  private close(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.events?.close();
    this.events = undefined;
  }

  private readonly onMessage = (event: MessageEvent<string>): void => {
    const frame = parseFrame(event.data);
    if (!frame) return;
    this.received = true;
    this.retryDelay = RETRY_MIN;
    this.onFrame?.(frame);
  };

  private readonly onError = (): void => {
    // While CONNECTING the browser retries by itself (`retry: 5000`). An HTTP error such as nginx's 502
    // while the bridge restarts closes the source for good, so reconnect with backoff.
    if (this.events?.readyState !== EventSource.CLOSED) return;
    this.close();
    if (!this.received && this.options.onUnavailable) {
      this.options.onUnavailable();
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!document.hidden) this.open();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX);
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.close();
    else this.open();
  };
}

/** Accepts only version 1 frames; channels are clamped so a bad value cannot break the simulation. */
export function parseFrame(data: string): Frame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== 1 || typeof raw.t !== "number" || !Array.isArray(raw.streams)) return null;
  const streams: Stream[] = [];
  for (const s of raw.streams as unknown[]) {
    if (!isObject(s) || typeof s.id !== "string") continue;
    const stream: Stream = { id: s.id, alive: s.alive === true, width: 0.5, flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 };
    for (const channel of CHANNELS) {
      const value = s[channel];
      if (typeof value === "number" && Number.isFinite(value)) stream[channel] = clamp(value, 0, 1);
    }
    streams.push(stream);
  }
  return { v: 1, t: raw.t, streams };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
