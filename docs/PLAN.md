# beszel-river plan

## Goal

A public web page showing a continuous river of rainbow-coloured particles with trails, flowing from the bottom edge upwards. Live metrics from the servers tracked by the Beszel hub steer the river's speed, density, turbulence, bursts and colour drift. The motion itself is procedural; the data modulates it. A viewer should not be able to tell which host or metric drives which effect, but every change in the river comes from real data.

## Decisions

| Area | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere | Bridge and frontend share the message types. |
| Runtime | Node.js 24.22.1 LTS in production (`.nvmrc`), ≥ 24.22.1 supported | Production already ran 24, so 22 was tested only in CI. 24.22.1 was the current security release when 22 was dropped; `vite` 8 and `eventsource` 5 alone need 22.12.0. |
| Repository | npm workspaces: `shared`, `bridge`, `frontend` | One lockfile, no extra tooling. `.npmrc` sets `save-exact=true` and `min-release-age=7` (npm ≥ 11.10), delaying resolution of newly published versions for seven days. |
| Compiler | `typescript` 7.0.2 | Type-checking everywhere; emits the bridge build. |
| Bridge dev runner | `tsx` 4.23.15 | Watch mode without a build step. |
| Bridge HTTP | `node:http`, no framework | Only two endpoints. |
| Beszel client | `pocketbase` 0.28.1 + `eventsource` 5.1.3 | The SDK handles login refresh and realtime reconnects; Node needs an `EventSource` polyfill for it. |
| Browser transport | Server-Sent Events | One-way, browser `EventSource` reconnects by itself, simple through nginx. |
| Frontend build | `vite` 8.3.4 | Dev server with proxy, static production build. |
| Rendering | Raw WebGL2, no library | Small needs: a few shaders and two framebuffers. |
| Tests | `vitest` 5.0.5 + `@vitest/coverage-v8` 5.0.5 (bridge and frontend, same versions) | Normalization and mixing are pure functions; coverage thresholds gate every module but the entry points and the debug panel, with fakes for PocketBase, WebGL2 and `EventSource`. How the river looks and performs is checked in a browser. 4.1.12 hit an npm 10 peer-resolution bug in this workspace. |
| CI | GitHub Actions: `npm ci --ignore-scripts` (also in the bridge Dockerfile, so dependencies run no install scripts), `typecheck`, `coverage`, `build` on Node 24.22.1, 24 and 26; a `deploy` job builds the bridge image, smoke-tests it, and runs `docker compose config` and `nginx -t`. The Node 24 job also scans with SonarQube Cloud (`sonar-project.properties`, coverage from the lcov reporter) on pushes and same-repository pull requests that are not Dependabot's. An OSV-Scanner workflow scans dependencies for known vulnerabilities on pushes, pull requests, and weekly. Actions are pinned to commit SHAs; Dependabot proposes updates monthly after a 7-day cooldown | `.github/workflows/ci.yml`, `.github/workflows/osv-scanner.yml`, `.github/dependabot.yml`; tests both ends of the supported range, keeps deployment files valid, and scans for dependency vulnerabilities. A tag can be moved to other code, a SHA cannot. |
| Deployment | Bridge in Docker (`node:24.22.1-alpine`) next to the hub, or systemd; host nginx serves the static build and proxies `/stream` | See "Deployment". |

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

```
.github/workflows/ci.yml         CI
.github/workflows/osv-scanner.yml OSV-Scanner dependency vulnerability scanning
.github/dependabot.yml           monthly updates for the pinned actions
sonar-project.properties      SonarQube Cloud project settings
.dockerignore                 keeps secrets and build output out of the image build context
AGENTS.md                     instructions for coding agents
CLAUDE.md                     imports AGENTS.md
docs/PLAN.md                  this plan
GLOSSARY.md                   domain terms for host activity, streams and the visible river
docs/images/                  README screenshots
shared/src/index.ts           message types
bridge/
  .env.example                configuration template
  mix.example.json            mixing weights template; real bridge/mix.json is git-ignored
  tsconfig.json               type-checks src and test
  tsconfig.build.json         emits src to dist
  vitest.config.ts            coverage reporters and thresholds
  src/
    main.ts                   entry: config, wiring, reconnects, broadcast debounce, 2 s ticks
    config.ts                 env parsing and validation
    log.ts                    timestamped log lines with error cause chains
    beszel/types.ts           the Beszel record fields the bridge reads
    beszel/client.ts          login, token refresh, EventSource polyfill
    beszel/systems-source.ts  60 s adapter
    beszel/realtime-source.ts 1 s layer: rt_metrics per host while viewers are connected
    pipeline/features.ts      samples, 24 h baselines, 0..1 features
    pipeline/mix.ts           features → channels, mix.json parsing
    pipeline/anonymize.ts     stream IDs, band order, band widths
    pipeline/hosts.ts         per-host state → frames
    server.ts                 GET /stream, GET /healthz
    upstream.ts               hub connection loss, after a 30 s grace period
  test/                       vitest unit tests
frontend/
  index.html
  tsconfig.json               adds the DOM libs; type-checks src and test
  vite.config.ts              relative base, dev proxy /stream → bridge
  vitest.config.ts            coverage reporters and thresholds
  src/
    main.ts                   entry: wiring and frame loop
    config.ts                 look tunables (LOOK) and URL parameters
    source/source.ts          FrameSource interface
    source/stream.ts          EventSource client, frame validation
    source/demo.ts            generated channels for development
    sim/streams.ts            per-stream eased state, band layout, lifecycle
    sim/particles.ts          particle pool and motion
    sim/budget.ts             adaptive particle limit for slow devices
    sim/noise.ts              simplex noise, curl flow field
    render/renderer.ts        trail buffers, particle pass, tone mapping
    render/gl.ts              WebGL2 program and render-target helpers
    render/shaders/           GLSL, including OKLCH → sRGB
    debug/panel.ts            ?debug panel: channel sliders, stats
    util/math.ts              PRNG, easing, small helpers
  test/                       vitest unit tests; fake-gl.ts is a recording WebGL2 stand-in
deploy/
  bridge.Dockerfile           bridge image, built from the repository root
  compose.yml                 bridge service on the hub's Docker network
  compose.host-network.yml    override for a hub with network_mode: host
  beszel-river-bridge.service systemd unit, when the hub does not run in Docker
  nginx/river.conf            own server block: TLS, static root, /stream proxy
  nginx/river-path.conf       alternative: locations for /river/ in an existing server block
```

