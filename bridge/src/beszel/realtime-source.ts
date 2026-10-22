import type PocketBase from "pocketbase";
import type { UnsubscribeFunc } from "pocketbase";
import { log } from "../log.js";
import type { RealtimeData, SystemStats } from "./types.js";

const TOPIC = "rt_metrics";
/** A refused system is tried again after this long, ms. */
const RETRY_MS = 60_000;

/** The SDK's key for a topic with options; needed to drop a subscription the hub refused. */
function topicKey(systemId: string): string {
  return `${TOPIC}?options=${encodeURIComponent(JSON.stringify({ query: { system: systemId } }))}`;
}

/**
 * The `realtime` adapter's 1 s layer, on top of `SystemsSource`: one `rt_metrics` subscription per
 * system passed to `sync`. While a system is subscribed, the hub fetches from its agent every second.
 */
export class RealtimeSource {
  /** Subscribed or queued systems; resolves to null when the hub refused the subscription. */
  private readonly subscriptions = new Map<string, Promise<UnsubscribeFunc | null>>();
  /** Refused systems and when they were last tried, ms. */
  private readonly refused = new Map<string, number>();
  /**
   * Subscription changes run one at a time. The SDK sends all topics of a connection with every change
   * and the hub refuses the whole set if one target is refused, so only this tells which one it was.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly pb: PocketBase,
    private readonly onStats: (systemId: string, stats: SystemStats) => void,
  ) {}

  /** Subscribes to exactly these systems, unsubscribing the rest. */
  sync(systemIds: readonly string[], now = Date.now()): void {
    const wanted = new Set(systemIds);
    const before = this.subscriptions.size;
    for (const [systemId, pending] of this.subscriptions) {
      if (wanted.has(systemId)) continue;
      this.subscriptions.delete(systemId);
      void this.enqueue(async () => (await pending)?.()).catch((error: unknown) => log("warn", "Realtime unsubscribe failed", error));
    }
    for (const systemId of wanted) {
      const triedAt = this.refused.get(systemId);
      if (this.subscriptions.has(systemId) || (triedAt !== undefined && now - triedAt < RETRY_MS)) continue;
      const pending = this.enqueue(() => this.subscribe(systemId)).then((unsubscribe) => {
        if (!unsubscribe && this.subscriptions.get(systemId) === pending) this.subscriptions.delete(systemId);
        return unsubscribe;
      });
      this.subscriptions.set(systemId, pending);
    }
    const after = this.subscriptions.size;
    if (before === 0 && after > 0) log("info", `Realtime metrics on for ${after} system${after === 1 ? "" : "s"}`);
    else if (before > 0 && after === 0) log("info", "Realtime metrics off");
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async subscribe(systemId: string): Promise<UnsubscribeFunc | null> {
    try {
      const unsubscribe = await this.pb.realtime.subscribe(
        TOPIC,
        (data: RealtimeData) => {
          if (data.stats) this.onStats(systemId, data.stats);
        },
        { query: { system: systemId } },
      );
      this.refused.delete(systemId);
      return unsubscribe;
    } catch (error) {
      // The SDK keeps a refused topic and would resend it with every later change, failing them all.
      await this.pb.realtime.unsubscribeByPrefix(topicKey(systemId)).catch(() => undefined);
      if (!this.refused.has(systemId)) log("warn", `Realtime subscription refused, retrying every ${RETRY_MS / 1000} s`, error);
      this.refused.set(systemId, Date.now());
      return null;
    }
  }
}
