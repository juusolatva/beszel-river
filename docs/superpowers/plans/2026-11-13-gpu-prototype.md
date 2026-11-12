# GPU Particle Prototype Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. This document authorizes no implementation or production migration by itself.

**Goal:** Determine whether GPU particle simulation improves smoothness and CPU headroom on the X280 and a real lower-end phone while preserving the river's appearance and lifecycle rules.

**Architecture:** Use WebGL2 transform feedback to alternate two particle-state buffers and render from the latest buffer directly. Allocate births from a global free-slot prefix scan in integer render targets; no atomics, per-stream particle ranges or CPU particle readbacks. Retain CPU stream easing, layout and coarse flow-field generation. Keep the CPU simulation as the reference and put the experiment in a separate browser harness, outside the public entry point.

**Tech stack:** Existing TypeScript, raw WebGL2/GLSL, Vite and Vitest; no new rendering library.

**Spec:** [docs/PLAN.md](../../PLAN.md), “Frontend performance implementation plan” and “Conditional GPU prototype plan”; repository `AGENTS.md`.

## Scope and decision

This is a measured experiment, not a commitment to rewrite production. Audio is outside scope. Keep the public 10,000-particle ceiling, the existing CPU page and privacy boundary unchanged.

**Decision — 2026-11-13:** The user explicitly chose to go straight to the isolated GPU prototype and drop the fixed 30 Hz/interpolated-rendering alternative. This is an exception to the CPU-first trigger, recorded in `docs/PLAN.md`; it does not complete the pending CPU experiments or hardware acceptance. The November 12 X280 battery run at 960×640/DPR 1.2 recorded 7 ms median, 9–10 ms p95 CPU work and no budget drops. It does not establish a CPU bottleneck at the usual full-screen viewport or on a phone. Task 1 establishes the paired baseline; GPU/fill-rate pressure remains a possible reason to reject migration.

Transform feedback fits the existing WebGL2 renderer and can remove particle-state uploads. A WebGPU rewrite broadens compatibility and scope. Fixed per-stream ranges cannot share free capacity promptly; probabilistic dead-slot respawning cannot guarantee the requested birth rate. The selected global scan solves both at the cost of additional GPU passes, which may make this candidate fail the performance gate. Fixed 30 Hz simulation with interpolated rendering is outside scope and is not a prerequisite or required comparison.

## Global constraints

- Production Node floor remains 24.22.1. Keep exact dependency versions and existing coverage thresholds.
- No per-frame or per-particle allocations in simulation/rendering. Allocate buffers, typed-array views, uniforms and texture storage outside the hot path; resize deliberately.
- No synchronous GPU readback, `finish`, or blocking fence waits in the animation loop. Readbacks are allowed in correctness tests only; asynchronous timing queries must never block.
- Only existing abstract stream channels reach the frontend. Preserve all six filament values and current stream ordering/privacy rules.
- Preserve time clamping, reduced motion, brightness compensation, normalized deposits, RGBA16F and RGBA8 trail behavior.
- Software WebGL verifies correctness only. Performance claims require real hardware and disclosed conditions.
- Work on an isolated experiment branch. Keep the supplied Firefox recording local and untracked. Update this plan's checkboxes only with recorded evidence.

## Task 0: Freeze the authorized experiment baseline

**Files:** Record baseline and branch evidence in this plan; retain the explicit exception in `docs/PLAN.md`.

- [x] Record the current CPU reference SHA and pending source-plan acceptance. Do not wait for interleaved flow sampling or reduced instance writes, and do not fold them into this branch. The explicit exception authorizes an experiment, not a conclusion that CPU work is the remaining bottleneck.
- [ ] Start implementation from a clean experiment branch based on that baseline. Current documentation work is on `feat/gpu-prototype`, based on audio commit `a90be90`; the audio documentation has already reached `origin/main`. Preserve the pending `docs/PLAN.md` and GPU-plan changes. Do not assume the old audio branch or uncommitted `AGENTS.md` changes still exist. Commit the reviewed plan before runtime work and refresh interface references if the baseline changes.

**Baseline recorded — 2026-11-13:** CPU reference `a90be9077096e35749f3b3409193db31ca51635a` on `feat/gpu-prototype`. Remaining CPU experiments and hardware acceptance are pending; this branch does not include them. The supplied plan and source-plan changes are preserved before runtime work.

**Done when:** The CPU reference is frozen and the experiment branch is clean. Paired target-device measurement remains required in Tasks 1 and 6; missing hardware limits the verdict but does not block correctness implementation.

## Review focus

1. All 32 slots rotate while old particles remain: no particle may inherit a new stream's state (Task 3).
2. A shrinking budget or changing band width must not kill visible particles or silently overfill the pool (Tasks 3 and 5).
3. Sparse/draining pools must not hide a GPU regression behind improved dense-pool CPU timings (Task 6).
4. RGBA8 multiple deposit passes must not advance simulation multiple times per display callback (Task 4).
5. Hidden-tab return, resize and context loss must not produce a huge simulation step, stale resources or a misleading successful benchmark (Task 5).

