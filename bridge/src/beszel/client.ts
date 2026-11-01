import { EventSource } from "eventsource";
import PocketBase from "pocketbase";
import type { BeszelAuth } from "../config.js";
import { log } from "../log.js";

// The SDK's realtime client uses the browser's EventSource; Node needs the polyfill.
(globalThis as { EventSource?: unknown }).EventSource ??= EventSource;

const REFRESH_MS = 6 * 60 * 60 * 1000;
/** Token mode warns on every refresh once the token has less than this left. */
const TOKEN_WARN_MS = 14 * 24 * 60 * 60 * 1000;

/** PocketBase client logged in as the bridge's Beszel user. */
export class BeszelClient {
  readonly pb: PocketBase;
  /**
   * Second client with the same login and its own realtime connection, for `rt_metrics`. The SDK
   * resends every topic of a connection on each change, and the hub rejects the whole set if one
   * `rt_metrics` target is refused, so keeping them apart protects the `systems` subscriptions.
   */
  readonly rt: PocketBase;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    url: string,
    private readonly auth: BeszelAuth,
  ) {
    this.pb = new PocketBase(url);
    this.rt = new PocketBase(url);
    // The bridge runs overlapping requests on purpose; the SDK would otherwise cancel duplicates.
    this.pb.autoCancellation(false);
    this.rt.autoCancellation(false);
    this.pb.authStore.onChange((token, record) => this.rt.authStore.save(token, record));
  }

  get connected(): boolean {
    return this.pb.authStore.isValid && this.pb.realtime.isConnected;
  }

  async login(): Promise<void> {
    try {
      if (this.auth.kind === "password") {
        await this.pb.collection("users").authWithPassword(this.auth.email, this.auth.password);
        log("info", `Logged in to Beszel at ${this.pb.baseURL} as ${this.auth.email}`);
        return;
      }
      // Impersonation tokens are not refreshable: auth-refresh only checks them and returns the same token.
      this.pb.authStore.save(this.auth.token);
      const { record } = await this.pb.collection("users").authRefresh();
      log("info", `Using a token for ${record.email} at ${this.pb.baseURL}, valid until ${this.auth.expires.toISOString()}`);
      this.warnIfExpiring();
    } catch (error) {
      // The SDK leaves a rejected or previous token in the store, where isValid only checks exp.
      this.pb.authStore.clear();
      throw error;
    }
  }

  /** Renews the token periodically, logging in again if renewal fails. Realtime reconnects use the new token. */
  keepAlive(): void {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    await Promise.all([this.pb.realtime.unsubscribe().catch(() => undefined), this.rt.realtime.unsubscribe().catch(() => undefined)]);
  }

  private warnIfExpiring(): void {
    if (this.auth.kind === "token" && this.auth.expires.getTime() - Date.now() < TOKEN_WARN_MS) {
      log("warn", `BESZEL_TOKEN expires on ${this.auth.expires.toISOString()}; create a new one`);
    }
  }

  private async refresh(): Promise<void> {
    this.warnIfExpiring();
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
