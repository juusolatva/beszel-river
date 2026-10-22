# beszel-river plan

## Goal

A public web page showing a continuous river of rainbow-coloured particles with trails, flowing from the bottom edge upwards. Live metrics from the servers tracked by the Beszel hub steer the river's speed, density, turbulence, bursts and colour drift. The motion itself is procedural; the data modulates it. A viewer should not be able to tell which host or metric drives which effect, but every change in the river comes from real data.

## Decisions

| Area | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | Bridge and frontend share the message types. |
| Runtime | Node.js 24 LTS in production (`.nvmrc`), ≥ 22.12.0 supported | `vite` 8 and `eventsource` 5 require ≥ 22.12.0. |
| Repository | npm workspaces: `shared`, `bridge`, `frontend` | One lockfile, no extra tooling. `.npmrc` sets `save-exact=true`. |
| Compiler | `typescript` 7.0.2 | Type-checking everywhere; emits the bridge build. |
| Bridge dev runner | `tsx` 4.23.15 | Watch mode without a build step. |
| Bridge HTTP | `node:http`, no framework | Only two endpoints. |
| Beszel client | `pocketbase` 0.28.1 + `eventsource` 5.1.3 | The SDK handles login refresh and realtime reconnects; Node needs an `EventSource` polyfill for it. |
| Browser transport | Server-Sent Events | One-way, browser `EventSource` reconnects by itself, simple through nginx. |
| Frontend build | `vite` 8.3.4 | Dev server with proxy, static production build. |
| Rendering | Raw WebGL2, no library | Small needs: a few shaders and two framebuffers. |
| Tests | `vitest` 5.0.5 (bridge) | Normalization and mixing are pure functions. 4.1.12 hit an npm 10 peer-resolution bug in this workspace. |
| CI | GitHub Actions: `npm ci`, `typecheck`, `test`, `build` on Node 22.12.0 and 24 | `.github/workflows/ci.yml`; tests both ends of the supported range. |

## Architecture

```
Beszel agents ──► Beszel hub (PocketBase, :8090, on the VPS)
                        │  realtime subscription, logged in as a read-only user
                        ▼
                 bridge (VPS, 127.0.0.1:8787)
                   ingest → normalize → mix → anonymize → broadcast
                        │  SSE GET /stream (abstract channels only)
                        ▼
                 nginx ── static frontend (WebGL2) ──► browsers
```

- Credentials stay in the bridge.
- Raw metrics never leave the bridge, so the browser (and its devtools) only ever sees abstract channels.
- One upstream subscription serves every viewer, so visitors add no load on the hub or agents.

### Package boundaries

- `shared` is type-only. Its `exports` has only a `types` condition, so a runtime import fails; consumers use `import type`.
- The demo data generator lives in `frontend`, because it produces channels directly.

## Repository layout

Current files plus the planned ones (milestone in brackets).

```
.github/workflows/ci.yml      CI
AGENTS.md                     instructions for coding agents
CLAUDE.md                     imports AGENTS.md
docs/PLAN.md                  this plan
shared/src/index.ts           message types [M1]
bridge/
  .env.example                configuration template
  mix.example.json            mixing weights template; real bridge/mix.json is git-ignored
  tsconfig.json               type-checks src and test
  tsconfig.build.json         emits src to dist
  src/
    main.ts                   entry: config, wiring, reconnects, broadcast debounce, pulse ticks
    config.ts                 env parsing and validation
    log.ts                    timestamped log lines with error cause chains
    beszel/types.ts           the Beszel record fields the bridge reads
    beszel/client.ts          login, token refresh, EventSource polyfill
    beszel/systems-source.ts  60 s adapter
    beszel/realtime-source.ts 1 s adapter [M6]
    pipeline/features.ts      samples, 24 h baselines, 0..1 features
    pipeline/mix.ts           features → channels, mix.json parsing
    pipeline/anonymize.ts     stream IDs, band order, band widths
    pipeline/hosts.ts         per-host state → frames
    server.ts                 GET /stream, GET /healthz
  test/                       vitest unit tests
frontend/
  index.html
  vite.config.ts              dev proxy /stream → bridge
  src/
    main.ts                   entry: wiring and frame loop
    config.ts                 look tunables (LOOK) and URL parameters
    source/source.ts          FrameSource interface
    source/stream.ts          EventSource client [M4]
    source/demo.ts            generated channels for development
    sim/streams.ts            per-stream eased state, band layout, lifecycle
    sim/particles.ts          particle pool and motion
    sim/noise.ts              simplex noise, curl flow field
    render/renderer.ts        trail buffers, particle pass, tone mapping
    render/gl.ts              WebGL2 program and render-target helpers
    render/shaders/           GLSL, including OKLCH → sRGB
    debug/panel.ts            ?debug panel: channel sliders, stats
    util/math.ts              PRNG, easing, small helpers
deploy/
  bridge.Dockerfile           [M5]
  compose.yml                 [M5]
  nginx/river.conf            [M5]
```

