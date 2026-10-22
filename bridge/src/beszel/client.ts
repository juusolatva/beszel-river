import { EventSource } from "eventsource";
import PocketBase from "pocketbase";
import { log } from "../log.js";

// The SDK's realtime client uses the browser's EventSource; Node needs the polyfill.
(globalThis as { EventSource?: unknown }).EventSource ??= EventSource;

const REFRESH_MS = 6 * 60 * 60 * 1000;

/** PocketBase client logged in as the bridge's Beszel user. */
export class BeszelClient {
  readonly pb: PocketBase;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    url: string,
    private readonly email: string,
    private readonly password: string,
  ) {
    this.pb = new PocketBase(url);
    // The bridge runs overlapping requests on purpose; the SDK would otherwise cancel duplicates.
    this.pb.autoCancellation(false);
  }

  get connected(): boolean {
    return this.pb.authStore.isValid && this.pb.realtime.isConnected;
  }

  async login(): Promise<void> {
    await this.pb.collection("users").authWithPassword(this.email, this.password);
    log("info", `Logged in to Beszel at ${this.pb.baseURL} as ${this.email}`);
  }

  /** Renews the token periodically, logging in again if renewal fails. Realtime reconnects use the new token. */
  keepAlive(): void {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    await this.pb.realtime.unsubscribe().catch(() => undefined);
  }

  private async refresh(): Promise<void> {
    try {
      await this.pb.collection("users").authRefresh();
    } catch (error) {
      log("warn", "Token refresh failed, logging in again", error);
      try {
        await this.login();
      } catch (loginError) {
        log("error", "Login failed", loginError);
      }
    }
  }
}
