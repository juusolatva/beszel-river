// Placeholder until milestone M2 (renderer and demo source), see docs/PLAN.md.
// Confirms WebGL2 is available and clears the canvas.
const canvas = document.querySelector<HTMLCanvasElement>("#river");
const gl = canvas?.getContext("webgl2");
if (!gl) throw new Error("WebGL2 is not available");

gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
