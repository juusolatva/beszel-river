import { describe, expect, it } from "vitest";
import { LOOK } from "../src/config";
import { GpuLifecycle } from "../src/sim/gpu-lifecycle";
import { StreamSet } from "../src/sim/streams";
import { replayFrames } from "./fixtures/gpu-replay";

function setup(capacity = 100) {
  const life = new GpuLifecycle(capacity);
  const streams = new StreamSet(1, life.canRelease);
  streams.apply(replayFrames[2]);
  streams.update(0, 1.5);
  return { life, streams };
}

function advance(life: GpuLifecycle, seconds: number): void {
  const steps = Math.floor(seconds / 0.0625);
  for (let i = 0; i < steps; i++) life.advanceTime(0.0625);
  if (seconds > steps * 0.0625) life.advanceTime(seconds - steps * 0.0625);
}

describe("GPU request and retention policy", () => {
  it("keeps fractional requests and stable slot priority while discarding whole excess", () => {
    const { life, streams } = setup();
    for (const s of streams.slots) { s.shareWeight = 0; s.spawnWeight = 0; }
    streams.slots[0].shareWeight = 1;
    streams.slots[0].spawnWeight = 1;
    streams.slots[1].spawnWeight = 2;
    life.prepare(0.1, streams, 70); // rate=10; requests=1,2, regardless of available slots.
    expect([...life.commands.slice(0, 8)]).toEqual([1, 1, 0, 1, 1, 1, 1, 3]);
    life.prepare(0.05, streams, 70);
    expect([...life.commands.slice(0, 8)]).toEqual([1, 1, 0, 0, 1, 1, 0, 1]);
    life.prepare(0.05, streams, 70);
    expect([...life.commands.slice(0, 8)]).toEqual([1, 1, 0, 1, 1, 1, 1, 2]);
    expect(streams.slots.every(s => s.particles === 0 && s.spawnCarry === 0)).toBe(true);
  });

  it("issues no requests at zero share or dt and scales to the minimum share", () => {
    const { life, streams } = setup();
    for (const s of streams.slots) { s.shareWeight = 0; s.spawnWeight = 100; }
    life.prepare(0.1, streams, 70);
    expect(life.commands[127]).toBe(0);
    streams.slots[0].shareWeight = 0.3;
    streams.slots[0].spawnWeight = 0.6;
    for (let i = 1; i < 32; i++) streams.slots[i].spawnWeight = 0;
    life.prepare(0, streams, 70);
    expect(life.commands[3]).toBe(0);
    life.prepare(0.1, streams, 70);
    expect(life.commands[3]).toBe(1);
    life.prepare(0.1, streams, 0);
    expect(life.commands[3]).toBe(0);
  });

  it("retains removed state through strict maximum lifetime and resets on reappearance", () => {
    const { life, streams } = setup();
    const s = streams.slots[0];
    expect(life.canRelease(s, 0)).toBe(false); // Unsynchronized IDs cannot release.
    life.prepare(0.1, streams, 100);
    streams.apply({ v: 1, t: 0, streams: [] });
    s.presence = 0.009;
    life.prepare(0.1, streams, 100);
    expect(life.commands[3]).toBe(0);
    advance(life, LOOK.lifeRange[1] + Math.fround(LOOK.maxDt));
    expect(life.canRelease(s, 0)).toBe(false);
    life.advanceTime(0.01);
    expect(life.canRelease(s, 0)).toBe(true);
    streams.apply(replayFrames[2]);
    life.prepare(0.1, streams, 100);
    expect(life.commands[0]).toBe(1);
    streams.apply({ v: 1, t: 0, streams: [] });
    s.presence = 0.009;
    expect(life.canRelease(s, 0)).toBe(false);
    advance(life, 14.2);
    s.id = "mismatch";
    expect(life.canRelease(s, 0)).toBe(false);
  });

  it("retries the newest full replacement at the first safe update without SSE", () => {
    const life = new GpuLifecycle(100);
    const streams = new StreamSet(1, life.canRelease);
    const base = replayFrames[2].streams[0];
    const frame = (prefix: string) => ({ v: 1 as const, t: 0, streams: Array.from({ length: 32 }, (_, i) => ({ ...base, id: prefix + i })) });
    streams.apply(frame("old")); streams.update(0, 1); life.prepare(0.1, streams, 100);
    streams.apply(frame("stale")); streams.apply(frame("new"));
    for (const s of streams.slots) s.presence = 0;
    advance(life, 14.1); streams.update(0, 1);
    expect(streams.slots[0].id).toBe("old0");
    life.advanceTime(0.01); streams.update(0, 1);
    expect(streams.slots.every(s => s.id.startsWith("new"))).toBe(true);
    life.prepare(0.1, streams, 100);
    expect(life.commands[0]).toBe(2);
  });

  it("keeps default CPU count release and passes stable indexes to a custom policy", () => {
    const seen: number[] = [];
    const set = new StreamSet(1, (_s, i) => { seen.push(i); return i === 1; });
    set.apply(replayFrames[2]); set.apply({ v: 1, t: 0, streams: [] });
    for (const s of set.slots) s.presence = 0;
    set.update(0, 1);
    expect(seen).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(set.slots[0].used).toBe(true); expect(set.slots[1].used).toBe(false);
    const cpu = new StreamSet(1); cpu.apply(replayFrames[2]); cpu.apply({ v: 1, t: 0, streams: [] });
    for (const s of cpu.slots) s.presence = 0;
    cpu.slots[0].particles = 1; cpu.update(0, 1);
    expect(cpu.slots[0].used).toBe(true); expect(cpu.slots[1].used).toBe(false);
  });

  it("rejects generation overflow and invalid clocks, capacities and limits", () => {
    for (const n of [0, 1.5, NaN]) expect(() => new GpuLifecycle(n)).toThrow();
    const { life, streams } = setup();
    for (const n of [-1, NaN, Infinity]) expect(() => life.advanceTime(n)).toThrow();
    for (const n of [-1, 101, 1.5, NaN]) expect(() => life.prepare(0.1, streams, n)).toThrow();
    life.prepare(0.1, streams, 100);
    // Exercise the otherwise impractically distant wrap without a production test hook.
    (life as unknown as { generations: Uint32Array }).generations[0] = 0xffffffff;
    streams.slots[0].id = "replacement";
    expect(() => life.prepare(0.1, streams, 100)).toThrow("generation");
  });

  it("rejects schedules whose Float32 age can outlive the ownership deadline", () => {
    const { life, streams } = setup();
    // The reviewer's accepted-input counterexample: Float32 age lags wall-independent time.
    const dt = Math.fround(0.00001);
    let clock = 0, age = 0;
    while (clock <= 14 + Math.fround(LOOK.maxDt)) { clock += dt; age = Math.fround(age + dt); }
    expect(age).toBeLessThan(14);
    for (const invalid of [dt, 1 / 360, 0.2, Infinity, NaN]) {
      expect(() => life.advanceTime(invalid)).toThrow("GPU step");
      expect(() => life.prepare(invalid, streams, 100)).toThrow("GPU step");
    }
    expect(() => life.advanceTime(1 / 240)).not.toThrow();
    expect(() => life.advanceTime(0)).not.toThrow();
    (life as unknown as { time: number }).time = 2 ** 31;
    expect(() => life.advanceTime(0.1)).toThrow("clock overflow");
  });
});
