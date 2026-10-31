type Level = "info" | "warn" | "error";

/** Error message with its `cause` chain, e.g. "Something went wrong. ← fetch failed ← connect ECONNREFUSED". */
function describe(error: unknown, depth = 0): string {
  // A depth cap also terminates cyclic cause chains.
  if (depth >= 5) return "[cause chain truncated]";
  // The PocketBase SDK sets an HTTP error's cause to a plain { url, status, data } object.
  const http = error as { url?: unknown; status?: unknown } | null;
  if (!(error instanceof Error) && typeof http?.status === "number" && typeof http.url === "string") {
    const url = URL.parse(http.url);
    if (url) url.username = url.password = "";
    return `HTTP ${http.status} ${url?.href ?? "[invalid URL]"}`;
  }
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} ← ${describe(error.cause, depth + 1)}`;
}

export function log(level: Level, message: string, error?: unknown): void {
  const cause = error === undefined ? "" : `: ${describe(error)}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${cause}`.replaceAll("\r", String.raw`\r`).replaceAll("\n", String.raw`\n`);
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
}
