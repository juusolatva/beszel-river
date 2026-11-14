/** Count submission work without allocating argument arrays inside GL calls. */
export function createSubmissionCounter(gl: WebGL2RenderingContext) {
  const counters = {
    uploadedBytes: 0, textureUploadBytes: 0, drawCalls: 0, particleDrawCapacity: 0,
    lastFramebuffer: null as WebGLFramebuffer | null,
  };
  const methods = new Map<PropertyKey, unknown>();
  methods.set("bufferSubData", (target: number, offset: number, data: AllowSharedBufferSource, start?: number, length?: number) => {
    if (ArrayBuffer.isView(data)) {
      const elementBytes = "BYTES_PER_ELEMENT" in data ? Number(data.BYTES_PER_ELEMENT) : 1;
      counters.uploadedBytes += (length || data.byteLength / elementBytes - (start ?? 0)) * elementBytes;
      if (start === undefined && length === undefined) gl.bufferSubData(target, offset, data);
      else gl.bufferSubData(target, offset, data, start ?? 0, length);
    } else {
      counters.uploadedBytes += data.byteLength;
      gl.bufferSubData(target, offset, data);
    }
  });
  // Texture uploads, such as the GPU prototype's flow, stream and command data, counted separately.
  // Fixed parameters, not rest arguments, so a timed step allocates nothing here either.
  methods.set("texSubImage2D", (target: GLenum, level: GLint, x: GLint, y: GLint, width: GLsizei, height: GLsizei,
    format: GLenum, type: GLenum, pixels: ArrayBufferView, srcOffset?: number) => {
    const elementBytes = "BYTES_PER_ELEMENT" in pixels ? Number(pixels.BYTES_PER_ELEMENT) : 1;
    counters.textureUploadBytes += pixels.byteLength - (srcOffset ?? 0) * elementBytes;
    if (srcOffset === undefined) gl.texSubImage2D(target, level, x, y, width, height, format, type, pixels);
    else gl.texSubImage2D(target, level, x, y, width, height, format, type, pixels, srcOffset);
  });
  methods.set("drawArrays", (mode: number, first: number, count: number) => {
    counters.drawCalls++;
    gl.drawArrays(mode, first, count);
  });
  methods.set("drawArraysInstanced", (mode: number, first: number, count: number, instances: number) => {
    counters.drawCalls++;
    counters.particleDrawCapacity += instances;
    gl.drawArraysInstanced(mode, first, count, instances);
  });
  methods.set("createFramebuffer", () => (counters.lastFramebuffer = gl.createFramebuffer()));
  const countedGl = new Proxy(gl, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const bound = value.bind(target);
      methods.set(key, bound);
      return bound;
    },
  });
  return { gl: countedGl, counters };
}
