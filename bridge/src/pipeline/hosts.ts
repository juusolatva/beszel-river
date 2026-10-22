import type { Frame, Stream } from "@beszel-river/shared";
import type { SystemInfo, SystemRecord, SystemStatsRecord, SystemStatus } from "../beszel/types.js";
import { bandOrder, bandWidths, streamId } from "./anonymize.js";
import { Baseline, computeFeatures, sampleFromInfo, sampleFromStats, type Features, type Sample } from "./features.js";
import { MIXED, Mixer, type MixConfig } from "./mix.js";

interface Host {
  systemId: string;
  streamId: string;
  status: SystemStatus;
  /** Null until known; Beszel zero-fills `info` for hosts it cannot reach. */
  threads: number | null;
  info: SystemInfo | null;
  baseline: Baseline;
  mixer: Mixer;
  features: Features | null;
  /** Time of the last mixed `system_stats` sample, ms. */
  sampledAt: number | null;
}

/** Assumed gap before a host's first sample, seconds; Beszel samples once a minute. */
const FIRST_SAMPLE_DT = 60;

/** Every known host's pipeline state; turns it into frames. */
export class HostTable {
  private readonly hosts = new Map<string, Host>();

  constructor(
    private readonly salt: string,
    private readonly mix: MixConfig,
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
        mixer: new Mixer(this.mix),
        features: null,
        sampledAt: null,
      });
      return true;
    }
    const changed = host.status !== record.status || host.threads !== threads;
    host.status = record.status;
    host.threads = threads;
    host.info = record.info ?? host.info;
    return changed;
  }

  removeSystem(systemId: string): boolean {
    return this.hosts.delete(systemId);
  }

  /** Mixes in a `system_stats` record; records older than the host's last one are ignored. */
  addStats(record: SystemStatsRecord): boolean {
    const host = this.hosts.get(record.system);
    if (!host) return false;
    const at = Date.parse(record.created.replace(" ", "T"));
    if (!Number.isFinite(at) || (host.sampledAt !== null && at <= host.sampledAt)) return false;
    this.mixSample(host, sampleFromStats(record.stats), host.sampledAt === null ? FIRST_SAMPLE_DT : (at - host.sampledAt) / 1000);
    host.sampledAt = at;
    return host.status !== "paused";
  }

  /** Lets pulses fade; returns whether any visible stream changed. */
  decay(dt: number): boolean {
    let changed = false;
    for (const host of this.hosts.values()) {
      if (host.mixer.decay(dt) && host.status !== "paused") changed = true;
    }
    return changed;
  }

  /** Paused hosts are left out; the rest are anonymized and ordered for the day. */
  frame(now: Date): Frame {
    const visible = [...this.hosts.values()].filter((h) => h.status !== "paused");
    for (const host of visible) {
      // Until a host's first `system_stats` record, its `info` summary stands in.
      if (!host.features && host.info) this.mixSample(host, sampleFromInfo(host.info), FIRST_SAMPLE_DT);
    }
    const widths = bandWidths(new Map(visible.flatMap((h) => (h.threads ? [[h.systemId, h.threads] as const] : []))));
    const byId = new Map(visible.map((h) => [h.systemId, h]));
    const streams = bandOrder(this.salt, [...byId.keys()], now).map((systemId): Stream => {
      const host = byId.get(systemId) as Host;
      const stream: Stream = { id: host.streamId, alive: host.status === "up", width: widths.get(systemId) ?? 0.5, flow: 0, density: 0, turbulence: 0, pulse: 0, heat: 0.5 };
      // Three decimals is plenty for the visuals and keeps raw precision out of the payload.
      for (const channel of MIXED) stream[channel] = Math.round(host.mixer.values[channel] * 1000) / 1000;
      return stream;
    });
    return { v: 1, t: now.getTime(), streams };
  }

  private mixSample(host: Host, sample: Sample, dt: number): void {
    host.baseline.add(sample);
    const features = computeFeatures(sample, host.baseline, host.threads ?? 1, host.features);
    host.mixer.apply(features, dt);
    host.features = features;
  }
}