## Data source: Beszel hub

From the Beszel source on `main` (latest release v0.21.1, 22 Oct 2026):

- **API:** PocketBase REST and realtime at `BESZEL_URL`.
- **Login:** `POST /api/collections/users/auth-with-password`; renew with `POST /api/collections/users/auth-refresh`.
  - A hub with password auth disabled (`DISABLE_PASSWORD_AUTH=true`, OIDC only) answers that login with 403. A superuser can instead mint an impersonation token for the bridge user (`POST /api/collections/users/impersonate/{id}` with a `duration`, or **Impersonate** in the PocketBase dashboard). Such tokens have `refreshable: false`: `auth-refresh` accepts them but returns the same token, so they end at their `exp`. Setting the user's password or **Reset issued tokens** revokes them. Checked against v0.21.0.
- **Access:** Beszel sets the API rules in `internal/hub/collections.go`. A user can list `systems` and `system_stats` when they are in the system's `users` list, or for every system when the hub runs with `SHARE_ALL_SYSTEMS=true`. Give the bridge user the `readonly` role: it can read but not change systems.
- **`systems` collection:** one record per host with `id`, `name`, `status` and `info`. The bridge requests all but `name`: it has no use for hostnames. Relevant `info` keys: `cpu`, `mp` (memory %), `dp` (disk %), `bb` (bandwidth bytes/s), `la` (load averages), `t` (threads), `dt` (dashboard temperature). The hub refreshes these every 60 s (`interval int = 60_000` in `internal/hub/systems/system_manager.go`).
- **`system_stats` collection:** history records with a `type` tier (`1m`, `10m`, `20m`, `120m`, `480m`) and a `stats` object.
  - Rates: `cpu`, `mp`, `b` ([sent, recv] bytes/s), `dio` ([read, write] bytes/s).
  - Peaks: `cpum`, `bm`. Only the aggregated tiers (`10m` and up) have them: the hub computes them when averaging (`internal/records/records.go`), and the agent does not send them, so `1m` records leave them out.
  - Also: `la`, `t` (temperatures), `cpub` (CPU breakdown).
  - Memory: the bridge reads only `mp` (percent). v0.21.1 deprecates the GB fields (`m`, `mu`, `mb`, `mz`, `s`, `su`) in favour of byte arrays under the JSON keys `mem` and `swap`; `mp` is not deprecated. Changelog and diff of v0.21.0 → v0.21.1 checked: no other field the bridge reads changed.
  - A new `1m` record is written per host on each update.
- **Unreachable hosts:** Beszel zero-fills `info` for systems it cannot reach (`t: 0`, `dt: 0`, …). The bridge treats a thread count of 0 as unknown and temperatures ≤ 0 as missing.
- **`rt_metrics` realtime topic** (`internal/hub/systems/system_realtime.go`, unchanged between v0.21.0 and v0.21.1):
  - Beszel's web UI subscribes with `pb.realtime.subscribe("rt_metrics", callback, { query: { system: id } })` (`internal/site/src/components/routes/system/use-system-data.ts`). The SDK keys each subscription by topic plus options, so one connection can hold one per system.
  - The hub accepts a subscription only for a system it manages and the user may see (`HasUser`, or `SHARE_ALL_SYSTEMS=true`); otherwise the whole subscription request fails with 404.
  - While any `rt_metrics` subscription exists, a hub worker fetches every subscribed system's agent once a second (`CacheTimeMs: 1000`) and pushes `{ stats, info, container, Details, Monitors }`. It stops when the last subscription is removed or its client disconnects. Fetch errors (an agent that is down) send nothing.
  - `stats` has the `system_stats.stats` fields without the hub's peaks: `cpu`, `mp`, `b`, `dio`, `la`, `t`, plus `cpus` (busy % per core) and `ni` (per-interface traffic). Zero values are left out (`b`, `dio` when idle). The `1m` records carry `cpus` too.
  - The SDK sends every topic of a connection with each subscription change and keeps a topic the hub refused, so one refused target makes every later change on that connection fail. Checked against v0.21.0.

### Adapters

