type Level = "info" | "warn" | "error";

/** Error message with its `cause` chain, e.g. "Something went wrong. ← fetch failed ← connect ECONNREFUSED". */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} ← ${describe(error.cause)}`;
}

export function log(level: Level, message: string, error?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${error === undefined ? "" : `: ${describe(error)}`}`;
  if (level === "info") console.log(line);
  else console.error(line);
}
