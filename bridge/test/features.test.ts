import { describe, expect, it } from "vitest";
import { Baseline, computeFeatures, logRatio, percentile, sampleFromInfo, sampleFromStats } from "../src/pipeline/features.js";

const MB = 1024 * 1024;

describe("sampleFromStats", () => {
  it("reads current fields", () => {
    const s = sampleFromStats({ cpu: 40, cpum: 90, mp: 55, b: [1000, 3000], bm: [5000, 9000], dio: [10, 20], la: [2, 1, 1], t: { a: 45, b: 61 } });
    expect(s).toEqual({ cpu: 40, cpuPeak: 90, mem: 55, tx: 1000, rx: 3000, txPeak: 5000, rxPeak: 9000, diskRead: 10, diskWrite: 20, load1: 2, tempMax: 61 });
  });

  it("falls back to the older MB/s fields and to averages for missing peaks", () => {
    const s = sampleFromStats({ cpu: 10, ns: 1, nr: 2, dr: 0.5, dw: 0.25 });
    expect(s.tx).toBe(MB);
    expect(s.rx).toBe(2 * MB);
    expect(s.diskRead).toBe(0.5 * MB);
    expect(s.diskWrite).toBe(0.25 * MB);
    expect(s.cpuPeak).toBe(10);
    expect(s.txPeak).toBe(MB);
    expect(s.tempMax).toBeNull();
  });

  it("ignores temperature sensors reporting 0", () => {
    expect(sampleFromStats({ t: { a: 0, b: 0 } }).tempMax).toBeNull();
    expect(sampleFromStats({ t: { a: 0, b: 42 } }).tempMax).toBe(42);
  });
});

describe("sampleFromInfo", () => {
  it("splits total bandwidth evenly", () => {
    const s = sampleFromInfo({ cpu: 12, mp: 30, bb: 4000, la: [0.5], dt: 50 });
    expect([s.tx, s.rx, s.load1, s.tempMax]).toEqual([2000, 2000, 0.5, 50]);
    expect(sampleFromInfo({ dt: 0 }).tempMax).toBeNull();
  });
});

describe("logRatio", () => {
  it("is 1 at the reference and compresses below it", () => {
    expect(logRatio(1000, 1000)).toBe(1);
    expect(logRatio(100, 1000)).toBeCloseTo(0.52, 2);
    expect(logRatio(10, 1000)).toBeCloseTo(0.15, 2);
    expect(logRatio(0, 1000)).toBe(0);
    expect(logRatio(1e9, 1000)).toBe(1);
  });
});

describe("Baseline", () => {
  it("uses the 95th percentile with a floor", () => {
    const b = new Baseline();
    expect(b.netReference()).toBe(64 * 1024);
    for (let i = 1; i <= 100; i++) b.add(sampleFromStats({ b: [i * MB, 0] }));
    expect(b.netReference()).toBe(96 * MB);
  });

  it("keeps only the most recent window", () => {
    const b = new Baseline(3);
    for (const n of [100, 100, 1, 1, 1]) b.add(sampleFromStats({ b: [n * MB, 0] }));
    expect(b.netReference()).toBe(MB);
  });

  it("percentile handles empty input", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("computeFeatures", () => {
  const baseline = new Baseline();

  it("scales to 0..1", () => {
    const f = computeFeatures(sampleFromStats({ cpu: 50, mp: 25, la: [4], t: { x: 60 } }), baseline, 8, null);
    expect(f.cpu).toBe(0.5);
    expect(f.mem).toBe(0.25);
    expect(f.load).toBe(0.5);
    expect(f.temp).toBe(0.5);
    expect(f.netChange).toBe(0);
    for (const value of Object.values(f)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("treats idle traffic as direction-neutral", () => {
    expect(computeFeatures(sampleFromStats({ b: [10, 10] }), baseline, 1, null).txShare).toBe(0.5);
    expect(computeFeatures(sampleFromStats({ b: [30000, 10000] }), baseline, 1, null).txShare).toBe(0.75);
  });

  it("measures change against the previous sample", () => {
    const second = computeFeatures(sampleFromStats({ b: [64 * 1024, 0] }), baseline, 1, sampleFromStats({ b: [0, 0] }));
    expect(second.netChange).toBe(1);
    const disk = computeFeatures(sampleFromStats({ dio: [0, 0] }), baseline, 1, sampleFromStats({ dio: [128 * 1024, 0] }));
    expect(disk.diskChange).toBe(0.5);
  });

  it("keeps an idle host's trickle from reading as change", () => {
    const f = computeFeatures(sampleFromStats({ b: [4096, 0], dio: [16384, 0] }), baseline, 1, sampleFromStats({ b: [1024, 0], dio: [0, 0] }));
    expect(f.netChange).toBeLessThan(0.05);
    expect(f.diskChange).toBeLessThan(0.07);
  });

  it("reports bursts from CPU and network peaks", () => {
    expect(computeFeatures(sampleFromStats({ cpu: 20, cpum: 70 }), baseline, 1, null).burst).toBe(1);
    expect(computeFeatures(sampleFromStats({ cpu: 20, cpum: 20 }), baseline, 1, null).burst).toBe(0);
  });

  it("reports rises since the previous sample as bursts, since 1m records carry no peaks", () => {
    expect(computeFeatures(sampleFromStats({ cpu: 45 }), baseline, 1, sampleFromStats({ cpu: 20 })).burst).toBe(0.5);
    expect(computeFeatures(sampleFromStats({ cpu: 20 }), baseline, 1, sampleFromStats({ cpu: 45 })).burst).toBe(0);
    expect(computeFeatures(sampleFromStats({ b: [32 * 1024, 0] }), baseline, 1, sampleFromStats({ b: [0, 0] })).burst).toBe(0.5);
  });
});
