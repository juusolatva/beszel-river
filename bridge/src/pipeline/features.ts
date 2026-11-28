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
  /** Busy % per core; null when the agent does not report it. */
  cores: number[] | null;
}

export function sampleFromStats(s: SystemStats): Sample {
  const cpu = s.cpu ?? 0;
  const tx = s.b?.[0] ?? (s.ns ?? 0) * MB;
  const rx = s.b?.[1] ?? (s.nr ?? 0) * MB;
  // Agents report 0 for sensors they cannot read. A loop, not Math.max(...temps): spreading a large
  // sensor map would exceed the engine's argument limit and throw.
  let tempMax: number | null = null;
  for (const t of Object.values(s.t ?? {})) {
    if (t > 0 && (tempMax === null || t > tempMax)) tempMax = t;
  }
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
    tempMax,
    cores: s.cpus && s.cpus.length > 0 ? s.cpus : null,
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
    cores: null,
  };
}

/** Filaments per stream; fixed, so their number says nothing about the host's core count. */
export const FILAMENTS = 6;

/**
 * Per-core usage resampled to `FILAMENTS` values, 0..1 in ascending order: linear interpolation along
 * the sorted cores, from the idlest to the busiest. Any core count gives a smooth profile; only a
 * single core gives six equal values. Null without per-core data.
 */
export function coreProfile(cores: readonly number[] | null): number[] | null {
  if (!cores || cores.length === 0) return null;
  const sorted = [...cores].sort((a, b) => a - b);
  const last = sorted.length - 1;
  return Array.from({ length: FILAMENTS }, (_, i) => {
    const position = (i / (FILAMENTS - 1)) * last;
    const low = Math.floor(position);
    const high = Math.min(low + 1, last);
    return clamp01((sorted[low] + (sorted[high] - sorted[low]) * (position - low)) / 100);
  });
}

/** Byte rates over the last 24 h of samples, to scale each host against its own normal traffic. */
export class Baseline {
  private readonly net: SortedWindow;
  private readonly disk: SortedWindow;

  constructor(size = 24 * 60) {
    this.net = new SortedWindow(size);
    this.disk = new SortedWindow(size);
  }

  add(sample: Sample): void {
    this.net.push(sample.tx + sample.rx);
    this.disk.push(sample.diskRead + sample.diskWrite);
  }

  /** 95th percentile, floored so an idle host does not turn every trickle into full scale. */
  netReference(): number {
    return Math.max(this.net.percentile(0.95), 64 * 1024);
  }

  diskReference(): number {
    return Math.max(this.disk.percentile(0.95), 256 * 1024);
  }
}

/**
 * The last `size` values, kept in arrival order (to drop the oldest) and in sorted order, so a
 * percentile is one read. Sorting a copy on every read cost about 9 s of blocked event loop to replay
 * 24 h of minute records for 32 hosts, and 13–15 ms a second for realtime samples, which read without
 * adding. A push is two binary searches and two moves of at most `size` values.
 */
export class SortedWindow {
  private readonly ring: Float64Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size <= 0) throw new Error("Window size must be a positive integer");
    this.ring = new Float64Array(size);
    this.sorted = new Float64Array(size);
  }

  get length(): number {
    return this.count;
  }

  /**
   * Adds `value`, dropping the oldest once full. Non-finite values count as 0, which keeps the sorted
   * order valid: a hub record can still produce one (`1e999` parses as Infinity, and two huge rates can
   * sum to it), where sorting a copy kept Infinity and made the reference infinite.
   */
  push(value: number): void {
    const v = Number.isFinite(value) ? value : 0;
    const { ring, sorted } = this;
    if (this.count === this.size) {
      // Remove the oldest value's copy from the sorted run; any equal copy will do.
      const old = ring[this.head];
      const at = lowerBound(sorted, this.count, old);
      sorted.copyWithin(at, at + 1, this.count);
      this.count--;
    }
    ring[this.head] = v;
    this.head = (this.head + 1) % this.size;
    const at = lowerBound(sorted, this.count, v);
    sorted.copyWithin(at + 1, at, this.count);
    sorted[at] = v;
    this.count++;
  }

  /** The value at fraction `p` of the sorted window, as `percentile` picks it; 0 when empty. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    return this.sorted[Math.min(this.count - 1, Math.floor(p * this.count))];
  }
}

/** First index in `sorted[0, length)` whose value is not below `value`. */
function lowerBound(sorted: Float64Array, length: number, value: number): number {
  let low = 0, high = length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The value at fraction `p` of `values` sorted, by sorting a copy; the reference `SortedWindow` matches. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function clamp01(value: number): number {
  // NaN counts as 0; ±Infinity clamps like any other number.
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
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

/**
 * Turns a sample into 0..1 features. `previous` is the host's previous sample, for change-based ones.
 *
 * Changes are linear fractions of the reference, not differences on the log scale: the log scale
 * magnifies the low end, so an idle host's trickle going from 1 to 4 KiB/s would read as a large change.
 */
export function computeFeatures(sample: Sample, baseline: Baseline, threads: number, previous: Sample | null): Features {
  const netRef = baseline.netReference();
  const diskRef = baseline.diskReference();
  const total = sample.tx + sample.rx;
  const diskTotal = sample.diskRead + sample.diskWrite;
  const net = logRatio(total, netRef);
  const prevTotal = previous ? previous.tx + previous.rx : total;
  const prevDisk = previous ? previous.diskRead + previous.diskWrite : diskTotal;
  // Peaks exist only in Beszel's aggregated tiers; `1m` records leave them out, so rises since the
  // previous sample count as bursts too.
  const cpuRise = previous ? sample.cpu - previous.cpu : 0;
  const cpuBurst = clamp01(Math.max(sample.cpuPeak - sample.cpu, cpuRise) / 50);
  const netBurst = clamp01(Math.max(logRatio(sample.txPeak + sample.rxPeak, netRef) - net, (total - prevTotal) / netRef));
  return {
    cpu: clamp01(sample.cpu / 100),
    mem: clamp01(sample.mem / 100),
    net,
    netChange: clamp01(Math.abs(total - prevTotal) / netRef),
    disk: logRatio(diskTotal, diskRef),
    diskChange: clamp01(Math.abs(diskTotal - prevDisk) / diskRef),
    load: clamp01(sample.load1 / Math.max(threads, 1)),
    burst: Math.max(cpuBurst, netBurst),
    // 0.5 when idle, so direction only matters once there is traffic.
    txShare: total > 1024 ? sample.tx / total : 0.5,
    temp: sample.tempMax === null ? 0.5 : clamp01((sample.tempMax - 30) / 60),
  };
}