## Data source: Beszel hub

From the Beszel source on `main` (latest release v0.21.0, 2 Oct 2026):

- **API:** PocketBase REST and realtime at `BESZEL_URL`.
- **Login:** `POST /api/collections/users/auth-with-password`; renew with `POST /api/collections/users/auth-refresh`.
- **Access:** Beszel sets the API rules in `internal/hub/collections.go`. A user can list `systems` and `system_stats` when they are in the system's `users` list, or for every system when the hub runs with `SHARE_ALL_SYSTEMS=true`. Give the bridge user the `readonly` role: it can read but not change systems.
- **`systems` collection:** one record per host with `id`, `name`, `status` and `info`. Relevant `info` keys: `cpu`, `mp` (memory %), `dp` (disk %), `bb` (bandwidth bytes/s), `la` (load averages), `t` (threads), `dt` (dashboard temperature). The hub refreshes these every 60 s (`interval int = 60_000` in `internal/hub/systems/system_manager.go`).
- **`system_stats` collection:** history records with a `type` tier (`1m`, `10m`, `20m`, `120m`, `480m`) and a `stats` object.
  - Rates: `cpu`, `mp`, `b` ([sent, recv] bytes/s), `dio` ([read, write] bytes/s).
  - Per-minute peaks: `cpum`, `bm`.
  - Also: `la`, `t` (temperatures), `cpub` (CPU breakdown).
  - A new `1m` record is written per host on each update.
- **Unreachable hosts:** Beszel zero-fills `info` for systems it cannot reach (`t: 0`, `dt: 0`, …). The bridge treats a thread count of 0 as unknown and temperatures ≤ 0 as missing.
- **`rt_metrics` realtime topic:** Beszel's web UI subscribes with `pb.realtime.subscribe("rt_metrics", callback, { query: { system: id } })` (`internal/site/src/components/routes/system/use-system-data.ts`). While subscribed, the hub fetches from that agent every second and pushes `{ stats, info, container }`, with `stats` including `cpus` (per-core usage) and `ni` (per-interface traffic).

### Adapters

- **`systems` (M3, default):**
  - Load all `systems` records, then subscribe to `systems` (status, host list) and to `system_stats` record creations, keeping only `type = "1m"` (metrics).
  - On startup, read the last 24 h of `1m` records per host to seed baselines.
- **`realtime` (M6):** subscribe to `rt_metrics` per host, but only while at least one viewer is connected, so agents are not polled every second around the clock.

Knowledge of Beszel field names stays in `bridge/src/beszel/` plus the two places that convert records: `pipeline/features.ts` (stats and info → samples) and `pipeline/hosts.ts` (status, thread count). Beszel's docs warn the data structure can change in minor releases, and fields are already being renamed (`b` → `bb`, `m`/`mu` → `mem`).

## Bridge

### Bridge configuration

