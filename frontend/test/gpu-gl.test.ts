import { expect, it } from "vitest";
import { createFakeGl } from "./fake-gl";
import { createSubmissionCounter } from "./fixtures/gpu-gl";

it("counts typed uploads in elements and raw buffers in bytes while preserving GL overloads", () => {
  const { gl, calls } = createFakeGl();
  const { gl: counted, counters } = createSubmissionCounter(gl);
  const floats = new Float32Array(8);
  const integers = new Uint16Array(10);
  const view = new DataView(new ArrayBuffer(12));
  const raw = new ArrayBuffer(7);
  counted.bufferSubData(gl.ARRAY_BUFFER, 0, floats, 2, 3);
  counted.bufferSubData(gl.ARRAY_BUFFER, 12, integers, 2, 0);
  counted.bufferSubData(gl.ARRAY_BUFFER, 28, view, 3, 4);
  counted.bufferSubData(gl.ARRAY_BUFFER, 32, raw);
  counted.bufferSubData(gl.ARRAY_BUFFER, 39, integers);
  Reflect.apply(counted.bufferSubData, counted, [gl.ARRAY_BUFFER, 59, floats, undefined, 3]);
  expect(counters.uploadedBytes).toBe(12 + 16 + 4 + 7 + 20 + 12);
  expect(calls.filter(([name]) => name === "bufferSubData")).toEqual([
    ["bufferSubData", gl.ARRAY_BUFFER, 0, floats, 2, 3],
    ["bufferSubData", gl.ARRAY_BUFFER, 12, integers, 2, 0],
    ["bufferSubData", gl.ARRAY_BUFFER, 28, view, 3, 4],
    ["bufferSubData", gl.ARRAY_BUFFER, 32, raw],
    ["bufferSubData", gl.ARRAY_BUFFER, 39, integers],
    ["bufferSubData", gl.ARRAY_BUFFER, 59, floats, 0, 3],
  ]);
});
