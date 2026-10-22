import type PocketBase from "pocketbase";
import { log } from "../log.js";
import type { SystemRecord, SystemStatsRecord } from "./types.js";

const SYSTEM_FIELDS = "id,name,status,info";
const STATS_FIELDS = "id,system,type,created,stats";

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
  constructor(
    private readonly pb: PocketBase,
    private readonly handlers: SystemsHandlers,
  ) {}

  /** Loads hosts and the last `historyHours` of records, then streams live changes. */
  async start(historyHours = 24): Promise<void> {
    await this.pb.collection("systems").subscribe<SystemRecord>(
      "*",
      (event) => (event.action === "delete" ? this.handlers.removed(event.record.id) : this.handlers.system(event.record)),
      { fields: SYSTEM_FIELDS },
    );
    const systems = await this.pb.collection("systems").getFullList<SystemRecord>({ fields: SYSTEM_FIELDS });
    for (const system of systems) this.handlers.system(system);

    // Live records arriving while history loads are held back, so everything is handled in time order.
    let held: SystemStatsRecord[] | null = [];
    await this.pb.collection("system_stats").subscribe<SystemStatsRecord>(
      "*",
      (event) => {
        if (event.action !== "create") return;
        if (held) held.push(event.record);
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
    for (const record of history) this.handlers.history(record);
    const live = held.sort((a, b) => a.created.localeCompare(b.created));
    held = null;
    for (const record of live) this.handlers.stats(record);

    log("info", `Loaded ${systems.length} systems and ${history.length} history records`);
  }
}
