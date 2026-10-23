import type { Frame, Stream } from "@beszel-river/shared";
import type { SystemInfo, SystemRecord, SystemStats, SystemStatsRecord, SystemStatus } from "../beszel/types.js";
import { bandOrder, bandWidths, filamentOrder, streamId } from "./anonymize.js";
import { Baseline, computeFeatures, coreProfile, FILAMENTS, sampleFromInfo, sampleFromStats, type Sample } from "./features.js";
import { MIXED, Mixer, type MixConfig, type SampleKind } from "./mix.js";

interface Host {
  systemId: string;
  streamId: string;
  status: SystemStatus;
  /** Null until known; Beszel zero-fills `info` for hosts it cannot reach. */
  threads: number | null;
  info: SystemInfo | null;
  baseline: Baseline;
  mixer: Mixer;
  /** Latest mixed sample, for change-based features; null before the first one. */
  sample: Sample | null;
  /** Time of the last `system_stats` record, ms. */
  sampledAt: number | null;
  /** Arrival time of the last `rt_metrics` sample, ms. */
  realtimeAt: number | null;
  /** `sample` came from `rt_metrics`. */
  fromRealtime: boolean;
}

/** Assumed gap before a host's first sample, seconds; Beszel samples once a minute. */
const FIRST_SAMPLE_DT = 60;
/** Realtime samples older than this no longer count: the host falls back to its `system_stats` records. */
export const REALTIME_STALE_MS = 10_000;
/** Assumed gap before the first realtime sample of a run, seconds. */
const FIRST_REALTIME_DT = 1;

/** Secure random number generator [0, 1) to replace Math.random. */
function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

/** Every known host's pipeline state; turns it into frames. */
export class HostTable {
  private readonly hosts = new Map<string, Host>();

  constructor(
    private readonly salt: string,
    private readonly mix: MixConfig,
    /** Times and sizes of scattered pulses; injectable for tests. */
    private readonly random: () => number = secureRandom,
  ) {}

  /** Adds or updates a host from its `systems` record; returns whether the frame changed. */
  upsertSystem(record: SystemRecord): boolean {
    const host = this.hosts.get(record.id);
    const threads = record.info?.t || host?.threads || null;
    if (!host) {
      this.hosts.set(record.id, {
        systemId: record.id,
        streamId: streamId(this.salt, record.id),
        status: record.status,
        threads,
        info: record.info,
        baseline: new Baseline(),
        mixer: new Mixer(this.mix, this.random),
        sample: null,
        sampledAt: null,
        realtimeAt: null,
        fromRealtime: false,
      });
      return true;
    }
    const changed = host.status !== record.status || host.threads !== threads;
    // A stream that is drying up should not flash with pulses scattered from its last record.
    if (record.status !== "up") host.mixer.dropPulses();
    host.status = record.status;
    host.threads = threads;
    host.info = record.info ?? host.info;
    return changed;
  }

  removeSystem(systemId: string): boolean {
    return this.hosts.delete(systemId);
  }

  /** Hosts worth an `rt_metrics` subscription: the hub would poll the others' agents in vain. */
  realtimeTargets(): string[] {
    const targets: string[] = [];
    for (const host of this.hosts.values()) {
      if (host.status === "up") {
        targets.push(host.systemId);
      }
    }
    return targets;
  }

  /**
   * Adds a live `system_stats` record to the host's baseline, and mixes it in unless realtime samples are
   * arriving (`now` is the current time, ms). Its channels glide and its pulse is scattered over the
   * following minute. Records older than the host's last one are ignored.
   */
  addStats(record: SystemStatsRecord, now = Date.now()): boolean {
    return this.addRecord(record, "minute", now);
  }

  /** Like `addStats`, for records loaded at startup: they apply at once and without a pulse, which would be old news. */
  addHistory(record: SystemStatsRecord, now = Date.now()): boolean {
    return this.addRecord(record, "seed", now);
  }

