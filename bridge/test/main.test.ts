import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({ loadConfig: vi.fn() }));

const reachedListener = new Error("Stopped at the listener boundary");
let directory: string;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  // Startup tests must never read a developer's ignored .env.
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
  directory = mkdtempSync(join(tmpdir(), "river-startup-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function interceptStartup(mixFile: string) {
  const [{ loadConfig }, { StreamServer }, { BeszelClient }] = await Promise.all([
    import("../src/config.js"),
    import("../src/server.js"),
    import("../src/beszel/client.js"),
  ]);
  vi.mocked(loadConfig).mockReturnValue({
    beszelUrl: "http://127.0.0.1:8090",
    auth: { kind: "password", email: "bridge@example.com", password: "test" },
    source: "systems",
    bindHost: "127.0.0.1",
    bindPort: 8787,
    salt: "startup-test-salt",
    mixFile,
  });
  // Stop valid startup before sockets, timers, signal handlers or hub requests.
  const listen = vi.spyOn(StreamServer.prototype, "listen").mockRejectedValue(reachedListener);
  const login = vi.spyOn(BeszelClient.prototype, "login").mockResolvedValue(undefined);
  return { listen, login };
}

describe("bridge recipe startup", () => {
  it.each(["absolute", "relative"])("rejects a missing %s recipe before listening or authenticating", async (kind) => {
    const missing = join(directory, "missing.json");
    const mixFile = kind === "relative" ? relative(process.cwd(), missing) : missing;
    const { listen, login } = await interceptStartup(mixFile);

    // The public template is present: the former fallback would reach listen().
    expect(readFileSync("mix.example.json", "utf8")).toContain('"filaments"');
    await expect(import("../src/main.js")).rejects.toMatchObject({ code: "ENOENT", path: mixFile });
    expect(listen).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it.each(["omitted", "null", "enabled"])("accepts an explicit recipe with %s filaments", async (filaments) => {
    const recipe = JSON.parse(readFileSync("mix.example.json", "utf8"));
    if (filaments === "omitted") delete recipe.filaments;
    else if (filaments === "null") recipe.filaments = null;
    const mixFile = join(directory, "private.json");
    writeFileSync(mixFile, JSON.stringify(recipe));
    const { listen, login } = await interceptStartup(mixFile);

    await expect(import("../src/main.js")).rejects.toBe(reachedListener);
    expect(listen).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
  });

  it("rejects an invalid recipe before listening or authenticating", async () => {
    const mixFile = join(directory, "invalid.json");
    writeFileSync(mixFile, JSON.stringify({ filaments: null }));
    const { listen, login } = await interceptStartup(mixFile);

    await expect(import("../src/main.js")).rejects.toThrow(/Invalid mix config/);
    expect(listen).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });
});
