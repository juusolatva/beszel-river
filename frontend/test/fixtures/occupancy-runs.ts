import { FlowField } from "../../src/sim/noise";
import { ParticleSystem } from "../../src/sim/particles";
import { StreamSet } from "../../src/sim/streams";
import { mulberry32 } from "../../src/util/math";
import { cpuControl } from "./cpu-control";
import { OCCUPANCY, occupancyFrames, phaseAt, WindowMeans, type OccupancyScenario } from "./occupancy-scenario";

/** One seeded run's window means; see WindowMeans for the layout. */
export interface OccupancyRun {
  scenario: OccupancyScenario;
  /** `cpu`: the reference; `calibration`: more CPU seeds; `pcg`: the CPU with the GPU's random keys and free order. */
  group: "cpu" | "calibration" | "pcg" | "gpu";
  seed: number;
  starts: number[];
  means: number[];
}

/**
 * Runs the CPU simulation through the occupancy fixture with `seed` for the particles and `fieldSeed`
 * (by default the same) for the flow field. With `pcg`, particles draw the GPU prototype's per-birth
 * PCG keys and take the lowest free slot, as in the occupancy investigation's matched control.
 */
export function runCpuOccupancy(scenario: OccupancyScenario, seed: number, pcg: boolean, fieldSeed = seed): Omit<OccupancyRun, "group"> {
  const { capacity, steps, dt, aspect } = OCCUPANCY;
  const frames = occupancyFrames(scenario);
  let particles: ParticleSystem, streams: StreamSet, spawn: (dt: number) => void;
  if (pcg) {
    const control = cpuControl(capacity, seed, true, true);
    ({ particles, streams } = control);
    spawn = (step) => control.spawn(step);
  } else {
    particles = new ParticleSystem(capacity, mulberry32(seed));
    streams = new StreamSet(1);
    spawn = (step) => particles.spawn(step, streams);
  }
  const field = new FlowField(mulberry32(fieldSeed));
  const windows = new WindowMeans();
  let time = 0, phase = -1;
  for (let step = 0; step < steps; step++) {
    time += dt;
    if (phaseAt(time) !== phase) { phase = phaseAt(time); streams.apply(frames[phase]); }
    streams.update(dt, aspect);
    field.update(time, aspect);
    spawn(dt);
    particles.step(dt, streams, field, aspect, 1);
    windows.add(time, dt, particles.count, (s) => streams.slots[s].particles);
  }
  return { scenario, seed, starts: windows.starts, means: windows.means };
}
