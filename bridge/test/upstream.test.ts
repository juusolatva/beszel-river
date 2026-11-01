import { describe, expect, it } from "vitest";
import { UPSTREAM_GRACE_MS, UpstreamWatch } from "../src/upstream.js";

describe("UpstreamWatch", () => {
  it("stays live while connected", () => {
    const watch = new UpstreamWatch(() => true);
    expect(watch.update(0)).toBe(false);
    expect(watch.update(UPSTREAM_GRACE_MS * 2)).toBe(false);
    expect(watch.live).toBe(true);
  });

  it("reports a loss once, after the grace period", () => {
    const watch = new UpstreamWatch(() => false, 1000);
    expect(watch.update(0)).toBe(false);
    expect(watch.update(999)).toBe(false);
    expect(watch.live).toBe(true);
    expect(watch.update(1000)).toBe(true);
    expect(watch.live).toBe(false);
    expect(watch.update(5000)).toBe(false);
    expect(watch.live).toBe(false);
  });

  it("ignores outages shorter than the grace period and restarts the clock after each", () => {
    let connected = false;
    const watch = new UpstreamWatch(() => connected, 1000);
    watch.update(0);
    connected = true;
    expect(watch.update(500)).toBe(false);
    expect(watch.reconnected).toBe(true);
    connected = false;
    expect(watch.update(600)).toBe(false);
    expect(watch.reconnected).toBe(false);
    expect(watch.update(1500)).toBe(false);
    expect(watch.live).toBe(true);
    expect(watch.update(1600)).toBe(true);
  });

  it("is live again as soon as the connection is back", () => {
    let connected = false;
    const watch = new UpstreamWatch(() => connected, 1000);
    watch.update(0);
    watch.update(1000);
    connected = true;
    expect(watch.update(1001)).toBe(true);
    expect(watch.live).toBe(true);
    expect(watch.reconnected).toBe(true);
    expect(watch.update(1002)).toBe(false);
    expect(watch.reconnected).toBe(false);
  });

  it("reports reconnected on the next update when a disconnect is marked between ticks", () => {
    const watch = new UpstreamWatch(() => true, 1000);
    watch.markDisconnected(100);
    expect(watch.reconnected).toBe(false);
    expect(watch.update(200)).toBe(false);
    expect(watch.reconnected).toBe(true);
    expect(watch.update(300)).toBe(false);
    expect(watch.reconnected).toBe(false);
  });
});