## Task 1: Freeze a reproducible comparison

**Files:** Create `frontend/test/gpu-benchmark.html`, `frontend/test/gpu-benchmark.browser.ts`, and `frontend/test/fixtures/gpu-replay.ts`; reuse conventions from `frontend/test/cpu-benchmark.browser.ts` and `frontend/test/renderer.browser.ts`. Document invocation in `README.md` when executable. Record results under this plan.

- [ ] Inspect the baseline commit and record its SHA, browser version, OS, renderer, target format and power conditions. Keep pending CPU experiments out of this branch.
- [ ] Build a deterministic replay fixture from privacy-safe channel frames: plain and filament streams, pulses, low-flow/high-density saturation, empty river, 1 → 4 → 32 stream expansion, removal and replacement of 32 streams. Use seed 42 and fixed simulation timestamps for correctness; real callback timestamps for performance. The saturation fixture uses flow 0 and density 1; record achieved occupancy rather than assuming a 10,000 limit means 10,000 alive.
- [ ] Give the harness CPU/GPU selection internally; do not add a public URL option or change `main.ts`. Preallocate its timing arrays and summarize after recording.
- [ ] Hold allocated particle capacity at 10,000 in both backends for fixed-limit comparisons: dense runs with spawn limits of 10,000 and 8,000, and a sparse run with a spawn limit of 1,000. The sparse run must retain both full-size GPU state buffers and exercise the normal inactive-slot processing/draw policy. Add a draining run from a populated 10,000-slot pool through zero occupancy, followed by a fully drained measurement with capacity still 10,000. Do not substitute a 1,000-slot allocation for sparse occupancy. Record capacity, spawn limit, actual live count, simulated slots and draw capacity separately.
- [ ] Capture callback and simulation/submission median/p95/p99, frame-interval distribution, missed display periods, limit, uploaded bytes and draw/pass counts. Record a preallocated replay trace from initialization through warmup and measurement: callback intervals/clamped dt, applied frame indices, resize/motion/offline events and effective limit/intensity changes, with measurement boundaries. Mark a run invalid if trace storage overflows. Never label submission time as GPU time.
- [ ] Implement the occupancy-validation protocol below before interpreting performance comparisons. Timed GPU runs contain no particle readbacks; live-count results must identify their untimed validation source, and conservative runtime estimates must be labelled separately.
- [ ] Use three 60-second measurements after a 30-second warmup, on X280 AC and battery separately. Measure both 960×640 CSS pixels and the device's usual full-screen viewport, recording actual viewport/DPR, refresh rate, power mode, other load and thermal conditions. Identify an available lower-end phone and its full-screen dimensions; if unavailable, mark phone acceptance unverified.

**Done when:** The CPU replay is repeatable, its run-to-run spread is recorded, and the backend-independent fixture/trace format is fixed for later GPU integration. GPU consumption is verified in Tasks 4–5. Save metadata and aggregate results, not private browser-profile contents.

### Occupancy-validation protocol

After each measured run, reset the same backend with the same seed and replay its complete trace without timing it. Use recorded dt and events, never the validation callbacks' wall time. Replay recorded budget decisions rather than recalculating them from readback-inflated work times. Read back GPU active flags and stream identities after each simulated callback to obtain exact total and per-stream counts; collect the equivalent CPU counts directly. Preserve these counts with the trace/run identifier and report their time-weighted mean, minimum and maximum over the measurement window. Weight the post-step count by that callback's clamped simulation dt; five-second windows are simulation-time windows. Report callback-interval-weighted occupancy separately as a wall-time diagnostic, including any pauses. A readback after the timed run has stopped must match the validation replay's final active/slot/generation state; a mismatch invalidates that run's occupancy evidence. Readback work must finish before another performance warmup starts.

Also replay each trace through the other backend, using the identical recorded schedule and limit decisions. This separates spawning differences from different display cadences. Before applying the performance keep threshold, require total and per-stream mean occupancy in every aligned five-second steady dense/sparse window to differ by no more than `max(5 particles, 5% of the CPU mean)`. These are initial acceptance bounds, fixed before results are collected; any later revision needs a rationale and rerun. Do not average sparse, draining or rotation phases into dense windows. For draining/rotation, report the exact count curves, time to zero and replacement delay under Task 3's lifecycle acceptance instead; the fully drained measurement requires zero live particles in both backends throughout. Failed occupancy parity makes the performance comparison inconclusive, even if callback work improves; retain and report the raw results.

## Task 2: Prove GPU motion on a small deterministic fixture

