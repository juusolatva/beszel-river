function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(data: string) {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== 1 || typeof raw.t !== "number" || !Array.isArray(raw.streams)) return null;

  const streams = raw.streams; // what is the type of streams?

  for (const s of streams) { // Error if streams is unknown
    console.log(s);
  }
}
