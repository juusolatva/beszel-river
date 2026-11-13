import { LOOK } from "../config";
import { MAX_STREAMS, MIN_SHARE, type StreamReleasePolicy, type StreamSet, type StreamSlot } from "./streams";

/** Supported schedule keeps accumulated Float32 age error below one birth step. */
export function effectiveGpuStep(dt: number): number {
  dt = Math.fround(dt);
  if (!Number.isFinite(dt) || dt < 0 || (dt > 0 && dt < 1 / 256) || dt > Math.fround(LOOK.maxDt)) {
    throw new Error("Unsupported GPU step: expected zero or 1/256 through Float32(maxDt) seconds");
  }
  return dt;
}

/** Request accounting and conservative ownership proof; never estimates live GPU counts. */
export class GpuLifecycle {
  readonly commands = new Uint32Array(MAX_STREAMS * 4);
  private readonly generations = new Uint32Array(MAX_STREAMS);
  private readonly carry = new Float64Array(MAX_STREAMS);
  private readonly lastPossibleSpawn = new Float64Array(MAX_STREAMS);
  private readonly claims = new Float64Array(MAX_STREAMS);
  private readonly ids: string[] = new Array(MAX_STREAMS).fill("");
  private time = 0;

  readonly canRelease: StreamReleasePolicy = (slot, index) =>
    this.ids[index] === slot.id && this.ids[index] !== "" && this.claims[index] === slot.claimVersion &&
    this.time > this.lastPossibleSpawn[index] + LOOK.lifeRange[1] + Math.fround(LOOK.maxDt);

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Invalid GPU capacity");
  }

  /** Advance before StreamSet.update; wall time never releases particle ownership. */
  advanceTime(dt: number): void {
    dt = effectiveGpuStep(dt);
    // At the first deadline crossing (<14.2 s since last eligible spawn), at most
    // 3636 age additions lose <=2^-21 s each. Clock additions below 2^31 lose
    // <=2^-23 s each. Their sum is <1/256, the birth step already in particle age.
    // maxDt covers the current callback, whose motion has not run at release time.
    if (this.time + dt >= 2 ** 31) throw new Error("GPU clock overflow");
    this.time += dt;
  }

  /** Consume whole requests even if GPU-local capacity later rejects them. */
  prepare(dt: number, streams: StreamSet, limit: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > this.capacity) throw new Error("Invalid GPU limit");
    dt = effectiveGpuStep(dt);
    if (dt === 0) return;
    let share = 0;
    for (const s of streams.slots) if (s.used) share += s.shareWeight;
    const rate = share > 0 ? limit / LOOK.turnoverSeconds / Math.max(share, MIN_SHARE) : 0;
    let total = 0;
    for (let i = 0; i < MAX_STREAMS; i++) {
      const s = streams.slots[i], o = i * 4;
      this.synchronizeClaim(s, i);
      this.commands[o] = this.generations[i];
      this.commands[o + 1] = s.used ? 1 : 0;
      this.commands[o + 2] = total;
      total += this.requestCount(s, i, rate, dt);
      if (!Number.isSafeInteger(total) || total > 0xffffffff) throw new Error("GPU request overflow");
      this.commands[o + 3] = total;
    }
  }

  private synchronizeClaim(slot: StreamSlot, index: number): void {
    if (!slot.used || (this.ids[index] === slot.id && this.claims[index] === slot.claimVersion)) return;
    if (this.generations[index] === 0xffffffff) throw new Error("GPU generation overflow");
    this.generations[index]++;
    this.ids[index] = slot.id;
    this.claims[index] = slot.claimVersion;
    this.carry[index] = 0;
    this.lastPossibleSpawn[index] = this.time;
  }

  private requestCount(slot: StreamSlot, index: number, rate: number, dt: number): number {
    if (!slot.used || !(slot.inFrame || slot.presence >= 0.01)) return 0;
    this.lastPossibleSpawn[index] = this.time;
    this.carry[index] += rate * slot.spawnWeight * dt;
    const n = Math.floor(this.carry[index]);
    this.carry[index] -= n;
    return n;
  }
}
