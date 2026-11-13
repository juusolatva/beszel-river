import { LOOK } from "../src/config";
import { GpuFreeScan } from "../src/sim/gpu-free-scan";
import { GpuParticles } from "../src/sim/gpu-particles";
import { FlowField } from "../src/sim/noise";
import { StreamSet } from "../src/sim/streams";
import { preloadGpuState } from "./fixtures/gpu-state";
import { replayFrames } from "./fixtures/gpu-replay";

function assert(ok: boolean, message: string): void { if (!ok) throw new Error(message); }

/** Exact integer allocation checks, outside timing and coverage. */
export function runGpuAllocationBrowserChecks(): { cases: number } {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  assert(!!gl, "WebGL2 required");
  let cases = 0;
  for (const capacity of [1, 31, 33, 100, 2500, 10000]) for (const pattern of ["dead", "live", "holes"]) {
    const gpu = new GpuParticles(gl, capacity, 42);
    const state = new ArrayBuffer(capacity * 64), f = new Float32Array(state), u = new Uint32Array(state);
    let free = 0;
    const expected = new Uint32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      const active = pattern === "live" || (pattern === "holes" && (capacity === 2500 ? i < 2075 : i % 2 === 0));
      f.set([0.5, 0.1, 0, 0.1, 0, 14, 0, 1, 1, 0, 0, 0], i * 16);
      u.set([0, 1, active ? 1 : 0, 0], i * 16 + 12);
      if (!active) free++;
      expected[i] = free;
    }
    preloadGpuState(gl, gpu, state);
    const scan = new GpuFreeScan(gl, capacity);
    const fb = gl.createFramebuffer();
    try {
      scan.scan(gpu.stateBuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scan.prefixTexture, 0);
      const prefix = new Uint32Array(scan.width * scan.height);
      gl.readPixels(0, 0, scan.width, scan.height, gl.RED_INTEGER, gl.UNSIGNED_INT, prefix);
      for (let i = 0; i < prefix.length; i++) assert(prefix[i] === (i < capacity ? expected[i] : 0), `Prefix ${capacity}/${pattern}/${i}: ${prefix[i]}`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const streams = new StreamSet(1, gpu.lifecycle.canRelease);
      streams.apply({ ...replayFrames[0], streams: [replayFrames[0].streams[0]] }); streams.update(0, 1.5);
      streams.slots[0].center = 0.5; streams.slots[0].half = 0.01; streams.slots[0].rebuildCenters();
      const field = new FlowField(() => 0.5); field.update(0, 1.5);
      // Inject exact requests into the command upload; RNG cannot change accepted counts here.
      gpu.lifecycle.prepare = () => { gpu.lifecycle.commands.fill(0); gpu.lifecycle.commands.set([1, 1, 0, capacity]); gpu.lifecycle.commands[127] = capacity; };
      gpu.spawningEnabled = true;
      const read = new ArrayBuffer(state.byteLength), ru = new Uint32Array(read);
      const get = () => { gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(read)); gl.bindBuffer(gl.ARRAY_BUFFER, null); };
      gpu.step(0, streams, field, 1.5); get();
      assert(ru.every((word, i) => word === u[i]), "Zero dt changed state");
      const beforeLive = capacity - free;
      gpu.limit = Math.floor(beforeLive / 2); // shrink below occupancy: do not kill or spawn.
      gpu.step(1 / 60, streams, field, 1.5); get();
      let live = 0;
      for (let i = 0; i < capacity; i++) live += ru[i * 16 + 14];
      assert(live === beforeLive, `Shrink killed/created particles ${live}/${beforeLive}`);
      gpu.limit = capacity;
      gpu.step(1 / 60, streams, field, 1.5); get();
      live = 0;
      for (let i = 0; i < capacity; i++) live += ru[i * 16 + 14];
      assert(live === capacity, `Accepted births ${capacity}/${pattern}: ${live}/${capacity}`);
      assert(gl.getError() === gl.NO_ERROR, "Allocation WebGL error");
      cases++;
    } finally { gl.deleteFramebuffer(fb); scan.dispose(); gpu.dispose(); }
  }
  // An invocation dying now was active in the scan and must wait until the next callback.
  {
    const gpu = new GpuParticles(gl, 3, 42);
    const streams = new StreamSet(1, gpu.lifecycle.canRelease);
    streams.apply(replayFrames[0]); streams.update(0, 1);
    const s = streams.slots[0]; s.center = 0.5; s.half = 0.01; s.rebuildCenters();
    const field = new FlowField(() => 0.5); field.update(0, 1);
    const state = new ArrayBuffer(192), f = new Float32Array(state), u = new Uint32Array(state);
    for (let i = 0; i < 3; i++) {
      f.set([0.5, 0.1, 0, 0, 14, 14, 0, 1, 1, 0, 0, 0], i * 16);
      u.set([0, 1, i === 0 ? 1 : 0, i === 2 ? 0xffffffff : 10], i * 16 + 12);
    }
    preloadGpuState(gl, gpu, state);
    gpu.lifecycle.prepare = () => { gpu.lifecycle.commands.fill(0); gpu.lifecycle.commands.set([1, 1, 0, 3]); gpu.lifecycle.commands[127] = 3; };
    gpu.spawningEnabled = true;
    const read = new ArrayBuffer(192), ru = new Uint32Array(read), rf = new Float32Array(read);
    const get = () => { gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(read)); gl.bindBuffer(gl.ARRAY_BUFFER, null); };
    try {
      // Exactly age==life remains alive with strict expiry, verified in the motion fixture too.
      gpu.step(1 / 60, streams, field, 1); get();
      assert(ru[14] === 0 && ru[15] === 10, "New death respawned immediately");
      assert(ru[30] === 1 && ru[31] === 11, "Dead slot did not accept exactly one birth");
      assert(ru[46] === 0 && ru[47] === 0xffffffff && rf[42] === 1, "Counter wrap did not invalidate");
      gpu.step(1 / 60, streams, field, 1); get();
      assert(ru[14] === 1 && ru[15] === 11, "New death unavailable on following step");
      assert(rf[42] === 1 && ru[47] === 0xffffffff, "Invalid marker was not sticky");
      assert(gl.getError() === gl.NO_ERROR, "Delayed birth WebGL error");
      cases++;
    } finally { gpu.dispose(); }
  }
  // Independent seeded runs must reproduce every integer and Float32 output, including births.
  {
    const first = new GpuParticles(gl, 1000, 42), second = new GpuParticles(gl, 1000, 42);
    const streams = new StreamSet(1); streams.apply(replayFrames[1]); streams.update(0, 1.5);
    for (const s of streams.slots) { s.half = 0.01; s.center = 0.75; s.rebuildCenters(); }
    const field = new FlowField(() => 0.5); field.update(0, 1.5);
    const a = new Uint32Array(16000), b = new Uint32Array(16000);
    first.spawningEnabled = second.spawningEnabled = true;
    try {
      for (let j = 0; j < 100; j++) {
        first.step(0.1, streams, field, 1.5); second.step(0.1, streams, field, 1.5);
        gl.bindBuffer(gl.ARRAY_BUFFER, first.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, a);
        gl.bindBuffer(gl.ARRAY_BUFFER, second.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, b);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        assert(a.every((word, i) => word === b[i]), "Seeded spawning is not repeatable");
      }
      assert(a.some((word, i) => i % 16 === 15 && word > 0), "Seed repeatability exercised no births");
      assert(gl.getError() === gl.NO_ERROR, "Seed repeatability WebGL error");
      cases++;
    } finally { first.dispose(); second.dispose(); }
  }
  {
    const gpu = new GpuParticles(gl, 1, 42), streams = new StreamSet(1);
    streams.apply(replayFrames[0]); streams.update(0, 1);
    const field = new FlowField(() => 0.5); field.update(0, 1);
    const state = new ArrayBuffer(64), f = new Float32Array(state), u = new Uint32Array(state);
    f.set([0.5, 0.1, 0, 0, 13.9, 14, 0, 1, 1, 0, 0, 0]); u.set([0, 1, 1, 1], 12);
    preloadGpuState(gl, gpu, state);
    const get = () => { gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, f); gl.bindBuffer(gl.ARRAY_BUFFER, null); };
    try {
      gpu.step(0.1, streams, field, 1); get(); assert(f[4] === 14 && u[14] === 1, "Strict age=14 expiry");
      gpu.step(0.1, streams, field, 1); get(); assert(u[14] === 0, "Strict age>14 failed to expire");
      cases++;
    } finally { gpu.dispose(); }
  }
  {
    const gpu = new GpuParticles(gl, 31, 42), streams = new StreamSet(1);
    streams.apply(replayFrames[1]); streams.update(0, 1.5);
    for (const s of streams.slots) { s.half = 0.01; s.center = 0.75; s.rebuildCenters(); }
    const field = new FlowField(() => 0.5); field.update(0, 1.5);
    gpu.lifecycle.prepare = () => {
      gpu.lifecycle.commands.fill(0);
      gpu.lifecycle.commands.set([0xf0000001, 1, 0, 2, 0x80000001, 1, 2, 5]);
      gpu.lifecycle.commands[127] = 5;
    };
    gpu.spawningEnabled = true;
    try {
      gpu.step(0.1, streams, field, 1.5);
      const read = new Uint32Array(31 * 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, read); gl.bindBuffer(gl.ARRAY_BUFFER, null);
      for (let i = 0; i < 31; i++) {
        assert(read[i * 16 + 14] === (i < 5 ? 1 : 0), "Request interval birth count");
        if (i < 5) assert(read[i * 16 + 12] === (i < 2 ? 0 : 1) && read[i * 16 + 13] === (i < 2 ? 0xf0000001 : 0x80000001), "Request priority/integer generation");
      }
      cases++;
    } finally { gpu.dispose(); }
  }
  // Exercise the numerical ownership proof near its fastest supported schedule.
  {
    const gpu = new GpuParticles(gl, 1, 42);
    const streams = new StreamSet(1, gpu.lifecycle.canRelease);
    streams.apply(replayFrames[0]); streams.update(0, 1);
    const field = new FlowField(() => 0.5); field.update(0, 1);
    const dt = Math.fround(1 / 240);
    gpu.lifecycle.prepare(dt, streams, 1);
    const state = new ArrayBuffer(64), f = new Float32Array(state), u = new Uint32Array(state);
    f.set([0.5, 0.1, 0, 0, dt, 14, 0, 1, 1, 0, 0, 0]); u.set([0, 1, 1, 1], 12);
    preloadGpuState(gl, gpu, state);
    streams.apply({ v: 1, t: 0, streams: [] }); streams.slots[0].presence = 0;
    let time = 0;
    try {
      while (streams.slots[0].used) {
        const step = time > 14.01 ? Math.fround(LOOK.maxDt) : dt;
        time += step; gpu.lifecycle.advanceTime(step); streams.update(step, 1);
        if (!streams.slots[0].used) {
          assert(u[14] === 0, "Fast schedule released a live Float32 age");
          break;
        }
        streams.slots[0].speed = 0;
        gpu.step(step, streams, field, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.stateBuffer); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, f); gl.bindBuffer(gl.ARRAY_BUFFER, null);
        assert(time < 14.3, "Fast schedule missed safe deadline");
      }
      assert(gl.getError() === gl.NO_ERROR, "Fast schedule WebGL error");
      cases++;
    } finally { gpu.dispose(); }
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { cases };
}
