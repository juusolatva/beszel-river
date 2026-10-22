import type { SystemInfo, SystemStats } from "../beszel/types.js";

const MB = 1024 * 1024;

/** One reading of a host in Beszel's units: percent, bytes/s, °C. */
export interface Sample {
  cpu: number;
  cpuPeak: number;
  mem: number;
  tx: number;
  rx: number;
  txPeak: number;
  rxPeak: number;
  diskRead: number;
  diskWrite: number;
  load1: number;
  tempMax: number | null;
}

export function sampleFromStats(s: SystemStats): Sample {
  const cpu = s.cpu ?? 0;
  const tx = s.b?.[0] ?? (s.ns ?? 0) * MB;
  const rx = s.b?.[1] ?? (s.nr ?? 0) * MB;
  // Agents report 0 for sensors they cannot read.
  const temps = Object.values(s.t ?? {}).filter((t) => t > 0);
  return {
    cpu,
    cpuPeak: s.cpum ?? cpu,
    mem: s.mp ?? 0,
    tx,
    rx,
    txPeak: s.bm?.[0] ?? tx,
    rxPeak: s.bm?.[1] ?? rx,
    diskRead: s.dio?.[0] ?? (s.dr ?? 0) * MB,
    diskWrite: s.dio?.[1] ?? (s.dw ?? 0) * MB,
    load1: s.la?.[0] ?? 0,
    tempMax: temps.length > 0 ? Math.max(...temps) : null,
  };
}

/** Fallback before a host has any `system_stats` record: `info` has no direction split or disk I/O. */
export function sampleFromInfo(i: SystemInfo): Sample {
  const half = (i.bb ?? 0) / 2;
  const cpu = i.cpu ?? 0;
  return {
    cpu,
    cpuPeak: cpu,
    mem: i.mp ?? 0,
    tx: half,
    rx: half,
    txPeak: half,
    rxPeak: half,
    diskRead: 0,
    diskWrite: 0,
    load1: i.la?.[0] ?? 0,
    tempMax: i.dt && i.dt > 0 ? i.dt : null,
  };
}

/** Byte rates over the last 24 h of samples, to scale each host against its own normal traffic. */
export class Baseline {
  private readonly net: number[] = [];
  private readonly disk: number[] = [];

  constructor(private readonly size = 24 * 60) {}

  add(sample: Sample): void {
    push(this.net, sample.tx + sample.rx, this.size);
    push(this.disk, sample.diskRead + sample.diskWrite, this.size);
  }

  /** 95th percentile, floored so an idle host does not turn every trickle into full scale. */
  netReference(): number {
    return Math.max(percentile(this.net, 0.95), 64 * 1024);
  }

  diskReference(): number {
    return Math.max(percentile(this.disk, 0.95), 256 * 1024);
  }
}

function push(values: number[], value: number, size: number): void {
  values.push(value);
  if (values.length > size) values.shift();
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
}

/**
 * Log scale relative to a reference: 1 at the reference, 0.52 at a tenth of it, 0.15 at a hundredth.
 * Keeps quiet and busy hosts both using the full range.
 */
export function logRatio(rate: number, reference: number): number {
  return clamp01(Math.log1p((100 * rate) / reference) / Math.log1p(100));
}

export const FEATURES = ["cpu", "mem", "net", "netChange", "disk", "diskChange", "load", "burst", "txShare", "temp"] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, number>;

/** Turns a sample into 0..1 features. `previous` is the host's previous features, for change-based ones. */
export function computeFeatures(sample: Sample, baseline: Baseline, threads: number, previous: Features | null): Features {
  const netRef = baseline.netReference();
  const net = logRatio(sample.tx + sample.rx, netRef);
  const disk = logRatio(sample.diskRead + sample.diskWrite, baseline.diskReference());
  const total = sample.tx + sample.rx;
  const cpuBurst = clamp01((sample.cpuPeak - sample.cpu) / 50);
  const netBurst = clamp01(logRatio(sample.txPeak + sample.rxPeak, netRef) - net);
  return {
    cpu: clamp01(sample.cpu / 100),
    mem: clamp01(sample.mem / 100),
    net,
    netChange: previous ? Math.abs(net - previous.net) : 0,
    disk,
    diskChange: previous ? Math.abs(disk - previous.disk) : 0,
    load: clamp01(sample.load1 / Math.max(threads, 1)),
    burst: Math.max(cpuBurst, netBurst),
    // 0.5 when idle, so direction only matters once there is traffic.
    txShare: total > 1024 ? sample.tx / total : 0.5,
    temp: sample.tempMax === null ? 0.5 : clamp01((sample.tempMax - 30) / 60),
  };
}
