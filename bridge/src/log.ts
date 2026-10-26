type Level = "info" | "warn" | "error";

/** Error message with its `cause` chain, e.g. "Something went wrong. ← fetch failed ← connect ECONNREFUSED". */
function describe(error: unknown): string {
  // The PocketBase SDK sets an HTTP error's cause to a plain { url, status, data } object.
  const http = error as { url?: unknown; status?: unknown } | null;
  if (!(error instanceof Error) && typeof http?.status === "number" && typeof http.url === "string") {
    return `HTTP ${http.status} ${http.url}`;
  }
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} ← ${describe(error.cause)}`;
}

export function log(level: Level, message: string, error?: unknown): void {
  const cause = error === undefined ? "" : `: ${describe(error)}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${cause}`;
  if (level === "info") process.stdout.write(line + "\n");
  else process.stderr.write(line + "\n");
}
