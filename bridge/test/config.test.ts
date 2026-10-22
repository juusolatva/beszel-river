import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = { BESZEL_EMAIL: "bridge@example.com", BESZEL_PASSWORD: "secret", STREAM_SALT: "a-long-enough-salt" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toEqual({
      beszelUrl: "http://127.0.0.1:8090",
      email: "bridge@example.com",
      password: "secret",
      source: "systems",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      salt: "a-long-enough-salt",
      mixFile: "mix.json",
    });
  });

  it("lists every problem at once", () => {
    expect(() => loadConfig({ BIND_PORT: "99999", STREAM_SALT: "short" })).toThrow(
      /BIND_PORT must be 1-65535[\s\S]*STREAM_SALT must be at least 16[\s\S]*BESZEL_EMAIL is required[\s\S]*BESZEL_PASSWORD is required/,
    );
  });

  it("rejects the realtime source until M6 and unknown sources", () => {
    expect(() => loadConfig({ ...valid, SOURCE: "realtime" })).toThrow(/not implemented yet/);
    expect(() => loadConfig({ ...valid, SOURCE: "carrier-pigeon" })).toThrow(/SOURCE must be/);
  });

  it("rejects an invalid URL", () => {
    expect(() => loadConfig({ ...valid, BESZEL_URL: "not a url" })).toThrow(/BESZEL_URL is not a URL/);
  });
});
