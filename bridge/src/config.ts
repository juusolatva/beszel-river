export interface Config {
  beszelUrl: string;
  email: string;
  password: string;
  source: "systems";
  bindHost: string;
  bindPort: number;
  salt: string;
  /** Mixing weights; see `mix.example.json`. */
  mixFile: string;
}

/** Reads and validates the environment; throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const errors: string[] = [];
  const value = (name: string, fallback?: string): string => {
    const v = env[name]?.trim() || fallback;
    if (v === undefined) errors.push(`${name} is required`);
    return v ?? "";
  };

  const beszelUrl = value("BESZEL_URL", "http://127.0.0.1:8090");
  if (!URL.canParse(beszelUrl)) errors.push(`BESZEL_URL is not a URL: ${beszelUrl}`);

  const source = value("SOURCE", "systems");
  if (source === "realtime") errors.push("SOURCE=realtime is not implemented yet (milestone M6)");
  else if (source !== "systems") errors.push(`SOURCE must be "systems" or "realtime", got "${source}"`);

  const port = Number(value("BIND_PORT", "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`BIND_PORT must be 1-65535, got "${env.BIND_PORT}"`);

  const salt = value("STREAM_SALT");
  if (salt && salt.length < 16) errors.push("STREAM_SALT must be at least 16 characters");

  const config: Config = {
    beszelUrl,
    email: value("BESZEL_EMAIL"),
    password: value("BESZEL_PASSWORD"),
    source: "systems",
    bindHost: value("BIND_HOST", "127.0.0.1"),
    bindPort: port,
    salt,
    mixFile: value("MIX_FILE", "mix.json"),
  };
  if (errors.length > 0) throw new Error(`Invalid configuration:\n  ${errors.join("\n  ")}`);
  return config;
}