**Files:** Create `frontend/src/sim/gpu-particles.ts`, `frontend/src/sim/gpu-layout.ts`, `frontend/src/render/shaders/simulate.vert`, `frontend/src/render/shaders/simulate.frag`, `frontend/test/gpu-particles.test.ts`, `frontend/test/gpu-layout.test.ts`, `frontend/test/gpu-particles.browser.ts`, and `frontend/test/fixtures/gpu-state.ts`. Extend `frontend/src/render/gl.ts`, `frontend/test/gl.test.ts`, `frontend/test/fake-gl.ts`, `frontend/src/sim/noise.ts`, `frontend/test/noise.test.ts`, `frontend/src/sim/streams.ts`, and `frontend/test/streams.test.ts` only for the contracts below.

**Interfaces:**

- `createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, feedbackVaryings?: readonly string[]): Program` registers varyings before link using `gl.INTERLEAVED_ATTRIBS`. Omitted varyings preserve all current callers.
- `FlowField` exposes readonly getters `gridCols: number`, `gridRows: number`, `gridCell: number` and `writeVelocityGrid(out: Float32Array): void`; the latter writes exactly `gridCols * gridRows * 2` interleaved vx/vy floats into caller-owned storage. No allocation on unchanged dimensions.
- `StreamSlot.writeCenters(out: Float32Array, offset: number): void` copies its 64 cached centres into caller-owned storage; no private-array access or per-frame views.
- `new GpuParticles(gl: WebGL2RenderingContext, capacity: number, seed: number)` owns the two state buffers, flow/stream/command textures and, from Task 3, the free scan and `readonly lifecycle: GpuLifecycle`. The latter type/module is added in Task 3, with `step` delegating birth preparation to it then. Task 2 runs motion-only fixtures with spawning disabled.
- `GpuParticles.step(dt: number, streams: StreamSet, field: FlowField, aspect: number): void` uploads inputs and advances once. DPR is absent from physics. Readonly getters `stateBuffer: WebGLBuffer`, `stateStrideBytes: number`, `capacity: number`, `streamTexture: WebGLTexture`, `commandTexture: WebGLTexture`, and `globalHue: number` are the draw contract. `globalHue` is owned here and advances only on positive steps with `fract(globalHue + LOOK.hueRotate * dt)`. `limit: number` controls spawning; `spawningEnabled: boolean` defaults false until Task 3 enables it in the harness. `dispose(): void` releases owned resources.
- Test-only `preloadGpuState(gl: WebGL2RenderingContext, particles: GpuParticles, state: ArrayBuffer): void` in `frontend/test/fixtures/gpu-state.ts` uploads one capacity-sized fixture to `stateBuffer` before stepping. Fixtures use shared `Float32Array` and `Uint32Array` views; no public preload/readback method or test fixture is imported by production.

### Fixed state and texture layouts

`gpu-layout.ts` exports `GPU_STATE_STRIDE_BYTES = 64`, `GPU_MOTION_OFFSET_BYTES = 0`, `GPU_LIFETIME_OFFSET_BYTES = 16`, `GPU_SPAWN_OFFSET_BYTES = 32`, `GPU_IDENTITY_OFFSET_BYTES = 48` and readonly `GPU_FEEDBACK_VARYINGS = ["v_motion", "v_lifetime", "v_spawn", "v_identity"]`, shared by simulation, free scan, drawing and fixture tests:

| Byte offset | Attribute / varying type | Components |
| --- | --- | --- |
| 0 | vec4 | x, y, vx, vy |
| 16 | vec4 | age, life, hueJitter, size |
| 32 | vec4 | speedJitter, laneOffset, reserved=0, reserved=0 |
| 48 | uvec4 | streamSlot, generation, active (0/1), spawnCounter |

Bind float attributes with `vertexAttribPointer`, identity with `vertexAttribIPointer(..., gl.UNSIGNED_INT, 64, 48)` in every VAO consuming state. Simulation uses locations 0–2 for float vectors and 3 for identity; the drawer uses corner=0, float vectors=1–3, identity=4, with divisor 1 on all particle attributes. The flag pass binds identity only. Integer shader outputs use `flat out`; shaders use `#version 300 es` with explicit highp float/int/sampler precision. `simulate.frag` is a valid minimal fragment shader even with rasterization discarded. This layout uses 16 interleaved feedback components and four state attributes; the draw path adds one corner attribute.

Use textures instead of vertex uniform arrays for the 32 × 64 centres and stream data. The following layouts are fixed; texel x is the column, y is the stream slot:

