interface RawFrame {
  v: number;
  t: number;
  streams: unknown[];
}

function parseFrame(data: string) {
  let raw: Partial<RawFrame>;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.v !== 1 || typeof raw.t !== "number" || !Array.isArray(raw.streams)) return null;

  for (const s of raw.streams) {
    console.log(s);
  }
}
