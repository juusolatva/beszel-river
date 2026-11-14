import { LOOK } from "../src/config";
import { GpuParticleDrawer } from "../src/render/gpu-particle-drawer";
import { Renderer } from "../src/render/renderer";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { ParticleSystem } from "../src/sim/particles";
import { StreamSet } from "../src/sim/streams";
import { mulberry32 } from "../src/util/math";
import { replayFrames } from "./fixtures/gpu-replay";
import { preloadCpuState, preloadGpuState } from "./fixtures/gpu-state";

/** Real-shader regression checks; with Vite running, import this module in the browser console. */
export function runRendererBrowserChecks(RendererClass = Renderer): { half: boolean; intensity: number; red: number[] }[] {
  const results: { half: boolean; intensity: number; red: number[] }[] = [];
  const assert = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
  };
  for (const half of [true, false]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw new Error("Browser check requires WebGL2");
    const getExtension = gl.getExtension.bind(gl);
    if (half) assert(getExtension("EXT_color_buffer_float") !== null, "Half-float check requires EXT_color_buffer_float");
    else Object.defineProperty(gl, "getExtension", { value: (name: string) => name === "EXT_color_buffer_float" ? null : getExtension(name) });

    const pixel = new Uint8Array(4);
    for (const intensity of [0.05, 0.3]) {
      const red: number[] = [];
      for (const hz of [30, 60, 120, 240]) {
        const renderer = new RendererClass(gl, 1);
        renderer.resize(32, 32);
        assert(renderer.halfFloat === half, `${half}: renderer fell back to RGBA8`);
        const instances = new Float32Array([0.5, 0.5, 0.5, 0.5, 0, 0, 0.75, intensity, 2]);
        for (let frame = 0; frame < hz * 2; frame++) renderer.render(instances, 1, 1 / hz, 1);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        assert(pixel[0] > 0, `${half}/${hz}: stationary streak disappeared`);
        red.push(pixel[0]);

        // Empty pools must fade all the way to black, including low-precision targets.
        for (let frame = 0; frame < 100; frame++) renderer.render(instances, 0, LOOK.maxDt, 1);
        gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        assert(pixel[0] === 0, `${half}/${hz}: trail left a ghost`);
      }
      // Allow a few bytes for half-float arithmetic; RGBA8 takes identical 60 Hz steps.
      assert(Math.max(...red) - Math.min(...red) <= (half ? 4 : 0), `${half}/${intensity}: refresh-dependent brightness ${red}`);
      results.push({ half, intensity, red });
    }
    const zero = new RendererClass(gl, 1);
    zero.resize(32, 32);
    zero.render(new Float32Array([0.5, 0.5, 0.5, 0.5, 0, 0, 0.75, 0.3, 2]), 1, 0, 1);
    gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    assert(pixel[0] === 0, `${half}: zero dt added energy`);
    assert(gl.getError() === gl.NO_ERROR, `${half}: WebGL error`);
    getExtension("WEBGL_lose_context")?.loseContext();
  }
  return results;
}

const DRAW_SIZE = 64;
const DRAW_ASPECT = 1.5;

/** Half-float or forced RGBA8 context for one browser check. */
function drawContext(half: boolean): WebGL2RenderingContext {
  const canvas = document.createElement("canvas");
  canvas.width = DRAW_SIZE * DRAW_ASPECT;
  canvas.height = DRAW_SIZE;
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) throw new Error("Browser check requires WebGL2");
  const getExtension = gl.getExtension.bind(gl);
  if (half && getExtension("EXT_color_buffer_float") === null) throw new Error("Half-float check requires EXT_color_buffer_float");
  if (!half) Object.defineProperty(gl, "getExtension", { value: (name: string) => name === "EXT_color_buffer_float" ? null : getExtension(name) });
  return gl;
}

/** Streams and flow for the draw checks: four bands, with filaments. */
function drawInputs(): { streams: StreamSet; field: FlowField } {
  const streams = new StreamSet(1);
  streams.apply(replayFrames[1]);
  streams.update(0.1, DRAW_ASPECT);
  const field = new FlowField(mulberry32(42));
  field.update(0, DRAW_ASPECT);
  return { streams, field };
}

/**
 * Particles spread over the view with varied ages, sizes, lanes and velocities. Inactive slots sit in
 * view too, so drawing one shows. Generation 0 matches the command texture of a motion-only run.
 */
function drawFixture(count: number, generation = 0, active = (i: number) => i % 8 !== 7): ArrayBuffer {
  const state = new ArrayBuffer(count * 64);
  const f = new Float32Array(state), u = new Uint32Array(state);
  const random = mulberry32(7);
  for (let i = 0; i < count; i++) {
    const life = 5 + 9 * random();
    f.set([0.1 + 1.3 * random(), 0.1 + 0.8 * random(), 0.05 * (random() - 0.5), 0.05 + 0.1 * random(),
      i % 5 === 0 ? 0.1 * random() : (life - 0.5) * random(), life, (random() - 0.5) * 2 * LOOK.hueJitter,
      0.7 + 0.9 * random(), 0.9, i % 3 === 0 ? 0.4 : 0, 0, 0], i * 16);
    u.set([i % 4, generation, active(i) ? 1 : 0, 1], i * 16 + 12);
  }
  return state;
}