| Texture | Storage / dimensions | Contents |
| --- | --- | --- |
| Flow | RG32F, gridCols × gridRows | vx, vy; fetch four integer coordinates and bilinearly combine with the CPU's `cols - 1.001` / `rows - 1.001` clamps |
| Stream | RGBA32F, 24 × 32 | x=0: center/half/speed/turbulenceAmp; 1: phase/braidAngle/hueOffset/filamentMix; 2: brightness/chroma/streakSeconds/presence; 3: filaments[0..3]; 4: filaments[4..5]/laneWeights[0..1]; 5: laneWeights[2..5]; 6: spawnWeight/shareWeight/0/0; 7: reserved zeros; 8..23: 64 centres, four per texel |
| Command | RGBA32UI, 1 × 32 | generation, used (0/1), requestStart, requestEnd (exclusive); populated by Task 3 |

Flow/stream textures are sampled only, so do not require float color-buffer or float-linear-filter extensions. Allocate with `texImage2D`, upload with `texSubImage2D`; flow storage is redefined when grid dimensions change. Set MIN/MAG filters to NEAREST and S/T wraps to CLAMP_TO_EDGE on every data texture, including integer scan textures. Use `texelFetch` at level 0; match centre interpolation over [-0.02, 1.08] and analytic fallback outside using uploaded phase/braidAngle/half. Simulation sampler units are 0=flow, 1=stream, 2=command, 3=free-prefix; draw units are 1=stream, 2=command. Query limits once at setup and fail unsupported runs explicitly. Four vertex texture units, five vertex attributes and 16 feedback components stay within WebGL2 minimums; no 2,048-float centre uniform array is permitted. Check API/storage/buffer rules against the [Khronos WebGL2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/).

**GL state boundary:** On every simulation/scan exit, including failures, disable RASTERIZER_DISCARD in `finally`, end begun transform feedback, immediately clear indexed feedback binding 0 with `bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)`, clear its generic binding, and unbind the feedback object, VAO, ARRAY_BUFFER and framebuffer. Unbind used data textures and leave activeTexture at TEXTURE0. Never use a buffer as an attribute while it is an indexed feedback output, even after feedback has ended. Passes set their own viewport/blend state; do not use per-frame state-query snapshots.

- [ ] Write failing fake-GL tests for varying registration before link, integer/float bindings and stride/offset agreement, distinct input/output buffers, swapping, texture allocation/upload/resize, cleanup after exceptions and disposal. Extend `fake-gl.ts` to track active texture units, indexed feedback bindings and attribute-buffer use; reject forbidden double binding. Cover actual compile/link failures in a browser too.
- [ ] Run `npm test -w frontend -- test/gl.test.ts test/noise.test.ts test/streams.test.ts test/gpu-layout.test.ts test/gpu-particles.test.ts` and confirm the new contract assertions fail before implementing them.
- [ ] Implement the fixed layouts and motion-only pass with preloaded particles. Port CPU age increment, strict `age > life` and pre-motion boundary deaths, inertia, steering, slope clamp and Float32 storage order. Source LOOK constants from CPU configuration; preload identical state to isolate motion from RNG differences.
- [ ] Test centre interpolation/fallback, zero width, flow corners/exterior coordinates, same-size uploads and aspect resize. Do not introduce `texImage2D` or typed-array allocation on ordinary frames.
- [ ] Run small shader-executing fixtures against a CPU reference with identical initial state and inputs: zero dt, 1/240, 1/60, 1/30 and LOOK.maxDt, plain/filament motion, lifetime expiry and exits. Initial tolerances: 1e-5 world units for one-step positions/velocities, 1e-3 after 120 steps; discrete active/slot/generation values must match exactly. Investigate failures before adjusting tolerances, and record any justified changes.
- [ ] Pass the targeted tests and real-shader checks, then typecheck/coverage/build before the logical commit. Preserve 90% statements/functions/lines and 80% branches for all new sim/render modules; fake-GL orchestration tests must cover failure branches, not just browser tests.

**Done when:** Real GPU readbacks prove finite state and motion agreement; fake calls alone do not pass this gate. Test readbacks are outside measured runs.

## Task 3: Solve spawning, accounting and safe slot reuse

**Files:** Create `frontend/src/sim/gpu-lifecycle.ts`, `frontend/src/sim/gpu-free-scan.ts`, `frontend/src/render/shaders/free-flags.vert`, `frontend/src/render/shaders/free-flags.frag`, `frontend/src/render/shaders/free-scan.frag`, `frontend/test/gpu-lifecycle.test.ts`, `frontend/test/gpu-free-scan.test.ts`; extend GPU shader/browser tests and `frontend/src/sim/streams.ts` / `frontend/test/streams.test.ts` for the mandatory release seam. Reuse `fullscreen.vert` for scan passes.