- **`systems` (M3, default):**
  - Load all `systems` records, then subscribe to `systems` (status, host list) and to `system_stats` record creations, keeping only `type = "1m"` (metrics).
  - On startup, read the last 24 h of `1m` records per host to seed baselines and channels. They apply at once and without pulses: replayed, a pulse would be old news, and every host's would flash together at startup.
- **`realtime` (M6):** everything `systems` does, plus `rt_metrics` per host, but only while someone watches, so agents are not polled every second around the clock.
  - Subscribed: hosts with status `up`, while at least one `/stream` client is connected and for 30 s after the last one leaves (a reload does not restart the subscriptions). Status changes and host removal update the set.
  - The subscriptions use a second SDK client with the same login and its own realtime connection, so a refused one cannot break the `systems` subscriptions. Changes run one at a time, so a refusal names its system; that system's topic is dropped and retried after 60 s.
  - While a host's realtime samples arrive, its `1m` records only feed the baseline. 10 s after the last realtime sample the host is back on its `1m` records.

Knowledge of Beszel field names stays in `bridge/src/beszel/` plus the two places that convert records: `pipeline/features.ts` (stats and info → samples) and `pipeline/hosts.ts` (status, thread count). Beszel's docs warn the data structure can change in minor releases, and fields are already being renamed (`b` → `bb`, `m`/`mu` → `mem`).

## Bridge

### Bridge configuration

