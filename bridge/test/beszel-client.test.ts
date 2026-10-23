import { describe, it, expect, vi, beforeEach } from "vitest";
import { BeszelClient } from "../src/beszel/client.js";

vi.mock("../src/log.js", () => ({ log: vi.fn() }));

describe("BeszelClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("refresh fallback", () => {
    it("calls login when authRefresh fails", async () => {
      const client = new BeszelClient("http://localhost:8090", { kind: "password", email: "test@example.com", password: "password" });

      const authRefreshMock = vi.fn().mockRejectedValue(new Error("authRefresh failed"));
      const loginSpy = vi.spyOn(client, "login").mockResolvedValue();

      // Access the inner pb collection mock
      client.pb.collection = vi.fn().mockReturnValue({ authRefresh: authRefreshMock });

      // Call the private refresh method
      await (client as any).refresh();

      expect(authRefreshMock).toHaveBeenCalled();
      expect(loginSpy).toHaveBeenCalled();
    });

    it("logs error when login also fails", async () => {
      const { log } = await import("../src/log.js");
      const client = new BeszelClient("http://localhost:8090", { kind: "password", email: "test@example.com", password: "password" });

      const authRefreshMock = vi.fn().mockRejectedValue(new Error("authRefresh failed"));
      const loginSpy = vi.spyOn(client, "login").mockRejectedValue(new Error("login failed"));

      client.pb.collection = vi.fn().mockReturnValue({ authRefresh: authRefreshMock });

      await (client as any).refresh();

      expect(authRefreshMock).toHaveBeenCalled();
      expect(loginSpy).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("warn", "Token refresh failed, logging in again", expect.any(Error));
      expect(log).toHaveBeenCalledWith("error", "Login failed", expect.any(Error));
    });
  });
});
