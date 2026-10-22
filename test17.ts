function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(data: string) {
  let raw: Partial<{ v: number; t: number; streams: unknown[] }>;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.v !== 1 || typeof raw.t !== "number" || !Array.isArray(raw.streams)) return null;

  for (const s of raw.streams) {
    if (!isObject(s)) continue;
    console.log(s.id);
  }
}
