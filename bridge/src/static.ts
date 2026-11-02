import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

/**
 * Sent on every response of the public listener when it serves the page. The same policy as
 * deploy/nginx/river.conf; HSTS is left to the proxy, which alone knows whether the site is HTTPS only.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** Every type the build may contain; anything else stops startup rather than being served with a guess. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** Vite puts a content hash in every name under assets/. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Top-level names carry no hash; index.html names the current assets. */
const REVALIDATE = "no-cache";

/**
 * Names a browser requests unencoded, so the raw request path matches them exactly. No leading dot:
 * hidden files are never part of a build.
 */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export interface StaticFile {
  readonly body: Buffer;
  readonly etag: string;
  readonly cacheControl: string;
  readonly headers: Readonly<Record<string, string | number>>;
}

/** Request path (`/`, `/index.html`, `/assets/<name>`, …) → file, fixed at startup. */
export type StaticFiles = ReadonlyMap<string, StaticFile>;

/**
 * Reads the frontend build into memory: regular files at the top level of `dir` and directly inside
 * `dir/assets/`. Anything else there (a symlink, another directory, an unknown extension, an odd name)
 * throws, so a new kind of build output is a deliberate change rather than a silent 404. Nothing is read
 * from disk afterwards, and no request path is ever turned into a filesystem path.
 */
export function loadStaticFiles(dir: string): StaticFiles {
  if (!statSync(dir).isDirectory()) throw new Error(`STATIC_DIR ${dir} is not a directory`);
  const files = new Map<string, StaticFile>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name === "assets" && lstatSync(path).isDirectory()) {
      for (const asset of readdirSync(path).sort()) files.set(`/assets/${asset}`, load(join(path, asset), asset, IMMUTABLE));
    } else {
      files.set(`/${name}`, load(path, name, REVALIDATE));
    }
  }
  const index = files.get("/index.html");
  if (!index) throw new Error(`STATIC_DIR ${dir} has no index.html`);
  files.set("/", index);
  return files;
}

function load(path: string, name: string, cacheControl: string): StaticFile {
  const stats = lstatSync(path);
  if (!stats.isFile()) {
    const kind = stats.isSymbolicLink() ? "a symlink" : stats.isDirectory() ? "a directory" : "not a regular file";
    throw new Error(`Static file ${path} is ${kind}; only regular files at the top level and in assets/ are served`);
  }
  if (!SAFE_NAME.test(name)) throw new Error(`Static file ${path} has a name that cannot be served as is`);
  const type = CONTENT_TYPES.get(extname(name));
  if (!type) throw new Error(`Static file ${path} has an unknown extension; add it to CONTENT_TYPES in bridge/src/static.ts`);

  // O_NOFOLLOW and fstat: the file read is the regular file checked, even if the entry changed meanwhile.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let body: Buffer;
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Static file ${path} is not a regular file`);
    body = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return {
    body,
    etag,
    cacheControl,
    headers: { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": body.length, "Cache-Control": cacheControl, ETag: etag },
  };
}

/** Answers `GET` or `HEAD` for a loaded file, with 304 when the client's copy is current. */
export function sendStatic(request: IncomingMessage, response: ServerResponse, file: StaticFile): void {
  if (etagMatches(request.headers["if-none-match"], file.etag)) {
    response.writeHead(304, { ...SECURITY_HEADERS, "Cache-Control": file.cacheControl, ETag: file.etag }).end();
    return;
  }
  response.writeHead(200, file.headers);
  if (request.method === "HEAD") response.end();
  else response.end(file.body);
}

/** `If-None-Match` uses weak comparison: `W/` prefixes are ignored, and `*` matches any current file. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
  });
}
