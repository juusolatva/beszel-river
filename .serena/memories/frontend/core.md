# Frontend Module (`frontend/`)

Static Vite + raw WebGL2 application that renders `Frame` streams as an upward river of rainbow particles with trails.

## Source Map (`frontend/src/`)

- `main.ts` — Entry point: selects `StreamSource` or `DemoSource` (with dev fallback to demo on connection error), manages tab visibility pause/resume, marks all streams offline (dry up) after 20 s without a connection, and drives the `requestAnimationFrame` loop.
- `config.ts` — Visual constants (`LOOK`) and URL query parameter parser (`?demo`, `?debug`, `?streams=N`, `?interval=MS`, `?particles=N`, `?seed=N`).
- `source/source.ts` — `FrameSource` interface.
- `source/stream.ts` — `StreamSource` (`EventSource` on relative URL `"stream"`, exponential reconnect backoff 5 s → 60 s, immediate retry on `online`) and `parseFrame` validator (`v === 1`, channels clamped to `0..1`, `filaments` kept only when length is 6).
- `source/demo.ts` — `DemoSource` procedural channel and filament generator.
- `sim/streams.ts` — Per-stream exponential channel easing, soft-edged braiding band layout, and stream lifecycle (ease-in, offline grey/thinning, removal drain).
- `sim/particles.ts` — Fixed-size CPU particle pool stored in `Float32Array`s; handles bottom-edge band/filament lane spawning, curl-noise turbulence, and ±18° heading clamp.
- `sim/budget.ts` — Adaptive particle budget (scales down live limit to as low as 25% and boosts brightness up to 2× when frame times exceed 1.5× display period and <45 fps; disabled when `?particles=N` is set).
- `sim/noise.ts` — Seeded 2D simplex noise and allocation-free curl flow field.
- `render/renderer.ts` — Alternating ping-pong trail framebuffers (dimmed decay pass + additive streak pass) and final tone-mapping pass; caps `devicePixelRatio` at 1.5.
- `render/gl.ts` — WebGL2 shader compilation, program linking, and framebuffer target helpers.
- `render/shaders/` — GLSL shaders imported with Vite's `?raw` suffix (including OKLCH → linear sRGB conversion in the particle vertex shader).
- `debug/panel.ts` — `?debug` overlay (toggle with `d` key): fps/particle stats, interactive sliders/toggles with `DemoSource`, read-only channel/filament readout with `StreamSource`.
- `util/math.ts` — Seeded PRNG (`mulberry32`), exponential smoothing, clamping, and interpolation helpers.

## Frontend Invariants & Testing

- **Zero per-frame allocations:** `src/sim/` and `src/render/` are on the hot path and must never allocate objects, closures, or arrays per particle or per frame; mutate preallocated typed arrays and use scalar locals.
- **Relative paths:** Keep `base: "./"` in `vite.config.ts` and `"stream"` (no leading slash) in `src/main.ts` so the same build works at `/` and `/river/`.
- **CSP compliance:** Production nginx sends `default-src 'self'` with only inline styles allowed. Never load cross-origin resources or use inline scripts. In nginx configs, keep every `add_header` at `server` level (adding one inside a `location` block drops server-level headers in that location).
- **Browser verification:**
  - Use `?debug` and `?seed=N` for repeatable visual checks.
  - Headless Chromium can run WebGL2 in software (~11 fps) with `--enable-unsafe-swiftshader --use-angle=swiftshader --ignore-gpu-blocklist`. Because SwiftShader pins all CPU cores, never run it on a host whose live Beszel agent is being measured; replay recorded SSE frames instead.
  - Vite's dev proxy keeps `/stream` open when the bridge stops; test lost-connection/reconnect behaviour directly against the bridge (`:8787`) or behind nginx.
