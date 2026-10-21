import { LOOK, readConfig } from "./config";
import { mountDebugPanel, type Stats } from "./debug/panel";
import { Renderer } from "./render/renderer";
import { FlowField } from "./sim/noise";
import { ParticleSystem } from "./sim/particles";
import { StreamSet } from "./sim/streams";
import { DemoSource } from "./source/demo";
import { ease, mulberry32 } from "./util/math";

const config = readConfig(location.search, (query) => matchMedia(query).matches);
const canvas = document.querySelector<HTMLCanvasElement>("#river");
const gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
if (!canvas || !gl) throw new Error("WebGL2 is not available");

const streams = new StreamSet(config.motion);
const field = new FlowField(mulberry32(config.seed));
const particles = new ParticleSystem(config.particles, mulberry32(config.seed + 1));
const renderer = new Renderer(gl, config.particles);
const source = new DemoSource({ streams: config.demoStreams, intervalMs: config.demoIntervalMs, random: mulberry32(config.seed + 2) });
source.start((frame) => streams.apply(frame));

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

const stats: Stats = { fps: 0, particles: 0, simMs: 0 };
if (config.debug) mountDebugPanel(source, stats);

let last = performance.now();
let t = 0;
let raf = requestAnimationFrame(frame);

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, LOOK.maxDt);
  last = now;
  if (dt > 0) {
    t += dt;
    const simStart = performance.now();
    streams.update(dt, aspect);
    field.update(t, aspect);
    particles.spawn(dt, t, streams);
    const count = particles.step(dt, t, streams, field, aspect, pixelRatio);
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