**Interfaces:** `new GpuLifecycle(capacity: number)` owns preallocated per-stream generation, request, fractional carry and deadline arrays; `advanceTime(dt: number): void`, `prepare(dt: number, streams: StreamSet, limit: number): void`, `readonly commands: Uint32Array` (32 × 4 words), and a stable callback `canRelease: StreamReleasePolicy`. Export `type StreamReleasePolicy = (slot: StreamSlot, index: number) => boolean` from `streams.ts`; `new StreamSet(motion: number, canRelease?: StreamReleasePolicy)` defaults to `slot.particles === 0`. Its existing `!slot.inFrame && slot.presence < 0.01` guard remains. Invoke the policy with the slot's stable array index; pending frames still retry on release without another SSE event. GPU mode never populates `StreamSlot.particles` with an estimate.

`new GpuFreeScan(gl: WebGL2RenderingContext, capacity: number)` exposes `scan(stateBuffer: WebGLBuffer): void`, readonly `prefixTexture: WebGLTexture`, `width: number`, `height: number`, and `dispose(): void`. It owns flag/scan programs, VAOs, two R32UI textures and framebuffers. It reads Task 2's 64-byte state; no CPU count or readback is returned.

### Global allocation and step order

There are exactly `capacity` independent particle slots, with no per-stream reserved range. A single stream can fill all capacity; subsequent streams compete for every free slot under the same stream-index request ordering as CPU spawning. This removes range fragmentation, divisibility rules and extra ownership starvation on 1 → 32 expansion. A full pool still waits for natural deaths, as does the CPU pool.

For every positive simulation step, in this order:

1. Harness calls `gpu.lifecycle.advanceTime(dt)`, then `streams.update(dt, aspect)`, then `field.update(t, aspect)`. The stable release callback sees the current simulation clock and the previous step's last-possible-spawn records.
2. `gpu.step` calls `lifecycle.prepare(dt, streams, limit)`, synchronizes claimed IDs/generations, and uploads stream/command/flow textures. Per used stream, compute the CPU rate `limit / LOOK.turnoverSeconds / max(sum(shareWeight), MIN_SHARE)`, add `rate * spawnWeight * dt` to fractional carry, take floor, subtract it even if the pool cannot accept births, and encode cumulative requestStart/requestEnd in stable stream-index order. When total share is zero issue no requests. Suppress requests only for removed streams with presence < 0.01; the CPU reference's tiny residual tail is an intentional difference to measure.
3. Scan **pre-step** inactive flags. Clear the R32UI target using `clearBufferuiv` with a preallocated zero vector. Draw one 1-pixel point per slot at its integer texel centre: 1 for inactive, 0 for active. Disable blending, dithering, depth and scissor; padded texels remain zero. Texture width is `min(128, capacity)`, height is `ceil(capacity / width)`; map index i to `(i % width, i / width)` with integer division.
4. Inclusive Hillis–Steele prefix sum over flattened indices: ping-pong fullscreen passes at offsets 1, 2, 4, … < capacity. Each valid texel sums its previous value and the previous value at i-offset when valid; each padded texel writes zero. Never sample the current draw attachment. R32UI/RED_INTEGER/UNSIGNED_INT needs no float-rendering extension. For 10,000 slots this is one flag pass and 14 scan passes; capacity=1 needs no scan pass.
5. Transform-feedback invocation i reads its original active state. Let `freeTotal = prefix[capacity-1]`, `liveBefore = capacity - freeTotal`, and `births = min(totalRequests, max(0, limit - liveBefore), freeTotal)` using guarded unsigned subtraction. An originally dead slot has rank `prefix[i]-1`; it spawns iff rank < births, finding its stream from the command request interval containing rank. Every accepted rank maps to exactly one dead slot. Active invocations cannot spawn, and deaths during this pass cannot spawn again until the next callback. Thus dead fraction cannot attenuate the birth rate, and immediate death-driven respawning cannot accelerate it.
6. Initialize accepted births, then increment age/check death/advance motion, matching CPU spawn-before-step order. Newly born particles have age=dt after their first positive step. The public page's initial callback has dt=0 and does neither; do not manufacture births on that callback. For dt <= 0, skip time, requests, carry, scan, state swap, hue and motion entirely.

The exact live count is GPU-local for the spawn-limit decision; it is not a CPU budget input. CPU counters are requests, never alleged live counts. No per-frame particle upload, CPU free list or synchronous readback is required.

### Lifecycle/state transitions

| State / transition | Ownership and allowed action | Release / reuse |
| --- | --- | --- |
| Particle inactive | No stream ownership; retains spawnCounter for its next birth | Any requested stream can take its unique free rank |
| Particle born → active | Store stream slot and current generation; increment spawnCounter | Keep identity through motion; no reassignment while active |
| Active → dead | Strict age/boundary death; active=0 | Eligible starting next step's scan |
| Stream claimed/present | Increment generation on a new ID; retain it on the same ID; allow eased requests | Initialize lastPossibleSpawn to claim time, then update to current simulation time whenever eligible to request, conservatively even if accepted births are unknown |
| Stream removed, presence >= 0.01 | Keep old parameters and eased requests | No release |
| Removed, presence < 0.01 | Stop requests; retain stream parameters while old particles die | Release only when simulation time > lastPossibleSpawn + LOOK.lifeRange[1] + LOOK.maxDt (14.1 s) |
| Same ID reappears before release | Keep generation and existing particles; resume eased requests | Cancel the drain deadline and refresh lastPossibleSpawn before any later removal can release it |
| Stream safely released / new ID claims slot | Old particles must all be dead before incrementing generation | Retry latest pending frame immediately, even with no new SSE frame |

