import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeszelClient } from "../src/beszel/client.js";
import { log } from "../src/log.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

const REFRESH_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const URL = "http://localhost:8090";

describe("BeszelClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs in with a password", async () => {
    const client = new BeszelClient(URL, { kind: "password", email: "bridge@example.com", password: "pw" });
    const authWithPassword = vi.fn().mockResolvedValue({});
    client.pb.collection = vi.fn().mockReturnValue({ authWithPassword });
    await client.login();
    expect(authWithPassword).toHaveBeenCalledWith("bridge@example.com", "pw");
    expect(log).toHaveBeenCalledWith("info", `Logged in to Beszel at ${URL} as bridge@example.com`);
  });

  it("checks a token, and warns only when it expires within two weeks", async () => {
    const check = async (expiresInDays: number): Promise<boolean> => {
      vi.mocked(log).mockClear();
      const expires = new Date(Date.now() + expiresInDays * DAY_MS);
      const client = new BeszelClient(URL, { kind: "token", token: "jwt", expires });
      const authRefresh = vi.fn().mockResolvedValue({ record: { email: "bridge@example.com" } });
      client.pb.collection = vi.fn().mockReturnValue({ authRefresh });
      await client.login();
      expect(client.pb.authStore.token).toBe("jwt");
      expect(authRefresh).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("info", expect.stringContaining(`Using a token for bridge@example.com at ${URL}`));
      return vi.mocked(log).mock.calls.some(([level]) => level === "warn");
    };
    expect(await check(30)).toBe(false);
    expect(await check(13)).toBe(true);
  });

  it("warns on every refresh once the token is close to expiry", async () => {
    const client = new BeszelClient(URL, { kind: "token", token: "jwt", expires: new Date(Date.now() + 15 * DAY_MS) });
    client.pb.collection = vi.fn().mockReturnValue({ authRefresh: vi.fn().mockResolvedValue({}) });
    client.keepAlive();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(log).not.toHaveBeenCalledWith("warn", expect.anything());
    await vi.advanceTimersByTimeAsync(4 * 2 * REFRESH_MS);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("BESZEL_TOKEN expires on"));
    await client.close();
  });

  it("logs in again when token refresh fails, and clears the auth store when re-login also fails", async () => {
    const validJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: (Date.now() + 30 * DAY_MS) / 1000 })).toString("base64url")}.sig`;
    const client = new BeszelClient(URL, { kind: "password", email: "bridge@example.com", password: "pw" });
    const authRefresh = vi.fn().mockRejectedValue(new Error("authRefresh failed"));
    const authWithPassword = vi
      .fn()
      .mockImplementationOnce(async () => {
        client.pb.authStore.save(validJwt, null);
        return {};
      })
      .mockRejectedValueOnce(new Error("login failed"));
    client.pb.collection = vi.fn().mockReturnValue({ authRefresh, authWithPassword });

    client.keepAlive();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(authRefresh).toHaveBeenCalledTimes(1);
    expect(authWithPassword).toHaveBeenCalledWith("bridge@example.com", "pw");
    expect(client.pb.authStore.isValid).toBe(true);

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(log).toHaveBeenCalledWith("warn", "Token refresh failed, logging in again", expect.any(Error));
    expect(log).toHaveBeenCalledWith("error", "Login failed", expect.any(Error));
    expect(client.pb.authStore.token).toBe("");
    expect(client.rt.authStore.token).toBe("");
    expect(client.pb.authStore.isValid).toBe(false);
    await client.close();
  });

  it("clears a saved token when its startup or refresh check is rejected", async () => {
    const validJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: (Date.now() + 30 * DAY_MS) / 1000 })).toString("base64url")}.sig`;
    const client = new BeszelClient(URL, { kind: "token", token: validJwt, expires: new Date(Date.now() + 30 * DAY_MS) });
    client.pb.collection = vi.fn().mockReturnValue({ authRefresh: vi.fn().mockRejectedValue(new Error("401")) });
    await expect(client.login()).rejects.toThrow("401");
    expect(client.pb.authStore.token).toBe("");
    expect(client.pb.authStore.isValid).toBe(false);
  });

  it("restarts the refresh timer instead of adding one, and stops it on close", async () => {
    const client = new BeszelClient(URL, { kind: "password", email: "bridge@example.com", password: "pw" });
    const authRefresh = vi.fn().mockResolvedValue({});
    client.pb.collection = vi.fn().mockReturnValue({ authRefresh });
    client.keepAlive();
    client.keepAlive();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(authRefresh).toHaveBeenCalledOnce();
    await client.close();
    await vi.advanceTimersByTimeAsync(2 * REFRESH_MS);
    expect(authRefresh).toHaveBeenCalledOnce();
  });

  it("shares the login with the realtime client", () => {
    const client = new BeszelClient(URL, { kind: "password", email: "bridge@example.com", password: "pw" });
    client.pb.authStore.save("token-1", null);
    expect(client.rt.authStore.token).toBe("token-1");
    expect(client.connected).toBe(false);
  });

  it("closes both realtime connections even when unsubscribing fails", async () => {
    const client = new BeszelClient(URL, { kind: "password", email: "bridge@example.com", password: "pw" });
    const pbUnsubscribe = vi.spyOn(client.pb.realtime, "unsubscribe").mockRejectedValue(new Error("gone"));
    const rtUnsubscribe = vi.spyOn(client.rt.realtime, "unsubscribe").mockResolvedValue(undefined);
    await expect(client.close()).resolves.toBeUndefined();
    expect(pbUnsubscribe).toHaveBeenCalledOnce();
    expect(rtUnsubscribe).toHaveBeenCalledOnce();
  });
});