function maxByte(pixels: Uint8Array): number {
  let max = 0;
  for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2]);
  return max;
}

/**
 * Real-shader checks for drawing straight from GPU state: the same preloaded particles stepped by the
 * CPU reference and the GPU simulation must render alike in both target formats and at 30–240 Hz,
 * without drawing inactive or stale slots, adding energy at zero dt or leaving a ghost when empty.
 * The 1-byte default tolerance catches a 2 % intensity error.
 */
export function runGpuDrawBrowserChecks(tolerance = 1): { half: boolean; hz: number; maxDifference: number; brightest: number }[] {
  const results: { half: boolean; hz: number; maxDifference: number; brightest: number }[] = [];
  const assert = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
  };
  const width = DRAW_SIZE * DRAW_ASPECT, height = DRAW_SIZE, count = 96, pixelRatio = 1.5, intensityScale = 0.6;
  const cpuPixels = new Uint8Array(width * height * 4), gpuPixels = new Uint8Array(width * height * 4);
  for (const half of [true, false]) {
    const gl = drawContext(half);
    for (const hz of [30, 60, 120, 240]) {
      const { streams, field } = drawInputs();
      const state = drawFixture(count);
      const cpu = preloadCpuState(state, streams);
      cpu.intensityScale = intensityScale;
      const gpu = new GpuParticles(gl, count, 42);
      const drawer = new GpuParticleDrawer(gl, gpu);
      const cpuRenderer = new Renderer(gl, count), gpuRenderer = new Renderer(gl, count);
      try {
        preloadGpuState(gl, gpu, state);
        cpuRenderer.resize(width, height);
        gpuRenderer.resize(width, height);
        // A half-float target that is advertised but incomplete falls back silently; that is not this check.
        assert(cpuRenderer.halfFloat === half && gpuRenderer.halfFloat === half, `${half}: renderer fell back to RGBA8`);
        const dt = Math.fround(1 / hz);
        const frames = Math.round(hz / 2);
        for (let frame = 0; frame < frames; frame++) {
          field.update(frame * dt, DRAW_ASPECT);
          const n = cpu.step(dt, streams, field, DRAW_ASPECT, pixelRatio);
          gpu.step(dt, streams, field, DRAW_ASPECT);
          cpuRenderer.render(cpu.instances, n, dt, DRAW_ASPECT);
          if (frame === frames - 1) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, cpuPixels);
          gpuRenderer.renderGpu(drawer, dt, DRAW_ASPECT, pixelRatio, gpu.globalHue, intensityScale);
          if (frame === frames - 1) gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, gpuPixels);
        }
        let maxDifference = 0;
        for (let i = 0; i < cpuPixels.length; i++) maxDifference = Math.max(maxDifference, Math.abs(cpuPixels[i] - gpuPixels[i]));
        const brightest = maxByte(cpuPixels);
        assert(brightest > 32, `${half}/${hz}: CPU reference drew too little (${brightest})`);
        assert(maxDifference <= tolerance, `${half}/${hz}: GPU draw differs from CPU by ${maxDifference}`);
        results.push({ half, hz, maxDifference, brightest });

        // An empty pool fades to black from GPU state as well.
        preloadGpuState(gl, gpu, drawFixture(count, 0, () => false));
        for (let frame = 0; frame < 100; frame++) gpuRenderer.renderGpu(drawer, LOOK.maxDt, DRAW_ASPECT, pixelRatio, gpu.globalHue, 1);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, gpuPixels);
        assert(maxByte(gpuPixels) === 0, `${half}/${hz}: GPU trail left a ghost`);
      } finally {
        drawer.dispose();
        gpu.dispose();
      }
      assert(gl.getError() === gl.NO_ERROR, `${half}/${hz}: WebGL error`);
    }

    // Zero dt adds no energy, and stale generations and inactive slots never deposit. One empty step
    // first uploads the stream data, so a missing clip would show; the active control must show.
    for (const [label, state, dt, lit] of [
      ["active control", drawFixture(count, 0, () => true), 1 / 60, true],
      ["zero dt", drawFixture(count, 0, () => true), 0, false],
      ["stale generation", drawFixture(count, 5, () => true), 1 / 60, false],
      ["inactive", drawFixture(count, 0, () => false), 1 / 60, false],
    ] as const) {
      const { streams, field } = drawInputs();
      const gpu = new GpuParticles(gl, count, 42);
      const drawer = new GpuParticleDrawer(gl, gpu);
      const renderer = new Renderer(gl, count);
      try {
        gpu.step(1 / 60, streams, field, DRAW_ASPECT);
        preloadGpuState(gl, gpu, state);
        renderer.resize(width, height);
        assert(renderer.halfFloat === half, `${half}: renderer fell back to RGBA8`);
        for (let frame = 0; frame < 4; frame++) renderer.renderGpu(drawer, dt, DRAW_ASPECT, pixelRatio, 0, 1);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, gpuPixels);
        const brightest = maxByte(gpuPixels);
        assert(lit ? brightest > 32 : brightest === 0, `${half}: ${label} brightest byte ${brightest}`);
      } finally {
        drawer.dispose();
        gpu.dispose();
      }
    }
    assert(gl.getError() === gl.NO_ERROR, `${half}: WebGL error`);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return results;
}

