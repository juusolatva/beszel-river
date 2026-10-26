import type { Frame } from "@beszel-river/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILAMENTS } from "../src/sim/streams";
import { CHANNELS, DemoSource } from "../src/source/demo";
import { parseFrame } from "../src/source/stream";
import { mulberry32 } from "../src/util/math";

function start(streams = 3): { source: DemoSource; frames: Frame[] } {
  const source = new DemoSource({ streams, intervalMs: 1000, random: mulberry32(1) });
  const frames: Frame[] = [];
  source.start((frame) => frames.push(frame));
  return { source, frames };
}

describe("DemoSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a frame at once and then on every interval, until stopped", () => {
    const { source, frames } = start();
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(frames).toHaveLength(4);
    source.stop();
    vi.advanceTimersByTime(3000);
    expect(frames).toHaveLength(4);
  });

  it("emits valid v1 frames that parseFrame passes through unchanged", () => {
    const { frames } = start(5);
    vi.advanceTimersByTime(200_000);
    for (const frame of frames) {
      expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
      expect(frame.streams).toHaveLength(5);
      for (const s of frame.streams) {
        expect(s.id).toMatch(/^[0-9a-f]{8}$/);
        expect(s.filaments).toHaveLength(FILAMENTS);
      }
    }
    // Channels drift, and bursts happen now and then.
    const flows = new Set(frames.map((f) => f.streams[0].flow));
    expect(flows.size).toBeGreaterThan(frames.length / 2);
    expect(frames.some((f) => f.streams.some((s) => s.pulse > 0.5))).toBe(true);
  });

  it("quantizes widths like the bridge and is repeatable for a seed", () => {
    const a = start(8);
    const b = start(8);
    vi.advanceTimersByTime(10_000);
    expect(a.frames.map((f) => f.streams.map((s) => [s.id, s.flow]))).toEqual(b.frames.map((f) => f.streams.map((s) => [s.id, s.flow])));
    for (const s of a.frames[0].streams) expect([0, 0.25, 0.5, 0.75, 1]).toContain(s.width);
  });

  it("leaves held streams alone and sends filaments only when enabled", () => {
    const { source, frames } = start(2);
    const [held, free] = source.streams;
    held.held = true;
    held.values.flow = 0.123;
    free.filaments = false;
    vi.advanceTimersByTime(10_000);
    const last = frames.at(-1)!;
    expect(last.streams[0].flow).toBe(0.123);
    expect(last.streams[1].filaments).toBeUndefined();
    for (const channel of CHANNELS) expect(last.streams[0][channel]).toBe(held.values[channel]);
  });

  it("adds and removes streams with an immediate frame", () => {
    const { source, frames } = start(2);
    source.addStream();
    expect(frames.at(-1)?.streams).toHaveLength(3);
    source.removeStream();
    source.removeStream();
    expect(frames.at(-1)?.streams).toHaveLength(1);
    expect(frames).toHaveLength(4);
  });

  it("marks streams that are not alive", () => {
    const { source, frames } = start(2);
    source.streams[1].alive = false;
    source.emit();
    expect(frames.at(-1)?.streams.map((s) => s.alive)).toEqual([true, false]);
  });
});