`canRelease` also checks that its tracked ID matches the slot; uninitialized/mismatched records cannot authorize release. Generation/spawn-counter wrap invalidates the run rather than aliasing identities. Generation mismatch in a shader is a correctness failure in validation (defensively clip it during drawing); it is not permission to reuse a live stream slot. Release can lag the exact CPU count: presence decay from 1 takes about 9.21 s, followed by at most the 14.1 s conservative interval and one update callback. Record CPU/GPU removal-to-last-birth, time-to-zero and pending-claim curves. Each GPU pending claim must occur no later than the first update after its safe deadline; do not average this roughly 23.3 s worst-case removal bound into steady-state occupancy parity. The conservative delay remains an explicit acceptance risk, not a solved production-equivalence claim.

Use uint32 PRNG arithmetic, never sin hashes or signed shifts. Seed a local generator from experiment seed XOR particleIndex×0x9e3779b9 XOR generation×0x85ebca6b XOR spawnCounter×0xc2b2ae35 (all uint32). Use the PCG RXS-M-XS step: state=state×747796405+2891336453; word=((state >> ((state >> 28)+4)) XOR state)×277803737; output=(word >> 22) XOR word. Convert its top 24 bits with `float(output >> 8) / 16777216.0`, ensuring u < 1 and `1.0-u > 0` for Box–Muller. The generator's temporary state is uint; the persistent integer birth counter is in the identity attribute. Match CPU spawn distributions and weighted filament selection, not its random sequence or LIFO free-slot order. Motion tests inject identical state independently of RNG.

### Byte and work budget

At capacity 10,000: two 64-byte state buffers = 1,280,000 bytes; two 128×79 R32UI scan textures = 80,896 bytes; stream texture = 12,288 bytes; command texture = 512 bytes. Total additional simulation storage = **1,373,696 GPU bytes**, plus `8 * gridCols * gridRows` flow bytes. The shared Renderer still allocates its existing 360,000-byte CPU instance buffer in both variants (unused by GPU drawing), plus geometry/program resources and trail targets; include these in total memory rather than counting only the new storage. CPU staging is preallocated: flow, stream, command, lifecycle arrays and benchmark trace; list their actual bytes in the run ledger. No second CPU particle simulation runs during GPU timing. Every positive step processes full capacity in flag/feedback passes, 14 padded scan passes at 10,000, and full-capacity drawing on each deposit. Lowering the limit reduces births/overdraw, not that vertex/scan work. A performance rejection because of scan overhead is a valid outcome.

- [ ] Write failing lifecycle tests for the rate/carry equations, zero shares, command intervals, slot-index priority, discarded excess requests, deadlines including strict max-life expiry, reappearance resets, generation rollover, pending retries and CPU default release. Run `npm test -w frontend -- test/streams.test.ts test/gpu-lifecycle.test.ts` to verify the failures before adding the seam/lifecycle implementation.
- [ ] Write failing scan/feedback tests for capacities 1, 31, 33, 100 and 10,000, padded zeroes, integer texture completeness, no source/destination alias, state cleanup and resource failures. Run `npm test -w frontend -- test/gpu-free-scan.test.ts test/gpu-particles.test.ts` and confirm failures before implementing the fixed scan algorithm and spawn selection. Run it again and require passing assertions.
- [ ] Prove exact prefix values and accepted birth counts with real-shader readbacks: all dead, all live, alternating holes, the review's 2,075-live/425-dead case, full-pool overflow, shrink/grow and newly dying slots waiting one step. Use injected requests to separate exact allocation from statistical RNG parity.
- [ ] Add deterministic long shader runs comparing CPU/GPU total/per-stream occupancy under Task 1's bounds, including 1 → 4 → 32 expansion, low-flow saturation, filament lane histograms and variable lifetime/exit distributions. Check seed repeatability, finite Box–Muller samples and no spawn at zero dt.
- [ ] Test removal, reappearance, empty frames, full 32-stream daily rotation, repeated pending replacements, strict `age > life` at 14 s, and hidden-tab/LOOK.maxDt schedules. Assert identity never changes while a particle is active, all released generations have zero live particles, and pending claims meet the safe-deadline bound. Report conservative replacement latency against CPU exact counts for visual acceptance.
- [ ] Pass unit tests, real shaders, typecheck/coverage/build before committing. If allocation parity or safe release fails, stop this candidate rather than weakening the gate or adding a blocking readback.