  private addRecord(record: SystemStatsRecord, kind: SampleKind, now: number): boolean {
    const host = this.hosts.get(record.system);
    if (!host) return false;
    const at = Date.parse(record.created.replace(" ", "T"));
    if (!Number.isFinite(at) || (host.sampledAt !== null && at <= host.sampledAt)) return false;
    const sample = sampleFromStats(record.stats);
    const dt = host.sampledAt === null ? FIRST_SAMPLE_DT : (at - host.sampledAt) / 1000;
    host.sampledAt = at;
    host.baseline.add(sample);
    if (this.realtimeLive(host, now)) return false;
    // After realtime samples, a change from 1 s values to a minute's average is not a real change.
    this.mixSample(host, sample, dt, host.fromRealtime ? null : host.sample, kind, now);
    return host.status !== "paused";
  }

  /**
   * Mixes in an `rt_metrics` sample that arrived at `now` (ms). Realtime samples stay out of the
   * baseline: it holds 24 h of minute averages, which one sample per second would push out in 24 min.
   */
  addRealtime(systemId: string, stats: SystemStats, now = Date.now()): boolean {
    const host = this.hosts.get(systemId);
    if (!host || host.status === "paused") return false;
    const live = this.realtimeLive(host, now);
    const dt = live ? (now - (host.realtimeAt as number)) / 1000 : FIRST_REALTIME_DT;
    host.realtimeAt = now;
    this.mixSample(host, sampleFromStats(stats), dt, live && host.fromRealtime ? host.sample : null, "realtime", now);
    return true;
  }

  /** Advances every host's mixer to `now` (ms), see `Mixer.tick`; returns whether any visible stream changed. */
  tick(dt: number, now = Date.now()): boolean {
    let changed = false;
    for (const host of this.hosts.values()) {
      if (host.mixer.tick(dt, now) && host.status !== "paused") changed = true;
    }
    return changed;
  }

  /** Paused hosts are left out; the rest are anonymized and ordered for the day. */
  frame(now: Date): Frame {
    const threadCounts = new Map<string, number>();
    const systemIds: string[] = [];
    const byId = new Map<string, Host>();
    const timeMs = now.getTime();

    for (const host of this.hosts.values()) {
      if (host.status === "paused") continue;

      // Until a host's first `system_stats` record, its `info` summary stands in.
      if (!host.sample && host.info) {
        const sample = sampleFromInfo(host.info);
        host.baseline.add(sample);
        this.mixSample(host, sample, FIRST_SAMPLE_DT, null, "seed", timeMs);
      }

      if (host.threads) {
        threadCounts.set(host.systemId, host.threads);
      }
      systemIds.push(host.systemId);
      byId.set(host.systemId, host);
    }

    const widths = bandWidths(threadCounts);
    const order = bandOrder(this.salt, systemIds, now);
    const streams = order.map((systemId): Stream => {
      const host = byId.get(systemId) as Host;
      const stream: Stream = { id: host.streamId, alive: host.status === "up", width: widths.get(systemId) ?? 0.5, flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 };
      // Three decimals is plenty for the visuals and keeps raw precision out of the payload.
      for (const channel of MIXED) stream[channel] = round3(host.mixer.values[channel]);
      const filaments = host.mixer.filaments;
      if (filaments) stream.filaments = filamentOrder(this.salt, systemId, FILAMENTS, now).map((i) => round3(filaments[i]));
      return stream;
    });
    return { v: 1, t: timeMs, streams };
  }

  private realtimeLive(host: Host, now: number): boolean {
    return host.realtimeAt !== null && now - host.realtimeAt < REALTIME_STALE_MS;
  }

  /** `previous` is the sample that change-based features compare against, or null for none; `now` is in ms. */
  private mixSample(host: Host, sample: Sample, dt: number, previous: Sample | null, kind: SampleKind, now: number): void {
    host.mixer.apply(computeFeatures(sample, host.baseline, host.threads ?? 1, previous), coreProfile(sample.cores), dt, kind, now);
    host.sample = sample;
    host.fromRealtime = kind === "realtime";
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
