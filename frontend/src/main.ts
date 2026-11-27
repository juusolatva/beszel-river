import type { Frame } from "@beszel-river/shared";
import { LOOK, readConfig } from "./config";
import { mountDebugPanel, type DebugTarget, type Stats } from "./debug/panel";
import type { GpuBackend, GpuStepClock } from "./gpu-backend";
import { Renderer } from "./render/renderer";
import { ParticleBudget } from "./sim/budget";
import { FlowField } from "./sim/noise";
import { ParticleSystem } from "./sim/particles";
import { StreamSet } from "./sim/streams";
import { DemoSource } from "./source/demo";
import type { FrameSource } from "./source/source";
import { StreamSource } from "./source/stream";
import { ease, mulberry32 } from "./util/math";

/** Without a connection for this long, the river shows no live data: every stream dries up. */
const OFFLINE_AFTER_MS = 20_000;

const config = readConfig(location.search, (query) => matchMedia(query).matches);
const canvas = document.querySelector<HTMLCanvasElement>("#river");
const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
if (!canvas || !gl) {
  const note = document.createElement("p");
  note.textContent = "This animation needs WebGL2, which this browser does not provide.";
  note.style.cssText = "position: fixed; inset: 0; margin: auto; height: 1.5em; text-align: center; color: #777; font: 14px system-ui, sans-serif";
  document.body.append(note);
  throw new Error("WebGL2 is not available");
}

// `?gpu`: the experimental GPU simulation, or the CPU one when it cannot be set up on this device.
// Loaded only then, so the default page does not download the GPU simulation.
let gpu: GpuBackend | null = null;
let gpuClock: GpuStepClock | null = null;
if (config.gpu) {
  try {
    const { createGpuBackend, GpuStepClock } = await import("./gpu-backend");
    gpu = createGpuBackend(gl, config.particles, config.seed + 1);
    gpuClock = new GpuStepClock();
  } catch (error) {
    console.warn("GPU simulation unavailable, using the CPU:", error);
  }
}
// The GPU's release policy keeps a draining slot until its particles must have died; the CPU's default
// would release it while GPU particles still live and clip them.
const streams = new StreamSet(config.motion, gpu?.particles.lifecycle.canRelease);
const field = new FlowField(mulberry32(config.seed));
const particles = gpu ? null : new ParticleSystem(config.particles, mulberry32(config.seed + 1));
const budget = new ParticleBudget(config.particles, config.particlesFixed);
const renderer = new Renderer(gl, config.particles);
// Before the first frame, so a particle shader that does not compile fails here rather than in a callback.
if (particles) renderer.prepareParticles();
const debug: DebugTarget = { demo: null, frame: null };
const onFrame = (frame: Frame): void => {
  debug.frame = frame;
  streams.apply(frame);
};
const startDemo = (): DemoSource => {
  const demo = new DemoSource({ streams: config.demoStreams, intervalMs: config.demoIntervalMs, random: mulberry32(config.seed + 2) });
  debug.demo = demo;
  demo.start(onFrame);
  return demo;
};

// `?demo` forces generated frames. In dev they also stand in when the bridge is not running; in
// production the stream keeps retrying instead.
let source: FrameSource;
let offlineTimer: ReturnType<typeof setTimeout> | undefined;
// A bridge restart or a short network drop reconnects within seconds; only a longer outage dims the river.
const onStatus = (connected: boolean): void => {
  if (connected) {
    clearTimeout(offlineTimer);
    offlineTimer = undefined;
    streams.offline = false;
  } else {
    offlineTimer ??= setTimeout(() => (streams.offline = true), OFFLINE_AFTER_MS);
  }
};
if (config.demo) source = startDemo();
else {
  source = new StreamSource({
    // Relative, so the page also works under a path such as /river/ (nginx proxies <path>/stream).
    url: "stream",
    onUnavailable: import.meta.env.DEV
      ? () => {
          console.info("Bridge not reachable at /stream, using demo frames");
          source = startDemo();
        }
      : undefined,
    onStatus,
  });
  source.start(onFrame);
}

let aspect = 1;
let pixelRatio = 1;
const resize = (): void => {
  pixelRatio = Math.min(window.devicePixelRatio || 1, LOOK.devicePixelRatioCap);
  const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
  canvas.width = width;
  canvas.height = height;
  aspect = width / height;
  renderer.resize(width, height);
};
addEventListener("resize", resize);
resize();

const stats: Stats = { fps: 0, particles: gpu ? null : 0, limit: config.particles, simMs: 0, backend: gpu ? "GPU" : "CPU" };
if (config.debug) mountDebugPanel(debug, stats);

let last: number | undefined;
let t = 0;
let raf = requestAnimationFrame(frame);

function frame(now: number): void {
  // The context can be lost before its event arrives; the event handler stops the loop for good.
  if (renderer.contextLost) return;
  // The first callback may arrive partway through a display period; do not calibrate from it.
  const interval = last === undefined ? 0 : (now - last) / 1000;
  last = now;
  if (gpu) gpuFrame(gpu, gpuClock!.take(interval));
  else cpuFrame(particles!, interval);
  raf = requestAnimationFrame(frame);
}

function cpuFrame(particles: ParticleSystem, interval: number): void {
  const dt = Math.min(interval, LOOK.maxDt);
  if (dt <= 0) return;
  t += dt;
  const simStart = performance.now();
  streams.update(dt, aspect);
  field.update(t, aspect);
  particles.spawn(dt, streams);
  const count = particles.step(dt, streams, field, aspect);
  stats.simMs = ease(stats.simMs, performance.now() - simStart, 0.5, dt);
  stats.fps = ease(stats.fps, 1 / dt, 0.5, dt);
  stats.particles = count;
  renderer.render(particles, streams.chroma, pixelRatio, dt, aspect);
  // Include rendering submission and any driver stalls; this does not measure GPU execution.
  const workSeconds = (performance.now() - simStart) / 1000;
  if (budget.update(interval, particles.count, workSeconds)) {
    particles.limit = budget.limit;
    particles.intensityScale = budget.intensityScale;
    stats.limit = budget.limit;
  }
}

/**
 * One GPU step of `dt` seconds (`GpuStepClock`: 0 skips the callback). The limit stays at the pool
 * size: `ParticleBudget` needs exact live counts, which the GPU does not report yet.
 */
function gpuFrame({ particles, drawer }: GpuBackend, dt: number): void {
  if (dt <= 0) return;
  t += dt;
  const simStart = performance.now();
  // The release clock advances before the streams, so a draining slot is judged in simulation time.
  particles.lifecycle.advanceTime(dt);
  streams.update(dt, aspect);
  field.update(t, aspect);
  particles.step(dt, streams, field, aspect);
  // CPU time to submit the step, as the CPU path's figure is its simulation; neither includes rendering.
  stats.simMs = ease(stats.simMs, performance.now() - simStart, 0.5, dt);
  stats.fps = ease(stats.fps, 1 / dt, 0.5, dt);
  renderer.renderGpu(drawer, dt, aspect, pixelRatio, particles.globalHue, 1);
}

// Rebuilding GL state after a context loss is not worth the code; a reload restores everything.
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  cancelAnimationFrame(raf);
  source.stop();
});
canvas.addEventListener("webglcontextrestored", () => location.reload());
