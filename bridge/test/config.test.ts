import { describe, expect, it } from "vitest";
import { loadConfig, tokenExpiry } from "../src/config.js";

const valid = { BESZEL_EMAIL: "bridge@example.com", BESZEL_PASSWORD: "secret", STREAM_SALT: "a-long-enough-salt" };
const now = new Date("2026-10-22T00:00:00Z");

/** Unsigned JWT with the given payload; the bridge only reads `exp`, the hub checks the signature. */
function jwt(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}
const inAYear = jwt({ type: "auth", refreshable: false, exp: Date.parse("2027-10-22T00:00:00Z") / 1000 });

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig(valid)).toEqual({
      beszelUrl: "http://127.0.0.1:8090",
      auth: { kind: "password", email: "bridge@example.com", password: "secret" },
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

  it("accepts the realtime source and rejects unknown ones", () => {
    expect(loadConfig({ ...valid, SOURCE: "realtime" }).source).toBe("realtime");
    expect(() => loadConfig({ ...valid, SOURCE: "carrier-pigeon" })).toThrow(/SOURCE must be/);
  });

  it("rejects an invalid URL", () => {
    expect(() => loadConfig({ ...valid, BESZEL_URL: "not a url" })).toThrow(/BESZEL_URL is not a URL/);
  });

  it("uses BESZEL_TOKEN instead of email and password", () => {
    const config = loadConfig({ STREAM_SALT: valid.STREAM_SALT, BESZEL_TOKEN: ` ${inAYear} ` }, now);
    expect(config.auth).toEqual({ kind: "token", token: inAYear, expires: new Date("2027-10-22T00:00:00Z") });
  });

  it("rejects a token together with a password, a malformed token and an expired token", () => {
    expect(() => loadConfig({ ...valid, BESZEL_TOKEN: inAYear }, now)).toThrow(/either BESZEL_TOKEN or BESZEL_EMAIL/);
    expect(() => loadConfig({ STREAM_SALT: valid.STREAM_SALT, BESZEL_TOKEN: "not-a-token" }, now)).toThrow(/not a PocketBase auth token/);
    const expired = jwt({ exp: Date.parse("2026-10-21T00:00:00Z") / 1000 });
    expect(() => loadConfig({ STREAM_SALT: valid.STREAM_SALT, BESZEL_TOKEN: expired }, now)).toThrow(/expired on 2026-10-21T00:00:00.000Z/);
  });
});

describe("tokenExpiry", () => {
  it("reads exp and returns null for anything that is not a JWT with a numeric exp", () => {
    expect(tokenExpiry(jwt({ exp: 1_800_000_000 }))).toEqual(new Date(1_800_000_000_000));
    expect(tokenExpiry("a.b")).toBeNull();
    expect(tokenExpiry("a.%%%.c")).toBeNull();
    expect(tokenExpiry(jwt({ exp: "soon" }))).toBeNull();
    expect(tokenExpiry(`x.${Buffer.from("null").toString("base64url")}.y`)).toBeNull();
  });
});