**Done when:** Ownership and pending replacement are proven safe, and every intentional lifecycle/distribution difference is visible in the results. This gate may reject the prototype before further integration.

## Task 4: Draw directly from GPU state

**Files:** Create `frontend/src/render/gpu-particle-drawer.ts`, `frontend/src/render/shaders/particle-gpu.vert`, `frontend/test/gpu-particle-drawer.test.ts`; extend `frontend/src/render/renderer.ts`, `frontend/test/renderer.test.ts`, `frontend/test/renderer.browser.ts`, and GPU browser tests.

**Interfaces:** Preserve `Renderer.render(instances: Float32Array, count: number, dt: number, aspect: number): void` for CPU callers. Export `GpuDrawSource` from `renderer.ts` with `draw(aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number, depositScale: number): void`. Add `Renderer.renderGpu(source: GpuDrawSource, dt: number, aspect: number, devicePixelRatio: number, globalHue: number, intensityScale: number): void`, using the same trail/present code and calling source.draw per deposit pass. `new GpuParticleDrawer(gl: WebGL2RenderingContext, particles: GpuParticles)` implements that interface using the latest Task 2 buffer/stride/textures and full `particles.capacity`; `dispose(): void` releases its program/VAOs/quad. Harness passes `particles.globalHue` from the single simulation owner.

Only `gpu-particle-drawer.ts` imports `particle-gpu.vert?raw`; only the experimental harness imports the drawer implementation. `Renderer` depends on its interface, never the GPU shader/class. Lazily compile/create GPU program/VAOs on first drawer draw, outside measurements (warmup/preflight). The production renderer constructor must still link exactly three programs; Vite's production import graph must contain no GPU shader/simulation or benchmark code.

- [ ] Write failing tests for the unchanged three-link CPU constructor, lazy GPU setup, integer instanced identity bindings, latest buffer after swaps, draw capacity, zero particle-instance `bufferSubData` and no feedback/attribute double binding. Run `npm test -w frontend -- test/renderer.test.ts test/gpu-particle-drawer.test.ts`, then implement the separate drawer and shared trail entry point.
- [ ] Render inactive entries as degenerate/clipped primitives, without visible deposits. Draw capacity and live count are different quantities; report both.
- [ ] Share existing fragment shading, tone mapping and trail accumulation. Keep the CPU shader/attribute path intact. Explicitly call `activeTexture(TEXTURE0)` immediately before the present-pass bind in the shared renderer, even if no accumulation occurred. Add a regression starting on TEXTURE1 with RGBA8 trailTime < 1/60 at 120/240 Hz: the present sampler must read the trail, never flow/stream data. Check drawer cleanup leaves TEXTURE0 active, data textures/VAO/ARRAY_BUFFER unbound and rasterization enabled.
- [ ] Test intensityScale and normalized deposit application exactly once. Exercise zero dt, empty pools and 30/60/120/240 Hz synthetic schedules in RGBA16F and RGBA8.
- [ ] Confirm RGBA8 repeated accumulation reads the same simulated state for that callback, matching the current renderer's behavior. Simulation advances once per callback.
- [ ] Compare seeded recordings visually for band structure, filament weighting, colour, streak widths, brightness and draining. Use image/readback tolerances for deterministic small fixtures; do not require pixel-identical full rivers with different spawning sequences.
- [ ] Pass targeted unit tests, real shader tests, typecheck/coverage/build before committing. Inspect the production build's module graph/assets to verify GPU modules/shader strings are absent; a runtime flag hiding an eagerly bundled shader does not satisfy isolation.

**Done when:** End-to-end GPU replay renders correctly without uploading the full particle instance array each frame.

## Task 5: Replay budget decisions and verify failure behavior

**Files:** Extend the GPU benchmark harness, GPU lifecycle tests and browser tests; inspect `frontend/src/sim/budget.ts` and `frontend/src/main.ts` for behavior to reproduce.

**Budget contract:** `ParticleBudget.update(interval, live, workSeconds)` gates accumulation toward further overload drops with `live <= limit`; recovery fastTime does not inspect live. A 14.1-second request-count bound can approach twice the limit in steady state and stall successive drops. Do not feed a conservative request count into that API or advertise native GPU adaptation. The measured GPU workload still processes/draws full capacity after a limit drop.

