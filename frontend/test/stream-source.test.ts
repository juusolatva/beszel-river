import type { Frame } from "@beszel-river/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamSource } from "../src/source/stream";

type Listener = (event?: unknown) => void;

/** Stand-in for the browser's EventSource; tests drive it through `emit` and `readyState`. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(name: string, event?: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  /** The browser gives up, as after an HTTP error. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.emit("error");
  }
}

const FRAME = JSON.stringify({ v: 1, t: 1, streams: [] });

/** Document and window listeners, keyed by event name. */
const doc = { hidden: false, listeners: new Map<string, Listener>() };
const win = new Map<string, Listener>();

function latest(): FakeEventSource {
  const events = FakeEventSource.instances.at(-1);
  if (!events) throw new Error("no EventSource");
  return events;
}

function setVisible(visible: boolean): void {
  doc.hidden = !visible;
  doc.listeners.get("visibilitychange")?.();
}

describe("StreamSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    doc.hidden = false;
    doc.listeners.clear();
    win.clear();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("document", {
      get hidden() {
        return doc.hidden;
      },
      addEventListener: (name: string, listener: Listener) => doc.listeners.set(name, listener),
      removeEventListener: (name: string) => doc.listeners.delete(name),
    });
    vi.stubGlobal("addEventListener", (name: string, listener: Listener) => win.set(name, listener));
    vi.stubGlobal("removeEventListener", (name: string) => win.delete(name));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects, forwards valid frames, drops invalid ones, and reports the connection", () => {
    const onStatus = vi.fn();
    const frames: Frame[] = [];
    const source = new StreamSource({ url: "stream", onStatus });
    source.start((frame) => frames.push(frame));

    const events = latest();
    expect(events.url).toBe("stream");
    events.emit("open");
    expect(onStatus).toHaveBeenLastCalledWith(true);
    events.emit("snapshot", { data: FRAME });
    events.emit("update", { data: "not json" });
    events.emit("update", { data: FRAME });
    expect(frames).toHaveLength(2);

    source.stop();
    expect(events.closed).toBe(true);
    expect(doc.listeners.size).toBe(0);
    expect(win.size).toBe(0);
    events.emit("update", { data: FRAME });
    expect(frames).toHaveLength(2);
  });

  it("waits for the tab to be shown, and closes while it is hidden", () => {
    doc.hidden = true;
    const onStatus = vi.fn();
    const source = new StreamSource({ url: "stream", onStatus });
    source.start(() => undefined);
    expect(FakeEventSource.instances).toHaveLength(0);

    setVisible(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    setVisible(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    setVisible(false);
    expect(latest().closed).toBe(true);
    expect(onStatus).not.toHaveBeenCalled();
    setVisible(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    source.stop();
  });

  it("leaves retries to the browser while it is still connecting", () => {
    const onStatus = vi.fn();
    const source = new StreamSource({ url: "stream", onStatus });
    source.start(() => undefined);
    latest().emit("error");
    expect(onStatus).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    source.stop();
  });

  it("reconnects with backoff after the browser gives up, resetting it once a frame arrives", () => {
    const source = new StreamSource({ url: "stream" });
    source.start(() => undefined);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const count = FakeEventSource.instances.length;
      latest().fail();
      let waited = 0;
      while (FakeEventSource.instances.length === count) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);

    latest().emit("snapshot", { data: FRAME });
    latest().fail();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(8);
    source.stop();
  });

  it("does not reconnect while hidden, and reconnects when shown", () => {
    const source = new StreamSource({ url: "stream" });
    source.start(() => undefined);
    latest().fail();
    doc.hidden = true;
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);
    setVisible(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    source.stop();
  });

  it("reconnects at once when the browser comes back online, but not while connected or hidden", () => {
    const source = new StreamSource({ url: "stream" });
    source.start(() => undefined);
    win.get("online")?.();
    expect(FakeEventSource.instances).toHaveLength(1);

    latest().fail();
    latest().fail();
    win.get("online")?.();
    expect(FakeEventSource.instances).toHaveLength(2);
    // The pending retry was cancelled and the backoff reset.
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().fail();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(3);

    latest().fail();
    doc.hidden = true;
    win.get("online")?.();
    expect(FakeEventSource.instances).toHaveLength(3);
    source.stop();
  });

  it("hands over once when the first connection fails before any frame", () => {
    const onUnavailable = vi.fn();
    const onStatus = vi.fn();
    const source = new StreamSource({ url: "stream", onUnavailable, onStatus });
    source.start(() => undefined);
    latest().fail();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onStatus).not.toHaveBeenCalled();
    expect(latest().closed).toBe(true);

    // It stopped listening, so neither showing the tab nor going online reconnects alongside the fallback.
    expect(doc.listeners.size).toBe(0);
    expect(win.size).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects instead of handing over once a frame has arrived", () => {
    const onUnavailable = vi.fn();
    const source = new StreamSource({ url: "stream", onUnavailable });
    source.start(() => undefined);
    latest().emit("snapshot", { data: FRAME });
    latest().fail();
    expect(onUnavailable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(2);
    source.stop();
  });
});
