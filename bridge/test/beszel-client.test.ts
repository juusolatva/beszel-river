import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeszelClient } from "../src/beszel/client.js";
import { log } from "../src/log.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

const REFRESH_MS = 6 * 60 * 60 * 1000;

describe("BeszelClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs in again when token refresh fails, and logs when re-login also fails", async () => {
    const client = new BeszelClient("http://localhost:8090", { kind: "password", email: "bridge@example.com", password: "pw" });
    const authRefresh = vi.fn().mockRejectedValue(new Error("authRefresh failed"));
    const authWithPassword = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("login failed"));
    client.pb.collection = vi.fn().mockReturnValue({ authRefresh, authWithPassword });

    client.keepAlive();
    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(authRefresh).toHaveBeenCalledTimes(1);
    expect(authWithPassword).toHaveBeenCalledWith("bridge@example.com", "pw");

    await vi.advanceTimersByTimeAsync(REFRESH_MS);
    expect(log).toHaveBeenCalledWith("warn", "Token refresh failed, logging in again", expect.any(Error));
    expect(log).toHaveBeenCalledWith("error", "Login failed", expect.any(Error));
    await client.close();
  });
});