- [ ] Record a CPU adaptive discovery trace using exact CPU live count, complete callback work and actual intervals with the unmodified `ParticleBudget`. Changes apply to the next step, as in `main.ts`. Record the resulting limit/intensity schedule from initialization onward. This discovery is not a paired performance result.
- [ ] For a matched-schedule comparison, run both CPU and GPU with budget recalculation disabled and replay that schedule at its recorded simulation-time boundaries; record the effective decisions for each callback. Untimed validation replays those effective decisions exactly. Label both as **CPU-schedule replay**, not independent adaptive runs. Retain separate natural CPU-adaptive results as reference. Native GPU adaptation needs a separately designed/measured asynchronous exact-summary strategy and is outside this prototype's acceptance.
- [ ] Add harness tests asserting a decision takes effect on the following step, no GPU count reaches ParticleBudget, both backends consume the same schedule, and each run saves its effective decisions. Retain CPU budget regression tests for live-above-limit stalling further drops, eventual further overload drops, recovery independent of live, and intensityScale; never change production hysteresis to make GPU results pass.
- [ ] Test reduced motion, stream loss/recovery, zero dt, long pauses and hidden-tab return with the same time clamping as the public page. Use simulation time for drain deadlines; a hidden tab must not make live GPU state instantly reusable.
- [ ] Test landscape/portrait resize, DPR changes and target allocation failure. Dispose/recreate resources only at explicit lifecycle boundaries.
- [ ] On unsupported resources, compile/link failure or context loss, stop the experimental run cleanly and mark it failed. Permit an explicit CPU restart in the harness; do not silently change backends halfway through a benchmark. Production fallback/restoration design is a separate migration task.
- [ ] Run `npm run typecheck`, `npm run coverage`, and `npm run build`. Run shader tests separately from coverage, following the existing browser-test invocation style documented in README. Keep thresholds and timeouts intact.

**Done when:** Correctness checks pass and both fixed-limit and clearly labelled CPU-schedule comparisons can run without silently changing workloads or backends. Native GPU adaptation remains unimplemented and cannot be claimed as validated.

## Task 6: Measure and decide

**Files:** Record the result ledger here and summarize the decision in `docs/PLAN.md`; document runnable harness commands in `README.md`.

- [ ] Repeat Task 1 with paired CPU/GPU order alternated across runs. Use identical replay, seed, viewport, DPR, allocated capacity, limits, browser and power mode. Test dense, sparse, draining, expansion and rotation workloads at 960×640 and full-screen, then Task 5's CPU-schedule replays separately. Attach untimed occupancy validation to every measured run, with effective decisions and occupancy/limit trajectories separate from fixed-limit comparisons. No 30 Hz/interpolated-rendering comparison is required under the explicit user decision.
- [ ] Measure optional `EXT_disjoint_timer_query_webgl2` timings only when supported. Add minimal local extension declarations in `frontend/test/gpu-benchmark.browser.ts` because TS DOM types omit it. Preallocate a query ring, poll QUERY_RESULT_AVAILABLE across later callbacks without waiting, skip samples when the ring is full, and discard affected samples on GPU_DISJOINT_EXT. Null extension/context loss yields unavailable GPU timing, never CPU submission time relabelled as GPU time. Count query overhead in callback work and disclose enabled/disabled runs. Include flag plus all prefix-scan passes, flow/stream/command uploads, full-capacity inactive feedback/draw processing, trail passes and both state buffers in cost accounting.
- [ ] Run on X280 AC, X280 battery, and a real lower-end phone. Record sustained thermal behavior, memory and available power measurements alongside callback work and cadence. Do not infer lower power from lower CPU time alone.
- [ ] Proposed keep threshold, conditional on passing Task 1's occupancy parity gate: at least 20% lower median and p95 callback work in dense runs on both target devices, exceeding observed run-to-run variation; frame cadence must improve or remain within baseline variation. Sparse/draining and fully drained p95 frame intervals must not regress beyond baseline variation. Report raw results even if this threshold is missed.
- [ ] Require visual/lifecycle acceptance from Tasks 3–5 and no measured material power/thermal regression. Missing phone/power evidence limits the conclusion; it cannot establish production readiness.
- [ ] Write one decision: **keep for further evaluation**, **reject**, or **inconclusive**. List unresolved semantic differences, conservative stream-replacement latency, unimplemented native GPU adaptation, remaining CPU costs and hardware gaps. A successful prototype supports a separate production proposal covering exact accounting/adaptation, fallback, context restoration, maintenance and public configuration.

**Done when:** Results support an explicit decision. Do not mark production migration complete or claim a universal lower-end-device improvement.

## Result ledger

Implementation has not started. All checks above are pending. The 2026-11-13 user decision permits the GPU experiment before the remaining CPU optimizations and removes the 30 Hz alternative; it supplies no performance evidence.

| Variant / commit | Device / power / browser | Replay / viewport / DPR / capacity / limit | Callback median / p95 / p99 | Frame intervals / missed periods | Validated live min/mean/max / simulated slots / draw capacity / trace ID | GPU / memory / power | Decision / occupancy parity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPU baseline | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| GPU prototype | Pending | Same workload | Pending | Pending | Pending | Pending | Pending |
