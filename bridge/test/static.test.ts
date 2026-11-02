import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamServer } from "../src/server.js";
import { loadStaticFiles, SECURITY_HEADERS, type StaticFiles } from "../src/static.js";

const INDEX = '<!doctype html><title>River</title><script type="module" src="./assets/index-abc123.js"></script>';
const SCRIPT = "console.log('river');";

let dir: string;
let server: StreamServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "river-static-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A build like Vite's: index.html, one hashed script, plus whatever a test adds. */
function build(extra: Record<string, string> = {}): string {
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), INDEX);
  writeFileSync(join(dir, "assets", "index-abc123.js"), SCRIPT);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  return dir;
}

/** `null` starts the server without STATIC_DIR. */
async function start(files: StaticFiles | null = loadStaticFiles(build())): Promise<string> {
  server = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => ({ v: 1, t: 1, streams: [] }), healthy: () => true, ...(files ? { files } : {}) });
  return `http://127.0.0.1:${await server.listen()}`;
}

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** Sends `path` as the request-target as is; fetch would normalize it first. */
function raw(base: string, path: string, method = "GET", headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    request(base, { path, method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    }).on("error", reject).end();
  });
}

function expectSecurityHeaders(headers: Raw["headers"]): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()]).toBe(value);
}

describe("loadStaticFiles", () => {
  it("maps index.html, top-level files and assets to request paths", () => {
    const files = loadStaticFiles(build({ "favicon.svg": "<svg/>" }));
    expect([...files.keys()].sort()).toEqual(["/", "/assets/index-abc123.js", "/favicon.svg", "/index.html"]);
    expect(files.get("/")).toBe(files.get("/index.html"));
    expect(files.get("/index.html")!.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(files.get("/assets/index-abc123.js")!.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(files.get("/favicon.svg")!.headers["Content-Type"]).toBe("image/svg+xml");
  });

  it("gives files with the same content the same ETag and others different ones", () => {
    const files = loadStaticFiles(build({ "robots.txt": SCRIPT }));
    expect(files.get("/robots.txt")!.etag).toBe(files.get("/assets/index-abc123.js")!.etag);
    expect(files.get("/index.html")!.etag).not.toBe(files.get("/robots.txt")!.etag);
    expect(files.get("/index.html")!.etag).toMatch(/^"[\w-]{27}"$/);
  });

  it("does not need an assets directory", () => {
    writeFileSync(join(dir, "index.html"), INDEX);
    expect([...loadStaticFiles(dir).keys()].sort()).toEqual(["/", "/index.html"]);
  });

  it("rejects a missing index.html", () => {
    mkdirSync(join(dir, "assets"));
    expect(() => loadStaticFiles(dir)).toThrow(/has no index.html/);
  });

  it("rejects a STATIC_DIR that is missing or a file", () => {
    expect(() => loadStaticFiles(join(dir, "missing"))).toThrow(/ENOENT/);
    writeFileSync(join(dir, "file"), "");
    expect(() => loadStaticFiles(join(dir, "file"))).toThrow(/is not a directory/);
  });

  it("follows a symlinked STATIC_DIR itself, as resolved once at startup", () => {
    build();
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    try {
      expect(loadStaticFiles(link).has("/index.html")).toBe(true);
    } finally {
      rmSync(link);
    }
  });

  it.each([
    ["an unknown extension", "map", () => writeFileSync(join(dir, "assets", "index-abc123.js.map"), "{}"), /unknown extension/],
    ["a file without an extension", "LICENSE", () => writeFileSync(join(dir, "LICENSE"), "MIT"), /unknown extension/],
    ["a hidden file", ".DS_Store", () => writeFileSync(join(dir, ".DS_Store"), ""), /cannot be served as is/],
    ["a name a browser would percent-encode", "a b.js", () => writeFileSync(join(dir, "assets", "a b.js"), ""), /cannot be served as is/],
    ["a top-level symlink", "link.js", () => symlinkSync(join(dir, "assets", "index-abc123.js"), join(dir, "link.js")), /is a symlink/],
    ["a symlink in assets/", "link.js", () => symlinkSync("/etc/passwd", join(dir, "assets", "link.js")), /is a symlink/],
    ["a directory other than assets/", "fonts", () => mkdirSync(join(dir, "fonts")), /is a directory/],
    ["a directory inside assets/", "nested", () => mkdirSync(join(dir, "assets", "nested")), /is a directory/],
  ])("rejects %s, naming the entry", (_, entry, add, error) => {
    build();
    add();
    expect(() => loadStaticFiles(dir)).toThrow(error);
    expect(() => loadStaticFiles(dir)).toThrow(entry);
  });

  it("rejects assets/ as a symlink to a directory", () => {
    writeFileSync(join(dir, "index.html"), INDEX);
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "assets"));
    expect(() => loadStaticFiles(dir)).toThrow(/assets is a symlink/);
  });
});

