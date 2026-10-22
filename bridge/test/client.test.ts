import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeszelClient } from "../src/beszel/client.js";
import PocketBase from "pocketbase";
import { log } from "../src/log.js";

vi.mock("pocketbase", () => {
  const MockPocketBase = vi.fn();
  MockPocketBase.prototype.authStore = { onChange: vi.fn(), save: vi.fn(), isValid: true };
  MockPocketBase.prototype.realtime = { isConnected: true, unsubscribe: vi.fn().mockResolvedValue(undefined) };
  MockPocketBase.prototype.autoCancellation = vi.fn();
  MockPocketBase.prototype.collection = vi.fn();
  return { default: MockPocketBase };
});

vi.mock("../src/log.js", () => ({
  log: vi.fn()
}));

describe("BeszelClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to login when token refresh fails", async () => {
    const client = new BeszelClient("http://localhost", { kind: "password", email: "test@example.com", password: "password123" });

    const authRefresh = vi.fn().mockRejectedValue(new Error("Refresh failed"));
    const authWithPassword = vi.fn().mockResolvedValue(undefined);

    client.pb.collection = vi.fn().mockImplementation((name) => {
      if (name === "users") {
        return {
          authRefresh,
          authWithPassword
        };
      }
    });

    const loginSpy = vi.spyOn(client, "login");

    // Invoke the private refresh method directly to simulate interval trigger
    await (client as any).refresh();

    // Verify it attempted to refresh
    expect(authRefresh).toHaveBeenCalled();

    // Verify it fell back to login
    expect(loginSpy).toHaveBeenCalled();
    expect(authWithPassword).toHaveBeenCalledWith("test@example.com", "password123");

    // Verify appropriate warning was logged
    expect(log).toHaveBeenCalledWith("warn", "Token refresh failed, logging in again", expect.any(Error));
  });

  it("logs an error if login also fails during fallback", async () => {
    const client = new BeszelClient("http://localhost", { kind: "password", email: "test@example.com", password: "password123" });

    const authRefresh = vi.fn().mockRejectedValue(new Error("Refresh failed"));
    const authWithPassword = vi.fn().mockRejectedValue(new Error("Login failed too"));

    client.pb.collection = vi.fn().mockImplementation((name) => {
      if (name === "users") {
        return {
          authRefresh,
          authWithPassword
        };
      }
    });

    const loginSpy = vi.spyOn(client, "login");

    // Invoke the private refresh method
    await (client as any).refresh();

    // Verify it attempted to refresh
    expect(authRefresh).toHaveBeenCalled();

    // Verify it fell back to login
    expect(loginSpy).toHaveBeenCalled();
    expect(authWithPassword).toHaveBeenCalledWith("test@example.com", "password123");

    // Verify appropriate error was logged
    expect(log).toHaveBeenCalledWith("warn", "Token refresh failed, logging in again", expect.any(Error));
    expect(log).toHaveBeenCalledWith("error", "Login failed", expect.any(Error));
  });
});
