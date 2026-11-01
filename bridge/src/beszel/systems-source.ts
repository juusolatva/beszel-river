import type PocketBase from "pocketbase";
import { log } from "../log.js";
import type { SystemRecord, SystemStatsRecord } from "./types.js";

// No `name`: hostnames have no use here, so they are not fetched at all.
const SYSTEM_FIELDS = "id,status,info";
const STATS_FIELDS = "id,system,type,created,stats";
const REFRESH_RETRY_MS = 5_000;

export interface SystemsHandlers {
  system(record: SystemRecord): void;
  removed(systemId: string): void;
  /** Called in time order with the records loaded at startup, before any live ones. */
  history(record: SystemStatsRecord): void;
  /** Called in time order with live records. */
  stats(record: SystemStatsRecord): void;
}

/**
 * The `systems` adapter: host list and status from `systems`, metrics from the `1m` records Beszel
 * writes to `system_stats` on every update (once a minute per host).
 */
export class SystemsSource {
  private readonly knownSystems = new Set<string>();
  private heldSystems: { action: string; record: SystemRecord }[] | null = null;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pb: PocketBase,
    private readonly handlers: SystemsHandlers,
  ) {}

  /** Loads hosts and the last `historyHours` of records, then streams live changes. */
  async start(historyHours = 24): Promise<void> {
    // Changes arriving while the initial lists load are held back, so a /stream snapshot mid-load
    // cannot seed hosts from `info` before their 24 h history is applied.
    this.heldSystems = [];
    await this.pb.collection("systems").subscribe<SystemRecord>(
      "*",
      (event) => (this.heldSystems ? this.heldSystems.push(event) : this.onSystem(event)),
      { fields: SYSTEM_FIELDS },
    );
    const systems = await this.pb.collection("systems").getFullList<SystemRecord>({ fields: SYSTEM_FIELDS });

    let heldStats: SystemStatsRecord[] | null = [];
    await this.pb.collection("system_stats").subscribe<SystemStatsRecord>(
      "*",
      (event) => {
        if (event.action !== "create") return;
        if (heldStats) heldStats.push(event.record);
        else this.handlers.stats(event.record);
      },
      { filter: 'type = "1m"', fields: STATS_FIELDS },
    );
    const since = new Date(Date.now() - historyHours * 60 * 60 * 1000);
    const history = await this.pb.collection("system_stats").getFullList<SystemStatsRecord>({
      filter: this.pb.filter("type = '1m' && created >= {:since}", { since }),
      sort: "created",
      fields: STATS_FIELDS,
      batch: 1000,
    });
    this.applySystems(systems);
    for (const record of history) this.handlers.history(record);
    const live = heldStats.toSorted((a, b) => a.created.localeCompare(b.created));
    heldStats = null;
    for (const record of live) this.handlers.stats(record);

    log("info", `Loaded ${systems.length} systems and ${history.length} history records`);
  }

  /** Re-reads the `systems` list so hosts paused or deleted during an outage do not linger; retries on failure. */
  async refreshSystems(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.heldSystems) return;
    this.heldSystems = [];
    let systems: SystemRecord[];
    try {
      systems = await this.pb.collection("systems").getFullList<SystemRecord>({ fields: SYSTEM_FIELDS });
    } catch (error) {
      this.flushHeldSystems();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.refreshSystems().catch((retryError: unknown) => log("warn", "Refreshing systems failed, retrying", retryError));
      }, REFRESH_RETRY_MS);
      throw error;
    }
    this.applySystems(systems);
  }

  private applySystems(systems: readonly SystemRecord[]): void {
    const current = new Set(systems.map((s) => s.id));
    for (const id of this.knownSystems) {
      if (!current.has(id)) {
        this.knownSystems.delete(id);
        this.handlers.removed(id);
      }
    }
    for (const system of systems) {
      this.knownSystems.add(system.id);
      this.handlers.system(system);
    }
    this.flushHeldSystems();
  }

  private flushHeldSystems(): void {
    const events = this.heldSystems ?? [];
    this.heldSystems = null;
    for (const event of events) this.onSystem(event);
  }

  private onSystem(event: { action: string; record: SystemRecord }): void {
    if (event.action === "delete") {
      this.knownSystems.delete(event.record.id);
      this.handlers.removed(event.record.id);
    } else {
      this.knownSystems.add(event.record.id);
      this.handlers.system(event.record);
    }
  }
}
