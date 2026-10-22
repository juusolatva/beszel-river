import type { Frame } from "@beszel-river/shared";
import { LOOK, readConfig } from "./config";
import { mountDebugPanel, type DebugTarget, type Stats } from "./debug/panel";
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

const streams = new StreamSet(config.motion);
const field = new FlowField(mulberry32(config.seed));
const particles = new ParticleSystem(config.particles, mulberry32(config.seed + 1));
const budget = new ParticleBudget(config.particles, config.particlesFixed);
const renderer = new Renderer(gl, config.particles);
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

const stats: Stats = { fps: 0, particles: 0, limit: config.particles, simMs: 0 };
if (config.debug) mountDebugPanel(debug, stats);

let last = performance.now();
let t = 0;
let raf = requestAnimationFrame(frame);

function frame(now: number): void {
  const interval = (now - last) / 1000;
  const dt = Math.min(interval, LOOK.maxDt);
  last = now;
  if (budget.update(interval)) {
    particles.limit = budget.limit;
    particles.intensityScale = budget.intensityScale;
    stats.limit = budget.limit;
  }
  if (dt > 0) {
    t += dt;
    const simStart = performance.now();
    streams.update(dt, aspect);
    field.update(t, aspect);
    particles.spawn(dt, streams);
    const count = particles.step(dt, streams, field, aspect, pixelRatio);
    stats.simMs = ease(stats.simMs, performance.now() - simStart, 0.5, dt);
    stats.fps = ease(stats.fps, 1 / dt, 0.5, dt);
    stats.particles = count;
    renderer.render(particles.instances, count, dt, aspect);
  }
  raf = requestAnimationFrame(frame);
}

// Rebuilding GL state after a context loss is not worth the code; a reload restores everything.
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  cancelAnimationFrame(raf);
  source.stop();
});
canvas.addEventListener("webglcontextrestored", () => location.reload());
