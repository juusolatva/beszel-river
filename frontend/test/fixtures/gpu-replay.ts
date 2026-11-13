import type { Frame } from "@beszel-river/shared";
import { LOOK } from "../../src/config";
import { FlowField } from "../../src/sim/noise";
import { ParticleSystem } from "../../src/sim/particles";
import { MAX_STREAMS, StreamSet } from "../../src/sim/streams";
import { mulberry32 } from "../../src/util/math";

export const CPU_REFERENCE = "a90be9077096e35749f3b3409193db31ca51635a";
export const REPLAY_CAPACITY = 10000;
export const REPLAY_SEED = 42;
export type ReplayScenario = "dense" | "empty" | "draining" | "drained" | "rotation";

// Built once, outside callback timing. Only synthetic public channel values are used.
export const replayFrames: Frame[] = [1, 4, 32, 32, 0].map((count, stage) => ({
  v: 1, t: [0, 5000, 10000, 40000, 70000][stage],
  streams: Array.from({ length: count }, (_, i) => ({
    id: `replay-${stage === 3 ? "replacement" : "original"}-${i}`,
    alive: true, width: [0.25, 0.5, 0.75, 1][i % 4],
    flow: stage >= 2 ? 0 : 0.5, density: 1, turbulence: 0.7,
    pulse: stage === 1 ? 1 : 0, heat: 0.5,
    ...(stage % 2 === 1 ? { filaments: [0.1, 0.2, 0.9, 0.3, 0.2, 0.1] } : {}),
  })),
}));

/** Frame indices are recorded, so validation never reschedules from its own clock. */
export function replayFrameIndex(scenario: ReplayScenario, seconds: number): number {
  if (scenario === "empty") return 4;
  if (scenario === "dense") return 2;
  if (scenario === "draining" || scenario === "drained") return seconds < 30 ? 2 : 4;
  return seconds < 5 ? 0 : seconds < 10 ? 1 : seconds < 40 ? 2 : seconds < 70 ? 3 : 4;
}

/** Full effective inputs, including warmup; arrays never grow inside a callback. */
export class ReplayTrace {
  length = 0;
  valid = true;
  readonly interval: Float64Array;
  readonly dt: Float32Array;
  readonly frame: Uint8Array;
  readonly width: Uint32Array;
  readonly height: Uint32Array;
  readonly pixelRatio: Float64Array;
  readonly motion: Float64Array;
  readonly offline: Uint8Array;
  readonly limit: Uint32Array;
  readonly intensity: Float64Array;
  readonly measured: Uint8Array;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error("Trace capacity must be a nonnegative integer");
    this.interval = new Float64Array(capacity);
    this.dt = new Float32Array(capacity);
    this.frame = new Uint8Array(capacity);
    this.width = new Uint32Array(capacity);
    this.height = new Uint32Array(capacity);
    this.pixelRatio = new Float64Array(capacity);
    this.motion = new Float64Array(capacity);
    this.offline = new Uint8Array(capacity);
    this.limit = new Uint32Array(capacity);
    this.intensity = new Float64Array(capacity);
    this.measured = new Uint8Array(capacity);
  }

  append(interval: number, frame: number, width: number, height: number, pixelRatio: number,
    motion: number, offline: boolean, limit: number, intensity: number, measured: boolean): void {
    if (this.length === this.capacity) {
      this.valid = false;
      throw new Error("Replay trace overflow: run invalid");
    }
    if (!Number.isInteger(width) || width <= 0 || width > 0xffffffff
      || !Number.isInteger(height) || height <= 0 || height > 0xffffffff) {
      this.valid = false;
      throw new Error("Trace dimensions must be positive uint32 integers");
    }
    const i = this.length++;
    this.interval[i] = interval;
    // Canonicalize the effective step once; both backends consume this same Float32 value.
    this.dt[i] = Math.min(Math.max(0, interval), LOOK.maxDt);
    this.frame[i] = frame;
    this.width[i] = width;
    this.height[i] = height;
    this.pixelRatio[i] = pixelRatio;
    this.motion[i] = motion;
    this.offline[i] = Number(offline);
    this.limit[i] = limit;
    this.intensity[i] = intensity;
    this.measured[i] = Number(measured);
  }
}

/** CPU reference adapter; rendering and validation use the same effective schedule. */
export class CpuReplay {
  readonly streams: StreamSet;
  readonly field = new FlowField(mulberry32(REPLAY_SEED));
  readonly particles = new ParticleSystem(REPLAY_CAPACITY, mulberry32(REPLAY_SEED + 1));
  private frame = -1;
  private time = 0;

  constructor(private readonly motion = 1) {
    this.streams = new StreamSet(motion);
  }

  step(trace: ReplayTrace, i: number): number {
    if (trace.motion[i] !== this.motion) throw new Error("Motion changes require a new replay run");
    const frame = trace.frame[i];
    if (frame !== this.frame) {
      this.streams.apply(replayFrames[frame]);
      this.frame = frame;
    }
    this.streams.offline = trace.offline[i] !== 0;
    this.particles.limit = trace.limit[i];
    this.particles.intensityScale = trace.intensity[i];
    const dt = trace.dt[i];
    if (dt <= 0) return this.particles.count;
    const aspect = trace.width[i] / trace.height[i];
    this.time += dt;
    this.streams.update(dt, aspect);
    this.field.update(this.time, aspect);
    this.particles.spawn(dt, this.streams);
    return this.particles.step(dt, this.streams, this.field, aspect, trace.pixelRatio[i]);
  }
}

/** Exact post-step counts; weights are reported separately for simulation and callback time. */
export function summarizeOccupancy(trace: ReplayTrace, counts: Uint32Array) {
  let min = Infinity, max = 0, simWeight = 0, wallWeight = 0, simSum = 0, wallSum = 0;
  for (let i = 0; i < trace.length; i++) {
    if (!trace.measured[i]) continue;
    min = Math.min(min, counts[i]);
    max = Math.max(max, counts[i]);
    simWeight += trace.dt[i];
    wallWeight += trace.interval[i];
    simSum += trace.dt[i] * counts[i];
    wallSum += trace.interval[i] * counts[i];
  }
  return { min: min === Infinity ? 0 : min, max, simulationMean: simWeight ? simSum / simWeight : 0, wallMean: wallWeight ? wallSum / wallWeight : 0 };
}

/** Untimed replay records total and per-slot exact counts without influencing timed work. */
export function validateCpuTrace(trace: ReplayTrace) {
  if (!trace.valid) throw new Error("Cannot validate an invalid trace");
  const cpu = new CpuReplay(trace.length ? trace.motion[0] : 1);
  const counts = new Uint32Array(trace.length);
  const perSlot = new Uint32Array(trace.length * MAX_STREAMS);
  const ids = ["", ...new Set(replayFrames.flatMap((frame) => frame.streams.map((stream) => stream.id)))];
  const idIndices = new Map(ids.map((id, i) => [id, i]));
  const perSlotIdentity = new Uint16Array(trace.length * MAX_STREAMS);
  for (let i = 0; i < trace.length; i++) {
    counts[i] = cpu.step(trace, i);
    for (let slot = 0; slot < MAX_STREAMS; slot++) {
      perSlot[i * MAX_STREAMS + slot] = cpu.streams.slots[slot].particles;
      perSlotIdentity[i * MAX_STREAMS + slot] = idIndices.get(cpu.streams.slots[slot].id)!;
    }
  }
  return { cpu, counts, perSlot, ids, perSlotIdentity, occupancy: summarizeOccupancy(trace, counts) };
}