describe("serving the page", () => {
  it("serves index.html at / and /index.html with revalidation", async () => {
    const base = await start();
    for (const path of ["/", "/index.html", "/?debug", "/?seed=4"]) {
      const response = await raw(base, path);
      expect(response.status).toBe(200);
      expect(response.body).toBe(INDEX);
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(INDEX)));
      expect(response.headers["cache-control"]).toBe("no-cache");
      expectSecurityHeaders(response.headers);
    }
  });

  it("serves hashed assets as immutable and other top-level files with revalidation", async () => {
    const base = await start(loadStaticFiles(build({ "robots.txt": "User-agent: *\n" })));
    const asset = await raw(base, "/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.body).toBe(SCRIPT);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.etag).toMatch(/^"[\w-]{27}"$/);
    const robots = await raw(base, "/robots.txt");
    expect(robots.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(robots.headers["cache-control"]).toBe("no-cache");
  });

  it("answers HEAD with the headers and no body", async () => {
    const base = await start();
    const response = await raw(base, "/assets/index-abc123.js", "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers["content-length"]).toBe(String(SCRIPT.length));
    expectSecurityHeaders(response.headers);
  });

  it.each([
    ["the same ETag", (etag: string) => etag],
    ["a weak ETag among others", (etag: string) => `"other", W/${etag}`],
    ["*", () => "*"],
  ])("answers 304 for %s", async (_, header) => {
    const base = await start();
    const { headers } = await raw(base, "/index.html");
    const response = await raw(base, "/index.html", "GET", { "If-None-Match": header(headers.etag as string) });
    expect(response.status).toBe(304);
    expect(response.body).toBe("");
    expect(response.headers.etag).toBe(headers.etag);
    expect(response.headers["cache-control"]).toBe("no-cache");
    expectSecurityHeaders(response.headers);
  });

  it("sends the file again for a stale ETag", async () => {
    const base = await start();
    const response = await raw(base, "/index.html", "GET", { "If-None-Match": '"stale"' });
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX);
  });

  it("serves what was loaded at startup, never the disk", async () => {
    const base = await start();
    writeFileSync(join(dir, "index.html"), "changed");
    writeFileSync(join(dir, "assets", "new-def456.js"), SCRIPT);
    expect((await raw(base, "/index.html")).body).toBe(INDEX);
    expect((await raw(base, "/assets/new-def456.js")).status).toBe(404);
  });

  it.each(["/..%2fetc/passwd", "/..%2f", "//", "//index.html", "/assets/../index.html", "/assets/", "/assets", "/assets/%69ndex-abc123.js", "/index.html/", "/INDEX.HTML", "/missing.js", "/./index.html", "http://localhost/index.html"])(
    "answers 404 with the security headers for %s",
    async (path) => {
      const base = await start();
      const response = await raw(base, path);
      expect(response.status).toBe(404);
      expectSecurityHeaders(response.headers);
    },
  );

  it("answers other methods with 405 and the allowed ones", async () => {
    const base = await start();
    const file = await raw(base, "/", "POST");
    expect(file.status).toBe(405);
    expect(file.headers.allow).toBe("GET, HEAD");
    expectSecurityHeaders(file.headers);
    const stream = await raw(base, "/stream", "HEAD");
    expect(stream.status).toBe(405);
    expect(stream.headers.allow).toBe("GET");
    expectSecurityHeaders(stream.headers);
  });

  it("adds the security headers to /stream, /healthz and the client cap", async () => {
    const base = await start();
    const stream = await fetch(`${base}/stream`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(stream.headers.get(name)).toBe(value);
    await stream.body!.cancel();
    expectSecurityHeaders((await raw(base, "/healthz")).headers);

    await server!.close();
    server = new StreamServer({ host: "127.0.0.1", port: 0, snapshot: () => ({ v: 1, t: 1, streams: [] }), files: loadStaticFiles(dir), maxClients: 1 });
    const capped = `http://127.0.0.1:${await server.listen()}`;
    const first = await fetch(`${capped}/stream`);
    const second = await raw(capped, "/stream");
    expect(second.status).toBe(503);
    expectSecurityHeaders(second.headers);
    await first.body!.cancel();
  });

  it("sends only today's headers without STATIC_DIR", async () => {
    const base = await start(null);
    expect((await raw(base, "/index.html")).status).toBe(404);
    const missing = await raw(base, "/missing");
    const stream = await fetch(`${base}/stream`);
    for (const headers of [missing.headers, Object.fromEntries(stream.headers)]) {
      expect(headers["content-security-policy"]).toBeUndefined();
      expect(headers["referrer-policy"]).toBeUndefined();
      expect(headers["cross-origin-opener-policy"]).toBeUndefined();
    }
    await stream.body!.cancel();
  });
});
