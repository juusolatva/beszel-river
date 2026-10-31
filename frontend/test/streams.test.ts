import type { Frame, Stream } from "@beszel-river/shared";
import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { FILAMENTS, MAX_STREAMS, StreamSet, StreamSlot, laneCenter } from "../src/sim/streams";

function stream(id: string, overrides: Partial<Stream> = {}): Stream {
  return { id, alive: true, width: 0.5, flow: 0.5, density: 0.5, turbulence: 0.5, pulse: 0, heat: 0.5, ...overrides };
}

function frame(...streams: Stream[]): Frame {
  return { v: 1, t: 0, streams };
}

function slotOf(set: StreamSet, id: string): StreamSlot {
  const slot = set.slots.find((s) => s.used && s.id === id);
  if (!slot) throw new Error(`no slot for ${id}`);
  return slot;
}

/** Advances `seconds` in 60 fps steps. */
function run(set: StreamSet, seconds: number, aspect = 1.6): void {
  for (let t = 0; t < seconds; t += 1 / 60) set.update(1 / 60, aspect);
}

describe("laneCenter", () => {
  it("spaces the lanes evenly and symmetrically within ±filamentSpan", () => {
    const centers = Array.from({ length: FILAMENTS }, (_, j) => laneCenter(j));
    expect(centers[0]).toBeCloseTo(-centers[FILAMENTS - 1]);
    expect(Math.max(...centers.map(Math.abs))).toBeLessThan(LOOK.filamentSpan);
    for (let j = 1; j < FILAMENTS; j++) expect(centers[j] - centers[j - 1]).toBeCloseTo(centers[1] - centers[0]);
  });
});

describe("StreamSlot.pickLane", () => {
  it("picks lanes in proportion to their cumulative weights, for any u in [0, 1)", () => {
    const slot = new StreamSlot();
    slot.laneWeights.set([1, 1, 1, 9, 10, 10]);
    expect(slot.pickLane(0)).toBe(0);
    expect(slot.pickLane(0.05)).toBe(0);
    expect(slot.pickLane(0.5)).toBe(3);
    expect(slot.pickLane(0.85)).toBe(3);
    expect(slot.pickLane(0.95)).toBe(4);
    // The last lane has no weight, so it is never picked.
    expect(slot.pickLane(0.9999)).toBe(4);

    slot.laneWeights.set([1, 2, 3, 4, 5, 6]);
    expect(slot.pickLane(0.9999)).toBe(5);
  });
});

