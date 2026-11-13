/** A recorded WebGL call: method name and arguments. */
export type Call = [name: string, ...args: unknown[]];

export interface FakeGlOptions {
  /** Whether EXT_color_buffer_float is offered. */
  halfFloat?: boolean;
  /** Framebuffer completeness per internal format, by constant name; complete when missing. */
  complete?: Partial<Record<"RGBA16F" | "RGBA8", boolean>>;
  compileLog?: string | null;
  linkLog?: string | null;
  /** Replacement methods, still recorded. */
  overrides?: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * WebGL2 stand-in for tests: constants read as their own names, `create*` return labelled objects, and
 * every call is recorded. Enough of the API for `gl.ts` and `Renderer`, with switches for the failures
 * they handle.
 */
export function createFakeGl(options: FakeGlOptions = {}): { gl: WebGL2RenderingContext; calls: Call[] } {
  const calls: Call[] = [];
  let created = 0;
  let boundFormat: string | undefined;
  const textureFormats = new Map<unknown, string>();
  let boundTexture: unknown;
  const attachments = new Map<unknown, unknown>();
  let boundFramebuffer: unknown;

  let activeUnit: unknown = "TEXTURE0";
  const textureUnits = new Map<unknown, unknown>();
  let arrayBuffer: unknown;
  let vao: unknown;
  const attributes = new Map<unknown, Map<unknown, unknown>>();
  const outputs = new Map<unknown, unknown>();
  const assertInputs = (): void => {
    for (const buffer of attributes.get(vao)?.values() ?? []) {
      if (buffer && [...outputs.values()].includes(buffer)) throw new Error("Attribute buffer is also feedback output");
    }
  };
  const bindAttribute = (index: unknown): void => {
    if (!attributes.has(vao)) attributes.set(vao, new Map());
    attributes.get(vao)!.set(index, arrayBuffer);
    assertInputs();
  };

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    getExtension: (name) => (name === "EXT_color_buffer_float" && options.halfFloat ? {} : null),
    getShaderParameter: () => options.compileLog == null,
    getShaderInfoLog: () => options.compileLog ?? "",
    getProgramParameter: () => options.linkLog == null,
    getProgramInfoLog: () => options.linkLog ?? "",
    getUniformLocation: (_program, name) => ({ uniform: name }),
    getParameter: () => 4096,
    activeTexture: (unit) => { activeUnit = unit; boundTexture = textureUnits.get(unit); },
    bindTexture: (_target, texture) => { boundTexture = texture; textureUnits.set(activeUnit, texture); },
    bindBuffer: (target, buffer) => { if (target === "ARRAY_BUFFER") arrayBuffer = buffer; },
    bindVertexArray: (value) => { vao = value; assertInputs(); },
    vertexAttribPointer: bindAttribute,
    vertexAttribIPointer: bindAttribute,
    bindBufferBase: (_target, index, buffer) => { outputs.set(index, buffer); assertInputs(); },
    drawArrays: assertInputs,
    texImage2D: (_target, _level, format) => {
      boundFormat = String(format);
      textureFormats.set(boundTexture, boundFormat);
    },
    bindFramebuffer: (_target, framebuffer) => (boundFramebuffer = framebuffer),
    framebufferTexture2D: (_target, _attachment, _textarget, texture) => attachments.set(boundFramebuffer, texture),
    checkFramebufferStatus: () => {
      const format = textureFormats.get(attachments.get(boundFramebuffer)) ?? boundFormat;
      return options.complete?.[format as "RGBA16F" | "RGBA8"] === false ? "FRAMEBUFFER_INCOMPLETE_ATTACHMENT" : "FRAMEBUFFER_COMPLETE";
    },
    ...options.overrides,
  };

  const gl = new Proxy({} as WebGL2RenderingContext, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(prop)) return prop;
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        if (methods[prop]) return methods[prop](...args);
        if (prop.startsWith("create")) return { kind: prop.slice(6), n: ++created };
        return undefined;
      };
    },
  });
  return { gl, calls };
}

/** Calls named `name`, in order. */
export function callsTo(calls: Call[], name: string): unknown[][] {
  return calls.filter(([n]) => n === name).map(([, ...args]) => args);
}
