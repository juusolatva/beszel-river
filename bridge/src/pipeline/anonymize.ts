import { createHmac } from "node:crypto";

function hmac(salt: string, text: string): string {
  return createHmac("sha256", salt).update(text).digest("hex");
}

/** Opaque 8-hex-character ID, stable for one UTC day. */
export function streamId(salt: string, systemId: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return hmac(salt, `${day}:${systemId}:stream`).slice(0, 8);
}

/** Band order that changes once per UTC day, so a position does not identify a host for long. */
export function bandOrder(salt: string, systemIds: readonly string[], now: Date): string[] {
  const day = now.toISOString().slice(0, 10);
  const keyed = systemIds.map((id) => ({ id, key: hmac(salt, `${day}:${id}`) }));
  return keyed.toSorted(byKey).map((k) => k.id);
}

/**
 * Order of a stream's filaments for the day, as indexes into its ascending core profile, so the
 * busiest filament is not always in the same place and the order differs between hosts.
 */
export function filamentOrder(salt: string, systemId: string, count: number, now: Date): number[] {
  const day = now.toISOString().slice(0, 10);
  const keyed = Array.from({ length: count }, (_, index) => ({ index, key: hmac(salt, `${day}:${systemId}:filament:${index}`) }));
  return keyed.toSorted(byKey).map((k) => k.index);
}

/** Number of steps between the narrowest and widest band. */
const WIDTH_STEPS = 4;

/**
 * Relative band width for the day, one of 0, 0.25, … 1, seeded by the salt, the system ID and the
 * UTC date. It carries no data: widths taken from thread counts gave away the ratios between hosts'
 * core counts and marked the same host from one day to the next.
 */
export function bandWidths(salt: string, systemIds: readonly string[], now: Date): Map<string, number> {
  const day = now.toISOString().slice(0, 10);
  return new Map(systemIds.map((id) => [id, (Number.parseInt(hmac(salt, `${day}:${id}:width`).slice(0, 8), 16) % (WIDTH_STEPS + 1)) / WIDTH_STEPS]));
}

/** Orders by `key` in code-unit order, so the daily order does not depend on the locale. */
function byKey(a: { key: string }, b: { key: string }): number {
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}