Environment variables (template: `bridge/.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `BESZEL_URL` | `http://127.0.0.1:8090` | Hub address as reached from the bridge; only HTTP(S), without embedded credentials. |
| `BESZEL_EMAIL` | (required without `BESZEL_TOKEN`) | Bridge user's email. |
| `BESZEL_PASSWORD` | (required without `BESZEL_TOKEN`) | Bridge user's password. |
| `BESZEL_TOKEN` | (none) | Impersonation token for the bridge user, instead of email and password, for hubs without password auth. Rejected together with them, when it is not a JWT with `exp`, or when expired. The bridge checks it with `auth-refresh` at startup and every 6 h, and warns from 14 days before `exp`. |
| `SOURCE` | `systems` | Adapter: `systems` (60 s updates) or `realtime` (1 s updates while viewers are connected, see "Adapters"). |
| `BIND_HOST` | `127.0.0.1` | Listen address. |
| `BIND_PORT` | `8787` | Listen port. |
| `STREAM_SALT` | (required) | Secret for stream IDs, band order and band widths, at least 16 characters. |
| `MIX_FILE` | `mix.json` | Required mixing weights, relative to the bridge's working directory. |

Mixing weights are read from the configured `MIX_FILE` (`bridge/mix.json` by default). A missing, unreadable or invalid file stops startup before the bridge listens or authenticates to the hub, in every environment and deployment. Startup never substitutes the public example: losing a private recipe must not enable its known filament mapping. For local development or isolated CI smoke tests only, an operator may explicitly select `MIX_FILE=mix.example.json`. `mix.json` is git-ignored, so the recipe stays secret even if the repository becomes public. Format: each channel is `clamp01(bias + Σ weight × (feature − center))`, smoothed with time constant `tau` seconds; features are `cpu`, `mem`, `net`, `netChange`, `disk`, `diskChange`, `load`, `burst`, `txShare`, `temp`.

The optional `filaments` entry maps each value of the per-core profile the same way. Omitted or `null` disables filaments; enabling them requires explicit finite `bias`, `center`, `weight` and `tau` values, with `tau >= 0`. Incomplete sections fail startup. There is no implicit recipe: the old defaults (0, 0, 1, 3 s) preserved normalized CPU percentages, and sorting public filament arrays recovered profile extrema despite daily shuffling. Smoothing and rounding reduce precision but do not hide sustained CPU levels. An explicit recipe is an operator choice to publish a transformed CPU profile, not a confidentiality guarantee; leave it disabled if those levels must remain private. Existing partial recipes must be completed deliberately or removed; copies of the earlier example need `"center": 0` added. The example includes every field and its public weights must still be changed before production use.

The optional `pulseScatter` entry (`jitter`, `rate`, `max`, `window`; defaults 5 s, 2, 2, 50 s) spreads the pulse of each minute record out, and the optional `glide` (default 60 s) its other channels, see "Minute records"; each missing field takes its default. `window` must leave room for the later pulses, at least `max` × (`pulseDecay` + 2 s), and `jitter` + `window` must be at most 55 s, so every pulse fires before the next record. `"jitter": 0`, `"max": 0` and `"glide": 0` together apply each minute record at once, with one pulse, as before the scattering.

### Pipeline

1. **Ingest:** the adapter turns Beszel records into one sample per host: CPU %, memory %, net tx/rx, disk read/write, load per thread, peaks, temperature, per-core usage, status.
   - Realtime samples are mixed with the time since the previous realtime sample as `dt`. Changes are only taken between two realtime samples or between two `1m` records, never across: a step from a minute's average to a 1 s value is not a change.
   - Only `1m` records go into the 24 h baseline: one realtime sample per second would push the day of minute averages out in 24 minutes.
2. **Normalize** each feature to 0..1:
   - CPU and memory: percentages divided by 100.
   - Byte rates: `log1p(100 × rate / p95) / log1p(100)`, where p95 is the host's rolling 95th percentile over 24 h (floored at 64 KiB/s for network, 256 KiB/s for disk). That gives 1 at p95, 0.52 at a tenth of it, 0.15 at a hundredth.
   - Load: `la[0] / threads`, clamped.
   - Changes (`netChange`, `diskChange`): the absolute change in the byte rate since the previous sample, divided by the same p95 reference. Linear rather than a difference on the log scale, which magnifies the low end: on the log scale an idle host's trickle going from 1 to 4 KiB/s read as a quarter of full scale.
   - Burstiness: the larger of the CPU burst (the rise since the previous sample, or the peak's excess over the average where peaks exist, per 50 points) and the network burst (the rise since the previous sample divided by p95, or the peak's excess on the log scale). `1m` records have no peaks, so the rises carry it.
   - Direction: tx share of traffic, 0.5 below 1 KiB/s. Temperature: (max sensor − 30 °C) / 60.
   - Per-core profile: the cores' busy % sorted and resampled to 6 values by linear interpolation, from the idlest to the busiest, divided by 100. Every core count gives 6 values; only a single core gives 6 equal ones.
3. **Mix** features into channels.
   - The template blends at least two features into each activity-driven channel. `flow`, `density`, `turbulence` and `heat` use different exponential smoothing time constants; `pulse` rises and decays as described below. `width` is assigned in the anonymization step.
   - Some inputs are changes since the previous sample rather than levels.
   - Weights come from `mix.json`.
   - `filaments`: only with an explicit complete recipe, each profile value through that recipe with ±0.025 uniform jitter (`FILAMENT_JITTER`, so hosts with fewer than 6 cores do not leave exact linear interpolation spacings in the public array), smoothed with its `tau`. Disabled recipes and hosts without per-core usage emit none.
4. **Anonymize:**
   - Stream ID = first 8 hex characters of HMAC-SHA256(`STREAM_SALT`, `${UTC date}:${system ID}:stream`). IDs rotate at UTC midnight, including when channels are idle; the 2 s tick triggers a broadcast. This removes the permanent cross-day identifier, but continuous channel observations (or distinct steady-state memory and temperature levels, which are normalized against fixed bounds rather than per-host baselines, or mixed fleets where only some agents report per-core usage) can still correlate hosts. New bands fade in while the old IDs drain; if all 32 frontend slots are occupied, the latest frame waits for draining slots and is retried without needing another SSE event.
   - Band order = shuffle seeded by `STREAM_SALT` + the current UTC date, so it changes daily.
   - Band width = one of 0, 0.25, 0.5, 0.75, 1, seeded by `STREAM_SALT`, the system ID and the UTC date (not from thread counts, which leaked core-count ratios and stayed fixed across days).
   - Band count: one stream per host that is not paused. The river is drawn from per-host bands, so their number shows on the page whatever the frame holds, and that is accepted. Paused hosts are left out, and IDs, widths and order do not say which host is which.
   - Filament order = shuffle of the profile seeded by `STREAM_SALT`, the system ID and the UTC date, so the busiest core is not always in the same place and hosts differ.
   - The daily stream IDs, widths, band order and filament orders are cached for the current UTC day and non-paused host set so snapshots and broadcasts do not recompute HMACs per request or tick.
5. **Broadcast** the full state of all streams to every connected viewer, 250 ms after the first change in a batch (Beszel updates all hosts within a second or two). `pulse` rises on each sample (realtime samples at once, live minute records scattered, see below) and decays with time constant `pulseDecay` (8 s). A 2 s tick lets pulses decay, fires scattered pulses that are due and moves gliding channels on, and broadcasts when that changed anything visibly (a pulse by 0.005, a gliding value by 0.0005). Channels are rounded to three decimals.

Visual controls and reporting state, with activity mappings from the template `bridge/mix.example.json`:

| Field | Derived from | Visual |
|---|---|---|
| `width` | Daily seeded choice, independent of host activity | Relative band width |
| `flow` | CPU (fast) + load | Upward speed, tail length |
| `density` | Memory (slow) + disk activity | Spawn rate |
| `turbulence` | Change in network + disk IO | Sideways wiggle |
| `pulse` | CPU and network rises (and peaks where present) | Spawn waves, brightness flashes |
| `heat` | tx/rx ratio + temperature | Hue drift direction and speed |
| `alive` (reporting state) | `status`, and the hub connection | Current flows or dries up |
| `filaments` (optional profile) | Per-core profile through an explicit recipe | Finer strands |

#### Minute records

Minute records arrive for every host within a second or two. Applied as they came, every band changed and flashed at the same moment once a minute and held still for the rest of it, which also gave away the poll cadence. Live minute records are therefore spread over the following minute. Records replayed at startup apply at once and without pulses (see "Adapters"); realtime samples are real 1 s data and also apply at once.

- **Glide:** the record's other channels and filaments move in a straight line from where they are to the record's values over `glide` seconds (60 s, the time to the next record), so each band changes a little on every tick instead of all of them stepping together. The next sample continues from wherever the glide has got to. The river reaches a record's values up to `glide` later than before; the first pulse still shows a load change within seconds.
- **First pulse:** the record's own pulse, at its full mixed strength p, is due at a random time within `jitter` seconds (5 s). The 2 s tick fires it up to 2 s later, so it shows within about 7 s of the record, and the hosts' first pulses spread over several ticks instead of one.
- **Later pulses:** n more, n Poisson-distributed with mean `rate` × p and capped at `max`. Each is a random 0.4–0.8 × p, due at a random time within `window` seconds of the first pulse and at least `pulseDecay` + 2 s after the pulse before it. Measured in ticks, that is more than `pulseDecay`, so the earlier pulse has faded below 1/e ≈ 0.37 of its strength, below the weakest later pulse, and each later pulse shows as a rise of its own. They are scheduled only when even the weakest would be visible (0.4 × p ≥ 0.005). A busy host pulses more often and harder; an idle one (p near 0) once or not at all.
- **Next sample:** it drops the later pulses still pending; the record's own pulse, if it has not fired yet, fires at once instead of being lost. A host whose status changes from `up` drops every pending pulse, so a stream that is drying up does not flash.
- p and the channel values come from the record; the number, strengths and times of the later pulses are random, steered by p. The record times can still be estimated from when glides change direction and first pulses cluster, but no longer from one frame in which every stream changes. The frame format is unchanged and the frontend knows nothing about it.

### HTTP API

- **`GET /stream`** (`text/event-stream`):
  - On connect: `retry: 5000` and a `snapshot` event.
  - Then an `update` event after each upstream change, and a `: ping` comment every 15 s so proxies keep the connection open.
  - Sends `X-Accel-Buffering: no`, so nginx streams it even without `proxy_buffering off`, and `X-Content-Type-Options: nosniff` (hidden by nginx where the server block already sets it).
  - At most 500 concurrent streams; beyond that, 503 with `Retry-After: 30`.
  - All snapshot, update and heartbeat writes share a 256 KiB per-response queued-byte budget (UTF-8 bytes, including already queued response output). An event that would exceed it closes the response before writing. If `write()` signals backpressure, no further chunks are enqueued for that client until `drain`; heartbeats are skipped and only whether an update was missed is retained. The latest broadcast is shared across clients and sent after drain when needed. A response blocked for 10 s is destroyed and removed from the viewer count exactly once, allowing normal realtime linger cleanup; shutdown also destroys queued responses instead of waiting for a flush. Healthy clients keep receiving updates. Limits are internal `StreamServerOptions` (`maxBufferedBytes`, `drainTimeoutMs`), not environment variables.
- **`GET /healthz`:** 200 while the upstream subscription is live, 503 otherwise (with `X-Content-Type-Options: nosniff`). Not exposed through nginx.
- **Lost hub connection:** the SDK reconnects by itself, but until it does, or for good once a token has expired or been rejected on refresh (which clears the SDK's auth store and retries login with bounded backoff), host statuses are stale and the river would keep flowing on its last values. When the login is invalid or the realtime connection is down for 30 s (`UPSTREAM_GRACE_MS`, longer than the 12 s hub restart in M6), every stream is sent with `alive: false` and its pending pulses are dropped, so the river dries up, and the bridge logs a warning. `/healthz` turns 503 at once. Whenever the connection returns after a drop (including one shorter than 30 s), the bridge re-reads the `systems` list (retrying on failure) to reconcile hosts paused or deleted during the outage, and streams take their current statuses again.
- Routing compares the request-target's path (before `?`) exactly, without a URL parser: a parser throws on some targets (`//`) and resolves `..`, `\` and `//host` in its own way (`//x/stream` becomes `/stream`), which need not match how a proxy routed the request. Other methods get 405; any other target, including `//`, `/x/../stream` and absolute-form ones, gets 404.

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
| `id` | string | Opaque 8-hex-character ID, stable per host within one UTC day. |
| `alive` | boolean | Host is reporting, and the bridge is connected to the hub. |
| `width` | number 0..1 | Relative band width, quantized. |
| `flow` | number 0..1 | Upward speed. |
| `density` | number 0..1 | Spawn rate. |
| `turbulence` | number 0..1 | Sideways noise strength. |
| `pulse` | number 0..1 | Burst strength. |
| `heat` | number 0..1 | Hue drift; 0.5 is neutral. |
| `filaments` | number[] (optional, length 6) | Per-core activity: the profile resampled to 6 values, mixed and shuffled for the day. Present only with an explicit complete recipe and agent per-core usage; every second with the `realtime` source. The array length does not reveal the core count. |

## Frontend

- **Sources:** `StreamSource` (`EventSource` on `/stream`) and `DemoSource` (generated channels) share one interface. `?demo` in the URL forces the demo source; in dev it is also the fallback when the bridge is not running.
  - `StreamSource` accepts only `v: 1` frames and clamps every channel to 0..1; `filaments` is kept only with exactly 6 numbers.
  - `DemoSource` sends filaments too (wandering around `flow`, with an occasional busy lane); the `?debug` panel toggles them per stream.
  - The browser reconnects by itself after a dropped connection. An HTTP error (nginx's 502 while the bridge restarts) closes an `EventSource` for good, so `StreamSource` then reopens it after 5 s, doubling up to 60 s. The browser's `online` event skips the rest of the wait.
  - After 20 s without a connection, every stream thins out and greys as if its host were down, so a stale river does not pass for live data; the snapshot after reconnecting restores it. A bridge restart or a short network drop stays within the 20 s.
  - In dev, when the bridge is not running, the page hands over to `DemoSource` for good (it stops listening, so showing the tab again does not reconnect alongside the demo).
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
  - Filaments: a band with `filaments` has 6 lanes across ±0.75 of its half-width.
    - A spawning particle picks a lane by the lane's eased value; an idle lane keeps 0.15 of the weight, and edge lanes get less, so the band keeps its soft profile.
    - It scatters around the lane centre by 0.32 of the half-width in an idle lane down to 0.05 in a busy one, and keeps that place instead of steering to the band's centre. Idle lanes blur into one haze; a busy core draws a tight strand, which is also up to 1.25× faster (0.85× when idle).
    - When filaments appear or stop, spawning blends between lanes and the plain band over about 3 s.
- **Trails:**
  - Two framebuffers alternate: each frame draws the previous one dimmed (decay 0.93–0.97), then the new particles on top.
  - Particles are drawn as streaks from their previous position, so faster particles get longer tails.
- **Colour:**
  - OKLCH, so all hues look equally bright; converted to linear sRGB in the particle vertex shader.
  - Hue = slow global rotation + vertical gradient + per-stream offset + `heat` drift.
  - Additive blending makes overlapping streams glow.
- **Streams:**
  - Bands overlap with soft edges and braid over time.
  - A new stream eases in; a stream with `alive = false` thins out and desaturates; a removed stream drains out. Spawn rates are shared out so the pool turns over at the same pace however many streams there are, but never as if less than one full stream were present, so the river empties when the last stream goes.
- **Performance and accessibility:**
  - devicePixelRatio is capped at 1.5.
  - The `EventSource` closes while the tab is hidden.
  - `prefers-reduced-motion`: half the particles, half the speed and sideways noise, half-speed braiding, and pulse flashes and spawn waves at a quarter of their strength, rising over 0.6 s instead of 0.3 s.
  - Adaptive budget (`sim/budget.ts`): after 2 s of frames slower than 1.5× the display period (and slower than 45 fps), the live particle limit drops by a fifth, down to a quarter of the pool, and particles get brighter (up to 2×) so the river keeps its weight. After 10 s of keeping up it rises by a tenth; each drop doubles that wait, up to 2 min, so it settles. A drop only stops spawning, so slow frames count again only once the particles above the new limit have died: frames slowed by those would otherwise cause a second drop. The display period is the fastest frame interval seen, at most 1/30 s, learned while the pool fills on load, so a 30 Hz display or throttled browser is left alone. `?particles=N` fixes the count.
  - The simulation and renderer allocate nothing per frame: the band layout sorts into a preallocated list, and the noise function uses plain locals (its output is unchanged).
  - Without WebGL2 the page shows one line of grey text saying the animation needs it.
- **Naming:** the public page (title, visible text) never mentions Beszel or hostnames.

The bridge rejects hub URLs with unsupported schemes or embedded credentials without logging the rejected value, rejects malformed JSON recipes without echoing file snippets, and deletes secret variables (`BESZEL_PASSWORD`, `BESZEL_TOKEN`, `STREAM_SALT`) from `process.env` once configuration is loaded. Log records escape CR/LF, HTTP error URLs omit userinfo, and error cause chains stop after five entries (including cycles).

## Deployment

Commands and steps are in README, "Deployment".

- **Bridge in Docker** (`deploy/bridge.Dockerfile`, `deploy/compose.yml`):
  - Multi-stage image on `node:24.22.1-alpine` pinned to one multi-platform SHA256 digest in all stages (monthly Dependabot Docker updates with a seven-day cooldown): build with dev dependencies, then a final stage with only `dist/`, production dependencies and `mix.example.json`, running as the `node` user. A `HEALTHCHECK` polls `/healthz`.
  - `.gitignore` and `.dockerignore` exclude `.env`, `.env.*` and `bridge/mix*.json*` (including environment-specific files and backups), keeping only `.env.example` and `bridge/mix.example.json` as public templates. The Docker context also excludes `node_modules` and build output.
  - The compose service joins the hub's network (`BESZEL_NETWORK`, default `beszel_default`, the network of a compose project in a directory named `beszel`), so `BESZEL_URL` is `http://<hub service>:8090`.
  - Environment from `bridge/.env`; compose overrides `BIND_HOST=0.0.0.0` and `BIND_PORT=8787` inside the container and publishes `127.0.0.1:8787:8787`.
  - A hub with `network_mode: host` is on no Docker network. `deploy/compose.host-network.yml` then puts the bridge on the host network too (`!reset` removes the network and port mapping), with `BIND_HOST=127.0.0.1` and `BESZEL_URL=http://127.0.0.1:8090`.
  - `bridge/mix.json` is bind-mounted read-only and required (`create_host_path: false`): the template's recipe is public, so production must not fall back to it.
  - Read-only root filesystem, PID limit (`pids_limit: 100`), all capabilities dropped, `no-new-privileges`, log rotation (3 × 10 MB).
- **Bridge under systemd** (`deploy/beszel-river-bridge.service`): when the hub does not run in Docker. Runs `node dist/main.js` in `/opt/beszel-river/bridge` as a `beszel-river` user, with the usual systemd sandboxing options plus an empty capability bounding set, `RestrictSUIDSGID`, `RestrictRealtime`, `RestrictNamespaces`, `ProtectClock`, `ProtectHostname`, `ProtectKernelLogs`, `ProtectProc=invisible`, `ProcSubset=pid`, `RemoveIPC`, `SystemCallArchitectures=native` and `UMask=0077`. Executable memory remains available for Node's JIT. `deploy/test/systemd.py` verifies the unit and smoke-tests Node JIT/HTTP, empty capabilities and file permissions in a transient system service; CI runs it with passwordless sudo.
- **Frontend:** `npm run build -w @beszel-river/frontend`, then copy `frontend/dist/` to the web root. The build uses relative asset URLs (`base: "./"`) and connects to the relative `stream`, so the same files work at a site root or under a path.
- **nginx** (`deploy/nginx/river.conf`, own server block):
  - HTTP → HTTPS redirect; HTTP/2, because HTTP/1.1 browsers open at most 6 connections per host and every open tab holds one stream.
  - `location = /stream` proxied to `127.0.0.1:8787` with:
    - `proxy_pass` naming the URI `/stream`: nginx forwards its normalized path, not the client's raw request-target, so the bridge always sees `/stream` from here.
    - `proxy_buffering off`: send events immediately.
    - `proxy_http_version 1.1` and `proxy_set_header Connection ""`: keep the upstream connection open.
    - `proxy_read_timeout 1h`: do not cut quiet streams.
    - `river-limits.conf` defines the shared connection key: the full IPv4 address or the first eight binary IPv6 bytes (`/64`), including NUL/newline bytes. `limit_conn` allows 8 per key (each HTTP/2 request counts), answered with 429. It prevents one IPv6 `/64` from taking the bridge's 500 slots by rotating addresses; many prefixes can still exhaust the global cap. The include belongs once in the http block for either deployment mode. Changing an existing zone key requires an nginx restart.
  - `/healthz` is not proxied.
  - Caching: `index.html` gets `Cache-Control: no-cache`; `assets/` (content-hashed names) a far-future `max-age`.
  - Headers: `Content-Security-Policy` (`default-src 'self'`, inline styles allowed for `index.html` and the debug panel, no framing), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (one year, this host only).
  - `deploy/nginx/river-path.conf` holds the same locations under `/river/` for an existing server block. It sets no headers of its own, so the page gets that block's; its comment lists the ones to add there. `deploy/test/nginx.py` runs nginx in Docker to check actual binary keys and held-request limits for both paths; CI runs it after the syntax checks.

## Milestones

- [x] **M0 – Project setup.** Workspaces, TypeScript config, Vite, CI, this plan.
- [x] **M1 – Message format.** `Frame` and `Stream` types in `shared/src/index.ts`.
  - Done when: bridge and frontend both type-check against them. The frontend uses them; the bridge starts using them in M3.
- [x] **M2 – Renderer + demo source.** Particles, trails, colour, multi-stream layout, all driven by `DemoSource`.
  - Done when: `npm run dev:frontend` shows the river at 60 fps on a desktop browser, and changing demo channels visibly changes it.
  - Channel changes, a host going down and stream removal were checked in headless Chromium.
  - 60 fps: the public page with `?debug` on a ThinkPad X280 (Core i5-8350U, integrated UHD 620 graphics), 4 live streams: 60 fps with 13 679 particles and 3.9 ms of simulation per frame. That was the production build with live data rather than the dev server with demo frames, and a build from before M7 (its panel shows no particle limit). It is a laptop with integrated graphics, which is a harder case than the desktop the condition names.
- [x] **M3 – Bridge with `systems` adapter.** Config, Beszel client, baselines, normalize, mix, anonymize, SSE server, vitest unit tests.
  - Done when: `curl -N http://127.0.0.1:8787/stream` (`-N` disables curl's output buffering, so events print as they arrive) shows a frame per minute for every host, and `npm test` passes.
  - Verified against a local Beszel v0.21.0 hub and agent: one frame per hub update, paused system hidden, unreachable system not alive, in the first update after a CPU stress run started, `flow` 0.03 → 0.14 and a `pulse` of 0.30; after a full minute of load, `flow` 0.52.
- [x] **M4 – Integration and tuning.** The frontend uses `StreamSource`; tune the mapping against real data.
  - Done when: the river visibly reacts to load on a host (e.g. a CPU stress run) within one update.
  - Verified against a local Beszel v0.21.0 hub and agent (4 threads):
    - Idle: `turbulence` had stayed near 1 because changes were measured on the log scale. With linear changes it settles at 0.07 after a few quiet minutes.
    - CPU stress on all cores: the first update after the load started (about 14 s of load in that minute) gave `flow` 0.004 → 0.196 and `pulse` 0.576; the next gave `flow` 0.818 and `pulse` 1. In M3 the same test gave 0.03 → 0.14 and a `pulse` of 0.30. The `flow` smoothing in the template is now `tau` 30 s instead of 90 s.
    - The recorded frames were replayed to the page through `/stream` in headless Chromium. The first stress frame made it visibly brighter and denser; the second gave long, fast streaks. The replay was needed because software WebGL keeps the 4 cores busy, so the agent reads about 94 % CPU while the browser runs.
    - Dev without the bridge falls back to demo frames. In a production build, the stream retries after 502s (5 s, then 10 s, then 20 s) and recovers when the bridge returns. Hiding the tab closes the stream; showing it reopens it.
- [x] **M5 – Deployment.** Dockerfile, compose file, nginx config, deploy notes in README.
  - Done when: the public URL serves the river from live data.
  - Verified at `https://river.example.com` (bridge with `compose.host-network.yml` next to a hub on `network_mode: host`, authenticating with `BESZEL_TOKEN` because that hub runs OIDC only; nginx with its own server block, DNS only):
    - `HTTP/2 200` with HSTS, CSP, `no-cache` on `index.html` and a far-future `max-age` on the hashed asset; `/healthz` is 404.
    - 70 s of `/stream`: 4 alive streams carrying only the channel fields, with values changing after a hub update between the first and last frame.
    - Headless Chromium (in the sandbox, not on the measured hosts) with `?debug`: `/stream` connected, 4 alive streams in the panel, the river rendered.
    - Before that, the same files were checked locally against Beszel v0.21.0: compose on a `beszel_default` network and with the host-network override, nginx with `river.conf` and `river-path.conf` (redirect, unbuffered streaming, 429 on the ninth concurrent stream), and password auth disabled with a token (a set password revoked it). The HTTP → HTTPS redirect on the public host was not checked; the sandbox reaches it only over HTTPS.
- [x] **M6 – Realtime adapter.** `rt_metrics` at 1 s, `filaments`, subscription only while viewers are connected.
  - Done when: with `SOURCE=realtime`, a connected viewer gets an update about every second with `filaments`, one busy core shows in them in the first update after it starts, and the hub stops polling agents 30 s after the last viewer leaves.
  - Verified against a local Beszel v0.21.0 hub and agent (4 threads):
    - 8 s of `/stream`: 13 events; `filaments` on the up host, none on the down one. A `mix.json` without a `filaments` entry used the defaults then; it now disables filaments (see "Bridge configuration").
    - Agent CPU time over 20 s: 0 ticks with no viewer ("Realtime metrics off" logged 30 s after the last one left), 5 ticks with one viewer.
    - A busy loop on one core: the busiest filament went 0.017 → 0.31 in the first update after it started and 0.99 within 15 s, while `flow` (30 s smoothing) went 0.006 → 0.09 over the 20 s.
    - Hub restart: realtime samples paused for the 12 s the hub was down and resumed 4 s after it came back.
    - Agent stopped: the hub marked the host down after 54 s and the bridge dropped its subscription; agent started: marked up 54 s later and subscribed again.
    - A refused subscription (unknown system ID) next to a valid one, in either order: the valid one delivered 5 samples in 5 s and the refused topic was dropped. Before subscriptions ran one at a time, the shared batch failed and the valid host got nothing.
    - The one-core recording replayed in headless Chromium (agent stopped): idle lanes blur into a haze, the busy core's lane is a brighter strand. `?demo` shows filaments in every band.
    - Not checked on the public deployment, which runs `SOURCE=systems`.
- [x] **M7 – Polish.** Reduced motion, mobile budget, offline-host visuals, reconnect behaviour.
  - Done when: reduced motion, a slow device, a phone, a lost connection, a browser coming back online and a browser without WebGL2 each get the behaviour under "Frontend", checked in headless Chromium.
  - Verified in headless Chromium against recorded realtime frames (agent stopped), served by the production build through nginx with `river-path.conf` where the connection mattered:
    - Software WebGL (10–15 fps): the limit fell 20 000 → 5 000 in about 12 s (before slow frames waited for particles above a lowered limit to die; in a simulation that adds a few seconds per step, not re-measured in a browser); with `?particles=20000` it stayed. A simulation of the budget against frame-time models: no change at 60 Hz, 144 Hz at 90 fps, 30 Hz throttling or tab switches; overloaded devices settled near 50 fps without swinging over 15 min.
    - Reduced motion: pool 10 000; phone viewport (390 × 844, touch): pool 8 000. Both then thinned by the budget under software WebGL.
    - Replay server killed: unchanged at 8 s, a grey trickle at 30 s (mean brightness 4.6 → 0.5, colourfulness 4.9 → 0.1); reconnected 3.9 s after the server returned and regained its colour.
    - Server down for 40 s (backoff at 40 s), browser offline, server back, browser online: the stream reopened at once instead of about 33 s later.
    - `--disable-webgl`: the note is shown.
    - Vite's dev proxy keeps `/stream` open when its upstream dies, so the lost-connection behaviour shows only behind nginx (or with no proxy).
    - The noise rewrite returned identical values for 51 100 sample points.
    - Not checked: frame rates on real phones and GPUs (the open M2 check).

## Risks

| Risk | Mitigation |
|---|---|
| Beszel changes field names in a minor release. | Field mapping isolated in `bridge/src/beszel/`; note the tested hub version in README; check after hub upgrades. |
| `rt_metrics` is internal and undocumented. | Optional (M6); `systems` remains the default and keeps running underneath. Its own SDK connection, one subscription change at a time, refused topics dropped; hosts fall back to `1m` records 10 s after their last realtime sample. |
| Hub unreachable or bridge login expired while running. | After 30 s every stream is sent not alive, so the river dries up instead of flowing on stale values; `/healthz` returns 503 at once. |
| 1 s polling load on agents. | Subscribe only while viewers are connected. |
| Public `/stream` abuse. | `limit_conn` per IP; payload is tiny; one upstream subscription regardless of viewers. |
| Recipe leaks via frontend code. | Mixing happens in the bridge; the frontend only knows channel → visual. |
