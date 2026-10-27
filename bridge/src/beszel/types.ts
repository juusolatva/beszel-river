// The parts of Beszel's PocketBase records the bridge reads. Field names follow Beszel's
// internal/entities/system/system.go; all of them are optional because agents of different
// versions send different subsets, and Beszel renames fields between minor releases.

export type SystemStatus = "up" | "down" | "paused" | "pending";

/** `systems` record. */
export interface SystemRecord {
  id: string;
  status: SystemStatus;
  info: SystemInfo | null;
}

/** `systems.info`: latest summary, refreshed on every update. */
export interface SystemInfo {
  /** CPU %. */
  cpu?: number;
  /** Memory %. */
  mp?: number;
  /** Network sent + received, bytes/s. */
  bb?: number;
  /** Load averages [1, 5, 15 min]. */
  la?: number[];
  /** Thread count. */
  t?: number;
  /** Dashboard temperature, °C. */
  dt?: number;
}

/** `system_stats` record; the bridge only reads `type = "1m"`. */
export interface SystemStatsRecord {
  id: string;
  system: string;
  type: string;
  created: string;
  stats: SystemStats;
}

/** `system_stats.stats`: one minute of readings; `rt_metrics` sends the same object every second. */
export interface SystemStats {
  /** CPU %, average and peak. */
  cpu?: number;
  cpum?: number;
  /** Memory %. */
  mp?: number;
  /** Network [sent, received], bytes/s, average and peak. */
  b?: [number, number];
  bm?: [number, number];
  /** Network sent / received, MB/s (agents before `b` existed). */
  ns?: number;
  nr?: number;
  /** Disk I/O [read, write], bytes/s. */
  dio?: [number, number];
  /** Disk read / write, MB/s (agents before 0.13.0). */
  dr?: number;
  dw?: number;
  /** Load averages [1, 5, 15 min]. */
  la?: number[];
  /** Temperatures by sensor, °C. */
  t?: Record<string, number>;
  /** Busy % per core, in core order. */
  cpus?: number[];
}

/** `rt_metrics` message: what the hub fetches from the agent every second while subscribed. */
export interface RealtimeData {
  /** Same fields as `system_stats.stats`, without the peaks the hub adds when aggregating. */
  stats?: SystemStats;
}
