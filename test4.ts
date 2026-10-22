function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(data: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }

  if (!isObject(raw) || raw.v !== 1 || typeof raw.t !== "number") return null;

  const rawStreams = raw.streams;
  if (!Array.isArray(rawStreams)) return null;

  for (const s of rawStreams) {
    console.log(s);
  }
}
