/** Minimal `EXT_disjoint_timer_query_webgl2` declarations; the TypeScript DOM types omit the extension. */
export interface DisjointTimerQuery {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

export const TIMER_EXTENSION = "EXT_disjoint_timer_query_webgl2";

/**
 * GPU execution time of measured callbacks, from `TIME_ELAPSED_EXT` queries: one around a
 * callback's simulation GL work (uploads, flag and prefix-scan passes, transform feedback over the
 * whole state buffer) and one around its rendering (instance upload or full-capacity GPU draw,
 * trail passes, present). Queries live in a preallocated ring and are polled in later callbacks
 * without waiting; a callback finding the ring full goes untimed, and a GPU disjoint event discards
 * every sample still in flight. Never reports CPU submission time as GPU time.
 */
export class GpuTimer {
  /** Completed samples, in milliseconds, with the trace callback each belongs to. */
  readonly simulationMs: Float64Array;
  readonly renderMs: Float64Array;
  readonly callback: Uint32Array;
  samples = 0;
  /** Callbacks left untimed because every ring slot was still waiting for its results. */
  skipped = 0;
  /** Samples dropped because the GPU reported a disjoint event while they were in flight. */
  discarded = 0;
  private readonly queries: WebGLQuery[] = [];
  private readonly slotCallback: Uint32Array;
  /** Ring of in-flight slots: `oldest` is the next to complete, `pending` how many are in flight. */
  private oldest = 0;
  private pending = 0;
  private current = -1;

  private constructor(private readonly gl: WebGL2RenderingContext, private readonly ext: DisjointTimerQuery, ringSize: number, capacity: number) {
    this.simulationMs = new Float64Array(capacity);
    this.renderMs = new Float64Array(capacity);
    this.callback = new Uint32Array(capacity);
    this.slotCallback = new Uint32Array(ringSize);
    try {
      for (let i = 0; i < ringSize * 2; i++) {
        const query = gl.createQuery();
        if (!query) throw new Error("createQuery failed");
        this.queries.push(query);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** A timer, or why GPU timing is unavailable; `enabled: false` is a disclosed opt-out. */
  static create(gl: WebGL2RenderingContext, enabled: boolean, capacity: number, ringSize = 16): GpuTimer | string {
    if (!enabled) return "disabled (gpuTiming: false)";
    const ext = gl.getExtension(TIMER_EXTENSION) as DisjointTimerQuery | null;
    if (!ext) return `unavailable: ${TIMER_EXTENSION} not supported`;
    return new GpuTimer(gl, ext, ringSize, capacity);
  }

  /** Inflight slots whose results never arrived before `dispose`. */
  get inFlight(): number {
    return this.pending;
  }

  /** Starts timing this callback's simulation; false when the ring is full and the callback goes untimed. */
  beginSimulation(callback: number): boolean {
    if (this.current >= 0) throw new Error("GPU timer query already active");
    const ring = this.slotCallback.length;
    if (this.pending === ring) {
      this.skipped++;
      return false;
    }
    this.current = (this.oldest + this.pending) % ring;
    this.slotCallback[this.current] = callback;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[this.current * 2]);
    return true;
  }

  /** Ends the simulation query and starts the render query; TIME_ELAPSED queries cannot nest. */
  beginRender(): void {
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[this.current * 2 + 1]);
  }

  /** Ends the render query; the slot's results are read by a later `poll`. */
  endRender(): void {
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.current = -1;
    this.pending++;
  }

  /**
   * Reads every slot whose results are ready, oldest first, without waiting. Results complete in
   * submission order, so the render query of the oldest slot gates the rest. The disjoint flag is
   * read after them: if set, those results and every slot still in flight are discarded.
   */
  poll(): void {
    if (!this.pending) return;
    const { gl } = this, ring = this.slotCallback.length;
    let read = 0;
    while (read < this.pending) {
      const slot = (this.oldest + read) % ring;
      if (!gl.getQueryParameter(this.queries[slot * 2 + 1], gl.QUERY_RESULT_AVAILABLE)) break;
      if (this.samples + read >= this.simulationMs.length) break;
      const sample = this.samples + read;
      this.simulationMs[sample] = gl.getQueryParameter(this.queries[slot * 2], gl.QUERY_RESULT) / 1e6;
      this.renderMs[sample] = gl.getQueryParameter(this.queries[slot * 2 + 1], gl.QUERY_RESULT) / 1e6;
      this.callback[sample] = this.slotCallback[slot];
      read++;
    }
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.discarded += this.pending;
      this.oldest = (this.oldest + this.pending) % ring;
      this.pending = 0;
      return;
    }
    this.samples += read;
    this.oldest = (this.oldest + read) % ring;
    this.pending -= read;
  }

  dispose(): void {
    if (this.current >= 0) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.current = -1;
    for (const query of this.queries) this.gl.deleteQuery(query);
    this.queries.length = 0;
  }
}
