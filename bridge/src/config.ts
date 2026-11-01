/** How the bridge authenticates to the hub. */
export type BeszelAuth =
  | { kind: "password"; email: string; password: string }
  /** Impersonation token minted by a superuser; for hubs with password auth disabled (OIDC only). */
  | { kind: "token"; token: string; expires: Date };

export interface Config {
  beszelUrl: string;
  auth: BeszelAuth;
  /** `realtime` adds 1 s `rt_metrics` samples on top of `systems` while viewers are connected. */
  source: "systems" | "realtime";
  bindHost: string;
  bindPort: number;
  salt: string;
  /** Mixing weights; see `mix.example.json`. */
  mixFile: string;
}

/** Reads and validates the environment; throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv, now = new Date()): Config {
  const errors: string[] = [];
  const value = (name: string, fallback?: string): string => {
    const v = env[name]?.trim() || fallback;
    if (v === undefined) errors.push(`${name} is required`);
    return v ?? "";
  };

  const beszelUrl = value("BESZEL_URL", "http://127.0.0.1:8090");
  const url = URL.parse(beszelUrl);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    // Never echo a malformed address: it may contain credentials.
    errors.push("BESZEL_URL must be an http: or https: URL without embedded credentials");
  }

  const source = value("SOURCE", "systems");
  if (source !== "systems" && source !== "realtime") errors.push(`SOURCE must be "systems" or "realtime", got "${source}"`);

  const port = Number(value("BIND_PORT", "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`BIND_PORT must be 1-65535, got "${env.BIND_PORT}"`);

  const salt = value("STREAM_SALT");
  if (salt && salt.length < 16) errors.push("STREAM_SALT must be at least 16 characters");

  const config: Config = {
    beszelUrl,
    auth: loadAuth(env, now, errors, value),
    source: source === "realtime" ? "realtime" : "systems",
    bindHost: value("BIND_HOST", "127.0.0.1"),
    bindPort: port,
    salt,
    mixFile: value("MIX_FILE", "mix.json"),
  };
  if (errors.length > 0) throw new Error(`Invalid configuration:\n  ${errors.join("\n  ")}`);
  return config;
}

function loadAuth(env: NodeJS.ProcessEnv, now: Date, errors: string[], value: (name: string) => string): BeszelAuth {
  const token = env.BESZEL_TOKEN?.trim();
  if (!token) return { kind: "password", email: value("BESZEL_EMAIL"), password: value("BESZEL_PASSWORD") };

  if (env.BESZEL_EMAIL?.trim() || env.BESZEL_PASSWORD?.trim()) {
    errors.push("Set either BESZEL_TOKEN or BESZEL_EMAIL and BESZEL_PASSWORD, not both");
  }
  const expires = tokenExpiry(token);
  if (!expires) errors.push("BESZEL_TOKEN is not a PocketBase auth token (JWT with an exp claim)");
  else if (expires <= now) errors.push(`BESZEL_TOKEN expired on ${expires.toISOString()}`);
  return { kind: "token", token, expires: expires ?? now };
}

/** Expiry of a JWT from its `exp` claim, or null when the value is not a JWT. The signature is the hub's to check. */
export function tokenExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    if (typeof exp !== "number") return null;
    const date = new Date(exp * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}