Environment variables (template: `bridge/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `BESZEL_URL` | `http://127.0.0.1:8090` | Hub address as reached from the bridge. |
| `BESZEL_EMAIL` | (required) | Bridge user's email. |
| `BESZEL_PASSWORD` | (required) | Bridge user's password. |
| `SOURCE` | `systems` | Adapter: `systems` or `realtime`. |
| `BIND_HOST` | `127.0.0.1` | Listen address. |
| `BIND_PORT` | `8787` | Listen port. |
| `STREAM_SALT` | (required) | Secret for stream IDs and band order, at least 16 characters. |
| `MIX_FILE` | `mix.json` | Mixing weights, relative to the bridge's working directory. |

Mixing weights are read from `bridge/mix.json`; when it is missing the bridge logs a warning and uses `bridge/mix.example.json`. `mix.json` is git-ignored, so the recipe stays secret even if the repository becomes public. Format: each channel is `clamp01(bias + Σ weight × (feature − center))`, smoothed with time constant `tau` seconds; features are `cpu`, `mem`, `net`, `netChange`, `disk`, `diskChange`, `load`, `burst`, `txShare`, `temp`.

### Pipeline

1. **Ingest:** the adapter turns Beszel records into one sample per host: CPU %, memory %, net tx/rx, disk read/write, load per thread, peaks, temperature, status.
2. **Normalize** each feature to 0..1:
   - CPU and memory: percentages divided by 100.
   - Byte rates: `log1p(100 × rate / p95) / log1p(100)`, where p95 is the host's rolling 95th percentile over 24 h (floored at 64 KiB/s for network, 256 KiB/s for disk). That gives 1 at p95, 0.52 at a tenth of it, 0.15 at a hundredth.
   - Load: `la[0] / threads`, clamped.
   - Burstiness: the larger of (CPU peak − average) / 50 points and the network peak's excess over the average, both from the per-minute peaks.
   - Direction: tx share of traffic, 0.5 below 1 KiB/s. Temperature: (max sensor − 30 °C) / 60.
3. **Mix** features into channels.
   - Each channel is a weighted blend of at least two features, smoothed with different exponential time constants.
   - Some inputs are changes since the previous sample rather than levels.
   - Weights come from `mix.json`.
4. **Anonymize:**
   - Stream ID = first 8 hex characters of HMAC-SHA256(`STREAM_SALT`, system ID).
   - Band order = shuffle seeded by `STREAM_SALT` + the current UTC date, so it changes daily.
5. **Broadcast** the full state of all streams to every connected viewer, 250 ms after the first change in a batch (Beszel updates all hosts within a second or two). `pulse` jumps on each sample and decays with time constant `pulseDecay` (8 s); a 2 s tick broadcasts the decay. Channels are rounded to three decimals.

Initial mapping, tuned in M4:

| Channel | Mixed from | Visual |
|---|---|---|
| `flow` | CPU (fast) + load | Upward speed, tail length |
| `density` | Memory (slow) | Spawn rate |
| `turbulence` | Change in network + disk IO | Sideways wiggle |
| `pulse` | Network and CPU peaks above baseline | Spawn waves, brightness flashes |
| `heat` | tx/rx ratio + temperature | Hue drift direction and speed |
| `alive` | `status` | Current flows or dries up |

### HTTP API

- **`GET /stream`** (`text/event-stream`):
  - On connect: `retry: 5000` and a `snapshot` event.
  - Then an `update` event after each upstream change, and a `: ping` comment every 15 s so proxies keep the connection open.
  - Sends `X-Accel-Buffering: no`, so nginx streams it even without `proxy_buffering off`.
  - At most 500 concurrent streams; beyond that, 503 with `Retry-After: 30`.
- **`GET /healthz`:** 200 while the upstream subscription is live, 503 otherwise. Not exposed through nginx.

## Message format

Draft v1, implemented in M1. Each SSE event's `data` is one JSON object holding the full state, about 150 bytes per stream. Sending full state avoids diff and resync logic.

`Frame`:

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Format version. |
| `t` | number | Server time, Unix ms. |
| `streams` | `Stream[]` | All streams, already in band order (left to right). |

`Stream`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Opaque 8-hex-character ID, stable per host. |
| `alive` | boolean | Host is reporting. |
| `width` | number 0..1 | Relative band width, quantized. |
| `flow` | number 0..1 | Upward speed. |
| `density` | number 0..1 | Spawn rate. |
| `turbulence` | number 0..1 | Sideways noise strength. |
| `pulse` | number 0..1 | Burst strength. |
| `heat` | number 0..1 | Hue drift; 0.5 is neutral. |
| `filaments` | number[] (optional, length 6) | Per-core activity resampled to 6 values, `realtime` source only. Hides the core count. |

## Frontend

- **Sources:** `StreamSource` (`EventSource` on `/stream`) and `DemoSource` (generated channels) share one interface. `?demo` in the URL forces the demo source; in dev it is also the fallback when the bridge is not running.
- **Smoothing:** each channel eases exponentially toward its latest value (time constant 1–5 s), so 60 s and 1 s updates both look continuous.
- **Simulation:**
  - The particle pool is fixed-size, held in `Float32Array`s and updated on the CPU.
  - Budget: 20 000 particles on desktop, 8 000 when `(pointer: coarse)` matches.
  - Move the simulation to the GPU (WebGL2 transform feedback) only if that budget turns out too small.
- **Motion:**
  - Particles spawn along the bottom edge inside their stream's band.
  - Vertical speed = base × lerp(0.6, 2.5, `flow`).
  - Sideways velocity = curl noise × `turbulence`.
  - Heading is clamped to ±18° from vertical, so the data changes speed and wiggle, not direction.
- **Trails:**
  - Two framebuffers alternate: each frame draws the previous one dimmed (decay 0.93–0.97), then the new particles on top.
  - Particles are drawn as streaks from their previous position, so faster particles get longer tails.
- **Colour:**
  - OKLCH, so all hues look equally bright; converted to linear sRGB in the particle vertex shader.
  - Hue = slow global rotation + vertical gradient + per-stream offset + `heat` drift.
  - Additive blending makes overlapping streams glow.
- **Streams:**
  - Bands overlap with soft edges and braid over time.
  - A new stream eases in; a stream with `alive = false` thins out and desaturates; a removed stream drains out.
- **Performance and accessibility:**
  - devicePixelRatio is capped at 1.5.
  - The `EventSource` closes while the tab is hidden.
  - `prefers-reduced-motion` gets fewer, slower particles.
- **Naming:** the public page (title, visible text) never mentions Beszel or hostnames.

## Deployment (M5)

- **Bridge:**
  - Multi-stage Docker image on `node:24-alpine`.
  - Compose service on the Beszel hub's Docker network, so `BESZEL_URL` is `http://<hub-service>:8090`.
  - Port published as `127.0.0.1:8787:8787`; environment loaded from `bridge/.env`.
  - If the hub does not run in Docker, use a systemd service running `node bridge/dist/main.js` instead.
- **Frontend:** `npm run build -w @beszel-river/frontend`, then copy `frontend/dist/` to the nginx web root.
- **nginx:**
  - Static root, plus `location /stream` proxied to `127.0.0.1:8787` with:
    - `proxy_buffering off`: send events immediately.
    - `proxy_http_version 1.1` and `proxy_set_header Connection ""`: keep the upstream connection open.
    - `proxy_read_timeout 1h`: do not cut quiet streams.
  - `limit_conn` caps concurrent streams per IP.

## Milestones

- [x] **M0 – Project setup.** Workspaces, TypeScript config, Vite, CI, this plan.
- [x] **M1 – Message format.** `Frame` and `Stream` types in `shared/src/index.ts`.
  - Done when: bridge and frontend both type-check against them. The frontend uses them; the bridge starts using them in M3.
- [ ] **M2 – Renderer + demo source.** Particles, trails, colour, multi-stream layout, all driven by `DemoSource`.
  - Done when: `npm run dev:frontend` shows the river at 60 fps on a desktop browser, and changing demo channels visibly changes it.
  - Status: implemented. Channel changes, a host going down and stream removal are checked in headless Chromium. The 60 fps check needs a real browser with a GPU.
- [x] **M3 – Bridge with `systems` adapter.** Config, Beszel client, baselines, normalize, mix, anonymize, SSE server, vitest unit tests.
  - Done when: `curl -N http://127.0.0.1:8787/stream` (`-N` disables curl's output buffering, so events print as they arrive) shows a frame per minute for every host, and `npm test` passes.
  - Verified against a local Beszel v0.21.0 hub and agent: one frame per hub update, paused system hidden, unreachable system not alive, in the first update after a CPU stress run started, `flow` 0.03 → 0.14 and a `pulse` of 0.30; after a full minute of load, `flow` 0.52.
- [ ] **M4 – Integration and tuning.** The frontend uses `StreamSource`; tune the mapping against real data.
  - Done when: the river visibly reacts to load on a host (e.g. a CPU stress run) within one update.
- [ ] **M5 – Deployment.** Dockerfile, compose file, nginx config, deploy notes in README.
  - Done when: the public URL serves the river from live data.
- [ ] **M6 – Realtime adapter.** `rt_metrics` at 1 s, `filaments`, subscription only while viewers are connected.
- [ ] **M7 – Polish.** Reduced motion, mobile budget, offline-host visuals, reconnect behaviour.

## Risks

| Risk | Mitigation |
|---|---|
| Beszel changes field names in a minor release. | Field mapping isolated in `bridge/src/beszel/`; note the tested hub version in README; check after hub upgrades. |
| `rt_metrics` is internal and undocumented. | Optional (M6); `systems` remains the default. |
| 1 s polling load on agents. | Subscribe only while viewers are connected. |
| Public `/stream` abuse. | `limit_conn` per IP; payload is tiny; one upstream subscription regardless of viewers. |
| Recipe leaks via frontend code. | Mixing happens in the bridge; the frontend only knows channel → visual. |

## Needed before M5

- Domain or subdomain for the site.
- Whether the Beszel hub runs in Docker, and if so its compose service and network names.
- Beszel hub version.
- Whether the site gets a new nginx server block or a path in an existing one, and how TLS is handled.
