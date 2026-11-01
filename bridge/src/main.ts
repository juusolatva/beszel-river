import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BeszelClient } from "./beszel/client.js";
import { RealtimeSource } from "./beszel/realtime-source.js";
import { SystemsSource } from "./beszel/systems-source.js";
import { loadConfig, type Config } from "./config.js";
import { log } from "./log.js";
import { HostTable } from "./pipeline/hosts.js";
import { loadMixConfig, TICK_S } from "./pipeline/mix.js";
import { StreamServer } from "./server.js";
import { UpstreamWatch } from "./upstream.js";

const BROADCAST_DEBOUNCE_MS = 250;
/** Realtime subscriptions outlast the last viewer by this long, so a reload does not restart them. */
const REALTIME_LINGER_MS = 30_000;

if (existsSync(".env")) process.loadEnvFile(".env");
let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  log("error", (error as Error).message);
  process.exit(1);
}
for (const secret of ["BESZEL_PASSWORD", "BESZEL_TOKEN", "STREAM_SALT"]) delete process.env[secret];

const hosts = new HostTable(config.salt, loadMixConfig(config.mixFile));
const client = new BeszelClient(config.beszelUrl, config.auth);
let live = false;
const upstream = new UpstreamWatch(() => client.connected);
client.pb.realtime.onDisconnect = (subscriptions) => {
  if (live && subscriptions.length > 0) upstream.markDisconnected();
};

const server = new StreamServer({
  host: config.bindHost,
  port: config.bindPort,
  snapshot: () => hosts.frame(new Date()),
  healthy: () => live && client.connected,
  onClients: viewersChanged,
});

// Beszel updates every host within a second or two of each other; one frame covers the batch.
let pending: NodeJS.Timeout | undefined;
function changed(didChange: boolean): void {
  if (!didChange || !live || pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    server.broadcast(hosts.frame(new Date()));
  }, BROADCAST_DEBOUNCE_MS);
}

const source = new SystemsSource(client.pb, {
  system: (record) => {
    changed(hosts.upsertSystem(record));
    syncRealtime();
  },
  removed: (systemId) => {
    changed(hosts.removeSystem(systemId));
    syncRealtime();
  },
  history: (record) => changed(hosts.addHistory(record)),
  stats: (record) => changed(hosts.addStats(record)),
});

const realtime = config.source === "realtime" ? new RealtimeSource(client.rt, (systemId, stats) => changed(hosts.addRealtime(systemId, stats))) : null;
let lingerTimer: NodeJS.Timeout | undefined;

function viewersChanged(count: number): void {
  if (count > 0) {
    clearTimeout(lingerTimer);
    lingerTimer = undefined;
  } else {
    lingerTimer ??= setTimeout(() => {
      lingerTimer = undefined;
      syncRealtime();
    }, REALTIME_LINGER_MS);
  }
  syncRealtime();
}

/** With `SOURCE=realtime`, keeps one `rt_metrics` subscription per up host while anyone is watching. */
function syncRealtime(): void {
  const watched = server.clientCount > 0 || lingerTimer !== undefined;
  realtime?.sync(live && watched ? hosts.realtimeTargets() : []);
}

async function connect(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.login();
      await source.start();
      client.keepAlive();
      live = true;
      changed(true);
      syncRealtime();
      return;
    } catch (error) {
      await client.pb.realtime.unsubscribe().catch(() => undefined);
      const delay = Math.min(60, 5 * 2 ** attempt);
      log("error", `Connecting to Beszel failed, retrying in ${delay} s`, error);
      await sleep(delay * 1000);
    }
  }
}

const port = await server.listen();
log("info", `Listening on http://${config.bindHost}:${port} (GET /stream, GET /healthz), source ${config.source}`);
setInterval(() => {
  // The SDK reconnects on its own; until it does, or forever with an expired token, statuses are stale.
  if (live) {
    if (upstream.update()) {
      if (upstream.live) log("info", "Beszel connection is back");
      else log("warn", "Beszel connection lost; showing every stream as not alive until it is back");
      changed(hosts.setUpstream(upstream.live));
    }
    if (upstream.reconnected) {
      void source.refreshSystems().catch((error: unknown) => log("warn", "Refreshing systems failed, retrying", error));
    }
  }
  changed(hosts.tick(TICK_S));
}, TICK_S * 1000);
void connect();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log("info", `${signal} received, shutting down`);
    void Promise.all([server.close(), client.close()]).then(
      () => process.exit(0),
      (error: unknown) => {
        log("error", "Shutdown failed", error);
        process.exit(1);
      },
    );
  });
}