describe("StreamSet", () => {
  it("shows streams in the first frame at once and fades in later ones", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a", { flow: 0.8, heat: 0.2 })));
    const a = slotOf(set, "a");
    expect(a.presence).toBe(1);
    expect(a.flow).toBe(0.8);
    expect(a.heat).toBe(0.2);

    set.apply(frame(stream("a"), stream("b")));
    const b = slotOf(set, "b");
    expect(b.presence).toBe(0);
    run(set, 0.5);
    expect(b.presence).toBeGreaterThan(0);
    expect(b.presence).toBeLessThan(1);
    run(set, 30);
    expect(b.presence).toBeCloseTo(1, 3);
  });

  it("gives each stream a stable hue and phase from its ID", () => {
    const one = new StreamSet(1);
    const two = new StreamSet(1);
    one.apply(frame(stream("a"), stream("b")));
    two.apply(frame(stream("b"), stream("a")));
    expect(slotOf(one, "a").hueOffset).toBe(slotOf(two, "a").hueOffset);
    expect(slotOf(one, "a").phase).toBe(slotOf(two, "a").phase);
    expect(slotOf(one, "a").hueOffset).not.toBe(slotOf(one, "b").hueOffset);
  });

  it("ignores streams beyond the slot count", () => {
    const set = new StreamSet(1);
    const streams = Array.from({ length: MAX_STREAMS + 3 }, (_, i) => stream(`s${i}`));
    set.apply(frame(...streams));
    expect(set.slots.filter((s) => s.used)).toHaveLength(MAX_STREAMS);
    expect(set.slots.some((s) => s.id === `s${MAX_STREAMS}`)).toBe(false);
  });

  it("fades in all replacement IDs after a full set drains without another frame", () => {
    const set = new StreamSet(1);
    set.apply(frame(...Array.from({ length: MAX_STREAMS }, (_, i) => stream(`old${i}`))));
    set.apply(frame(...Array.from({ length: MAX_STREAMS }, (_, i) => stream(`new${i}`))));
    run(set, 30);
    expect(set.slots.every((s) => s.used && s.inFrame && s.id.startsWith("new"))).toBe(true);
    expect(set.slots.every((s) => s.presence > 0.99)).toBe(true);
  });

  it("retries only the latest pending frame", () => {
    const set = new StreamSet(1);
    set.apply(frame(...Array.from({ length: MAX_STREAMS }, (_, i) => stream(`old${i}`))));
    set.apply(frame(stream("superseded")));
    set.apply(frame(stream("latest")));
    run(set, 30);
    expect(set.slots.filter((s) => s.used).map((s) => s.id)).toEqual(["latest"]);
  });

  it("drains a removed stream, releases its slot once faded and empty, and reuses it", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a"), stream("b")));
    set.apply(frame(stream("b")));
    const a = slotOf(set, "a");
    expect(a.inFrame).toBe(false);

    a.particles = 1;
    run(set, 30);
    expect(a.presence).toBeLessThan(0.01);
    expect(a.used).toBe(true);

    a.particles = 0;
    set.update(1 / 60, 1.6);
    expect(a.used).toBe(false);
    expect(a.latest).toBeNull();

    set.apply(frame(stream("b"), stream("c")));
    expect(slotOf(set, "c")).toBe(a);
  });

  it("brings a draining stream back when it returns before it is released", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a")));
    const a = slotOf(set, "a");
    set.apply(frame());
    run(set, 0.5);
    set.apply(frame(stream("a")));
    expect(slotOf(set, "a")).toBe(a);
    expect(a.inFrame).toBe(true);
  });

  it("lays bands out in frame order with widths in proportion, filling the span without overlap", () => {
    const aspect = 2;
    const set = new StreamSet(1);
    set.apply(frame(stream("b", { width: 1 }), stream("a", { width: 0 }), stream("c", { width: 0.5 })));
    set.update(1 / 60, aspect);
    const [b, a, c] = ["b", "a", "c"].map((id) => slotOf(set, id));

    expect(b.center).toBeLessThan(a.center);
    expect(a.center).toBeLessThan(c.center);
    expect(b.center - b.half).toBeCloseTo(aspect * LOOK.bandMargin);
    expect(b.center + b.half).toBeCloseTo(a.center - a.half);
    expect(a.center + a.half).toBeCloseTo(c.center - c.half);
    expect(c.center + c.half).toBeCloseTo(aspect * (1 - LOOK.bandMargin));
    // Band weights are 0.6 + 0.8 · width.
    expect(b.half / a.half).toBeCloseTo(1.4 / 0.6);
  });

  it("eases the layout of known streams but snaps new ones into place", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a")));
    set.update(1 / 60, 1);
    const a = slotOf(set, "a");
    const before = a.center;

    set.apply(frame(stream("b"), stream("a")));
    set.update(1 / 60, 1);
    const b = slotOf(set, "b");
    expect(b.center).toBe(b.centerTarget);
    expect(a.center).not.toBe(a.centerTarget);
    expect(a.center).toBeGreaterThan(before);
    run(set, 30, 1);
    expect(a.center).toBeCloseTo(a.centerTarget);
  });

  it("keeps a draining stream's last place", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a"), stream("b")));
    set.update(1 / 60, 1);
    const a = slotOf(set, "a");
    const { centerTarget, halfTarget } = a;
    set.apply(frame(stream("b")));
    set.update(1 / 60, 1);
    expect(a.centerTarget).toBe(centerTarget);
    expect(a.halfTarget).toBe(halfTarget);
  });

  it("eases channels toward the latest frame", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a", { flow: 0 })));
    set.apply(frame(stream("a", { flow: 1 })));
    const a = slotOf(set, "a");
    set.update(1 / 60, 1);
    expect(a.flow).toBeGreaterThan(0);
    expect(a.flow).toBeLessThan(0.1);
    run(set, 60);
    expect(a.flow).toBeCloseTo(1, 3);
  });

  it("raises the pulse faster than it falls, and slower with reduced motion", () => {
    const rise = (motion: number): number => {
      const set = new StreamSet(motion);
      set.apply(frame(stream("a")));
      set.apply(frame(stream("a", { pulse: 1 })));
      set.update(0.05, 1);
      return slotOf(set, "a").pulse;
    };
    expect(rise(0.5)).toBeLessThan(rise(1));

    const set = new StreamSet(1);
    set.apply(frame(stream("a", { pulse: 1 })));
    set.apply(frame(stream("a", { pulse: 0 })));
    set.update(0.05, 1);
    expect(1 - slotOf(set, "a").pulse).toBeLessThan(rise(1));
  });

  it("thins out and greys streams whose host is down, and all of them while offline", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("up"), stream("down", { alive: false })));
    set.update(1 / 60, 1);
    const up = slotOf(set, "up");
    const down = slotOf(set, "down");
    expect(down.vitality).toBe(0);
    expect(down.spawnWeight).toBeLessThan(up.spawnWeight);
    expect(down.chroma).toBeLessThan(up.chroma);
    expect(down.speed).toBeLessThan(up.speed);

    set.offline = true;
    run(set, 30);
    expect(up.vitality).toBeLessThan(0.01);
  });

  it("derives faster, longer streaks from flow, and slows everything with reduced motion", () => {
    const derive = (motion: number, flow: number): StreamSlot => {
      const set = new StreamSet(motion);
      set.apply(frame(stream("a", { flow })));
      set.update(1 / 60, 1);
      return slotOf(set, "a");
    };
    expect(derive(1, 1).speed).toBeGreaterThan(derive(1, 0).speed);
    expect(derive(1, 1).streakSeconds).toBeGreaterThan(derive(1, 0).streakSeconds);
    expect(derive(0.5, 0.5).speed).toBeCloseTo(derive(1, 0.5).speed / 2);
    expect(derive(0.5, 0.5).turbulenceAmp).toBeCloseTo(derive(1, 0.5).turbulenceAmp / 2);
  });

  it("weights lanes by filament activity, and fades the lanes out when filaments stop", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a", { filaments: [0, 0, 1, 1, 0, 0] })));
    set.update(1 / 60, 1);
    const a = slotOf(set, "a");
    expect(a.filamentMix).toBe(1);
    const w = a.laneWeights;
    for (let j = 1; j < FILAMENTS; j++) expect(w[j]).toBeGreaterThan(w[j - 1]);
    expect(w[2] - w[1]).toBeGreaterThan(w[1] - w[0]);
    expect(a.pickLane(0.5)).toBeGreaterThanOrEqual(2);
    expect(a.pickLane(0.5)).toBeLessThanOrEqual(3);

    set.apply(frame(stream("a")));
    run(set, 30);
    expect(a.filamentMix).toBeLessThan(0.01);
    // The lanes keep their last activity, so filaments that come back start from there.
    expect(a.filaments[2]).toBeCloseTo(1);
    expect(a.filaments[0]).toBe(0);
  });

  it("starts a new stream without filaments at zero lane activity", () => {
    const set = new StreamSet(1);
    set.apply(frame(stream("a")));
    const a = slotOf(set, "a");
    expect(a.filamentMix).toBe(0);
    expect(Array.from(a.filaments)).toEqual(new Array(FILAMENTS).fill(0));
  });

  it("drifts hue with heat, toward hotter or colder, and not at neutral heat", () => {
    const drift = (heat: number): number => {
      const set = new StreamSet(1);
      set.apply(frame(stream("a", { heat })));
      const a = slotOf(set, "a");
      const start = a.hueOffset;
      set.update(0.1, 1);
      // Signed shortest distance around the hue circle.
      return ((a.hueOffset - start + 1.5) % 1) - 0.5;
    };
    expect(drift(0.5)).toBeCloseTo(0);
    expect(drift(1)).toBeGreaterThan(0);
    expect(drift(0)).toBeLessThan(0);
  });
});
