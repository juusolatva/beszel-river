import { LOOK } from "../src/config";
import { Renderer } from "../src/render/renderer";

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
