import { createHmac } from "node:crypto";

function hmac(salt: string, text: string): string {
  return createHmac("sha256", salt).update(text).digest("hex");
}

/** Opaque, stable 8-hex-character ID for a Beszel system ID. */
export function streamId(salt: string, systemId: string): string {
  return hmac(salt, systemId).slice(0, 8);
}

/** Band order that changes once per UTC day, so a position does not identify a host for long. */
export function bandOrder(salt: string, systemIds: readonly string[], now: Date): string[] {
  const day = now.toISOString().slice(0, 10);
  const keyed = systemIds.map((id) => ({ id, key: hmac(salt, `${day}:${id}`) }));
  return keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((k) => k.id);
}

/**
 * Relative band width from thread counts: log scale between the smallest and largest host,
 * quantized to quarters so it does not reveal exact core counts. All equal → 0.5; hosts left out
 * (unknown thread count) get 0.5 from the caller.
 */
export function bandWidths(threads: ReadonlyMap<string, number>): Map<string, number> {
  const logs = new Map([...threads].map(([id, t]) => [id, Math.log2(Math.max(t, 1))]));
  const values = [...logs.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return new Map([...logs].map(([id, l]) => [id, max > min ? Math.round(((l - min) / (max - min)) * 4) / 4 : 0.5]));
}