type RiverScene = "filaments" | "dense" | "draining";

/**
 * Seeded end-to-end replays of the CPU page path and the GPU prototype (simulation and drawing), in
 * lockstep at 60 Hz, captured as PNG data URLs for visual comparison with summary statistics. The two
 * spawn different particles, so full rivers are compared by eye and by profile, never pixel for pixel.
 */
export function captureGpuRiverComparison(options: { width?: number; height?: number; seed?: number } = {}) {
  const { width = 480, height = 320, seed = 42 } = options;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl) throw new Error("Browser check requires WebGL2");
  const aspect = width / height, dt = Math.fround(1 / 60), capacity = 10000;
  const pixels = new Uint8Array(width * height * 4);
  const captures: { scene: RiverScene; time: number; backend: "cpu" | "gpu"; image: string; mean: number[]; columns: number[] }[] = [];
  const capture = (scene: RiverScene, time: number, backend: "cpu" | "gpu") => {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const mean = [0, 0, 0], columns = new Array<number>(width).fill(0);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) mean[c] += pixels[i * 4 + c] / (width * height);
      columns[i % width] += (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / (3 * height);
    }
    captures.push({ scene, time, backend, image: canvas.toDataURL("image/png"), mean, columns });
  };
  const scenes: [RiverScene, frames: number[], seconds: number, captureAt: number[]][] = [
    ["filaments", [1], 20, [20]],
    ["dense", [2], 20, [20]],
    // Full river, then an empty frame at 20 s: draining while presence fades and particles die.
    ["draining", [2, 4], 36, [20, 24, 28, 36]],
  ];
  for (const [scene, frames, seconds, captureAt] of scenes) {
    const cpuStreams = new StreamSet(1), cpuField = new FlowField(mulberry32(seed));
    const cpu = new ParticleSystem(capacity, mulberry32(seed + 1));
    const gpu = new GpuParticles(gl, capacity, seed + 1000);
    gpu.spawningEnabled = true;
    const gpuStreams = new StreamSet(1, gpu.lifecycle.canRelease), gpuField = new FlowField(mulberry32(seed));
    const drawer = new GpuParticleDrawer(gl, gpu);
    const cpuRenderer = new Renderer(gl, capacity), gpuRenderer = new Renderer(gl, capacity);
    try {
      cpuRenderer.resize(width, height);
      gpuRenderer.resize(width, height);
      let frame = -1, time = 0;
      const steps = Math.round(seconds * 60);
      for (let step = 1; step <= steps; step++) {
        const next = frames[Math.min(frames.length - 1, Math.floor((step - 1) / 1200))];
        if (next !== frame) {
          cpuStreams.apply(replayFrames[next]);
          gpuStreams.apply(replayFrames[next]);
          frame = next;
        }
        time += dt;
        cpuStreams.update(dt, aspect);
        cpuField.update(time, aspect);
        cpu.spawn(dt, cpuStreams);
        const n = cpu.step(dt, cpuStreams, cpuField, aspect, 1);
        gpu.lifecycle.advanceTime(dt);
        gpuStreams.update(dt, aspect);
        gpuField.update(time, aspect);
        gpu.step(dt, gpuStreams, gpuField, aspect);
        const at = captureAt.includes(step / 60);
        cpuRenderer.render(cpu.instances, n, dt, aspect);
        if (at) capture(scene, step / 60, "cpu");
        gpuRenderer.renderGpu(drawer, dt, aspect, 1, gpu.globalHue, 1);
        if (at) capture(scene, step / 60, "gpu");
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error(`${scene}: WebGL error`);
    } finally {
      drawer.dispose();
      gpu.dispose();
    }
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  // Pearson correlation of the CPU and GPU column brightness profiles: the bands' placement and width.
  const pairs = captures.filter((c) => c.backend === "cpu").map((cpu) => {
    const gpu = captures.find((c) => c.backend === "gpu" && c.scene === cpu.scene && c.time === cpu.time)!;
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const a = mean(cpu.columns), b = mean(gpu.columns);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < width; i++) {
      ab += (cpu.columns[i] - a) * (gpu.columns[i] - b);
      aa += (cpu.columns[i] - a) ** 2;
      bb += (gpu.columns[i] - b) ** 2;
    }
    return { scene: cpu.scene, time: cpu.time, cpuMean: cpu.mean, gpuMean: gpu.mean,
      columnCorrelation: aa && bb ? ab / Math.sqrt(aa * bb) : null };
  });
  return { width, height, seed, gpuSeed: seed + 1000, pairs, captures };
}
