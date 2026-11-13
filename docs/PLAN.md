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
| Bridge HTTP | `node:http`, no framework | A few fixed routes: `/stream`, `/healthz` and, with `STATIC_DIR`, the page's files loaded at startup. |
| Beszel client | `pocketbase` 0.28.1 + `eventsource` 5.1.3 | The SDK handles login refresh and realtime reconnects; Node needs an `EventSource` polyfill for it. |
| Browser transport | Server-Sent Events | One-way, browser `EventSource` reconnects by itself, simple through nginx. |
| Frontend build | `vite` 8.3.4 | Dev server with proxy, static production build. |
| Rendering | Raw WebGL2, no library | Small needs: a few shaders and two framebuffers. |
| Tests | `vitest` 5.0.5 + `@vitest/coverage-v8` 5.0.5 (bridge and frontend, same versions) | Normalization and mixing are pure functions; coverage thresholds gate every module but the entry points and the debug panel, with fakes for PocketBase, WebGL2 and `EventSource`. How the river looks and performs is checked in a browser. 4.1.12 hit an npm 10 peer-resolution bug in this workspace. |
| CI | GitHub Actions: `npm ci --ignore-scripts` (also in `deploy/Dockerfile`, so dependencies run no install scripts), `typecheck`, `coverage`, `build` on Node 24.22.1, 24 and 26; a `deploy` job checks that secrets stay out of git and the image, runs the image without a hub and healthy against a real Beszel hub (on its Docker network, behind Caddy in a proxy container, and on the host's loopback), scans it with Trivy (a fixed HIGH or CRITICAL advisory fails the run, so it is never published; accepted ones go in `.trivyignore` with the reason), runs `docker compose config`, `nginx -t` and `caddy validate`, and runs the nginx and Caddy configs in front of a stub container (limits, compression, unbuffered events, disconnects). The images it runs are pinned by digest in `deploy/test/compose.ci.yml`. The Node 24 job also scans with SonarQube Cloud (`sonar-project.properties`, coverage from the lcov reporter) on pushes and same-repository pull requests that are not Dependabot's. An OSV-Scanner workflow scans dependencies for known vulnerabilities on pushes, pull requests, and weekly; on pull requests a guard job fails if a tracked file sits at one of the scanner's result paths (`*old-results.json`, `*new-results.json`, `*.sarif`), since the reusable PR workflow would take a committed `old-results.json` as its baseline. An image-scan workflow runs Trivy weekly on the published `edge` and `latest` and uploads every fixed advisory to code scanning, so one published after a release shows up without a build. Trivy runs from its image in `compose.ci.yml`, not `aquasecurity/trivy-action`, whose tags were once replaced with malicious code; Docker Scout would need a Docker Hub secret, which Dependabot and fork pull requests do not get. Actions are pinned to commit SHAs and images to digests; Dependabot proposes updates monthly after a 7-day cooldown | `.github/workflows/ci.yml`, `.github/workflows/osv-scanner.yml`, `.github/workflows/image-scan.yml`, `.github/dependabot.yml`; tests both ends of the supported range, keeps deployment files valid, and scans for dependency vulnerabilities. A tag can be moved to other code, a SHA cannot. |
| Deployment | One container (built on `node:24.22.1-alpine3.24`, running on plain `alpine:3.24` with only the `node` binary) where the bridge also serves the page, behind a reverse proxy; or the bridge under systemd with host nginx serving the static build and proxying `/stream` | See "Deployment". |
| Image publishing | `ghcr.io/juusolatva/beszel-river` for amd64 and arm64 from a `publish` job in `ci.yml`: semver tags from `v1.0.0` (`X.Y.Z`, `X.Y`, `X`, `latest`) and `edge` from `main`; `compose.yml` defaults to the major tag (`1`) | Built only from a commit that passed every check in the same run. The major tag lets `docker compose pull` bring fixes and features but never a breaking release. See "Deployment", "Publishing". |

## Architecture

```
Beszel agents ──► Beszel hub (PocketBase, :8090, on the VPS)
                        │  realtime subscription, logged in as a read-only user
                        ▼
                 bridge (VPS: container or systemd, on 127.0.0.1:8787)
                   ingest → normalize → mix → anonymize → broadcast
                        │  SSE GET /stream (abstract channels only); in the container also the page
                        ▼
                 reverse proxy (nginx or Caddy; TLS) ── page (WebGL2) and /stream ──► browsers
```

Without Docker, nginx serves the static frontend itself and proxies only `/stream` (see "Deployment").

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
.github/workflows/ghcr-cleanup.yml weekly deletion of image versions no tag needs
.github/workflows/image-scan.yml weekly Trivy scan of the published images into code scanning
.github/scripts/ghcr_cleanup.py  its script, tested by test_ghcr_cleanup.py
.github/dependabot.yml           monthly updates for the pinned actions and Docker images
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
    server.ts                 GET /stream, GET /healthz, and the page's files with STATIC_DIR
    static.ts                 loads the frontend build into memory at startup; security headers
    health.ts                 /healthz response; HealthServer for HEALTH_PORT
    http.ts                   raw request path, listen helper
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
  Dockerfile                  container image: bridge and page, built from the repository root
  compose.yml                 the container on 127.0.0.1:8787, with .env and mix.json next to it
  compose.beszel-network.yml  override: join the hub's Docker network
  compose.host-network.yml    override: the host's network, for a hub listening only on loopback
  compose.proxy-network.yml   override: join a proxy container's network instead of publishing the port
  .env.example                template for the container's .env
  beszel-river-bridge.service systemd unit, for running without Docker
  nginx/river.conf            without Docker: own server block, TLS, static root, /stream proxy
  nginx/river-path.conf       without Docker: locations for /river/ in an existing server block
  nginx/river-container.conf  container: own server block, TLS, everything proxied to 127.0.0.1:8787
  nginx/river-container-path.conf container: locations for /river/ in an existing server block
  nginx/river-limits.conf     per-client connection key, included once in the http block
  nginx/river-stream.conf     settings every /stream location includes
  caddy/Caddyfile             container: own site, automatic HTTPS
  caddy/Caddyfile.path        container: /river/ in an existing site (import)
  test/                       deployment tests run by CI; compose.ci.yml pins the images they run
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

Environment variables (templates: `bridge/.env.example`; for the container `deploy/.env.example`, where `deploy/compose.yml` fixes `BIND_HOST`, `BIND_PORT`, `STATIC_DIR`, `HEALTH_PORT` and `MIX_FILE`):

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
| `STATIC_DIR` | (none) | Frontend build to serve next to `/stream` (the container image sets `/app/frontend`). Unset when nginx serves the page. See "HTTP API". |
| `HEALTH_PORT` | (none) | Serve `/healthz` only on `127.0.0.1:HEALTH_PORT` and answer 404 for it on the main listener. Must differ from `BIND_PORT`. Unset keeps `/healthz` on the main listener. |

Mixing weights are read from the configured `MIX_FILE` (`bridge/mix.json` by default). A missing, unreadable or invalid file stops startup before the bridge listens or authenticates to the hub, in every environment and deployment. Startup never substitutes the public example: losing a private recipe must not enable its known filament mapping. For local development or isolated CI smoke tests only, an operator may explicitly select `MIX_FILE=mix.example.json`. `mix.json` is git-ignored at any depth, so the recipe stays out of the public repository. Format: each channel is `clamp01(bias + Σ weight × (feature − center))`, smoothed with time constant `tau` seconds; features are `cpu`, `mem`, `net`, `netChange`, `disk`, `diskChange`, `load`, `burst`, `txShare`, `temp`.

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
  - All snapshot, update and heartbeat writes share a 256 KiB per-response queued-byte budget (UTF-8 bytes, including already queued response output). An event that would exceed it closes the response before writing. If `write()` signals backpressure, no further chunks are enqueued for that client until `drain`; heartbeats are skipped and only whether an update was missed is retained. The latest broadcast is shared across clients and sent after drain when needed. A response blocked for 10 s is destroyed and removed from the viewer count exactly once, allowing normal realtime linger cleanup; shutdown also destroys queued responses instead of waiting for a flush, and on both listeners closes connections that never sent a request (a browser's speculative preconnect, which `server.close()` alone would wait for) at once, lets responses already in progress finish and then closes their keep-alive connections, and cuts off any still unfinished after 5 s, within Docker's 10 s stop timeout. Healthy clients keep receiving updates. Limits are internal `StreamServerOptions` (`maxBufferedBytes`, `drainTimeoutMs`), not environment variables.
- **`GET /healthz`:** 200 while the upstream subscription is live, 503 otherwise (with `X-Content-Type-Options: nosniff`). Not exposed through nginx. With `HEALTH_PORT` it moves to its own listener on `127.0.0.1:HEALTH_PORT`, which answers nothing else (404 for other paths, 405 for other methods), and the main listener answers 404 for it. A proxy that forwards every path to the main listener then cannot expose it.
- **The page (`STATIC_DIR`):** for the standalone container, where the proxy forwards every path. Without `STATIC_DIR` none of this applies and the responses above are unchanged.
  - At startup the bridge reads every regular file at the top level of `STATIC_DIR` and directly in `STATIC_DIR/assets/` into memory, keyed by request path, and serves `index.html` at `/` too. A missing `index.html`, a symlink, any other directory, a hidden file, a name a browser would percent-encode or an extension outside a fixed table (`.html`, `.js`, `.css`, `.svg`, `.png`, `.ico`, `.woff2`, `.txt`) stops startup, naming the entry. A new kind of build output is then a deliberate change, never a silent 404 or an accidental publish. Files are opened with `O_NOFOLLOW` and checked with `fstat`.
  - Requests are matched against that map with the raw-path rule below; no request path is ever turned into a filesystem path, and nothing is read from disk after startup.
  - `GET` and `HEAD`; other methods get 405 with `Allow: GET, HEAD`. `assets/` files (content-hashed names) are sent with `Cache-Control: public, max-age=31536000, immutable`, top-level ones with `no-cache`. Each has a strong `ETag` (SHA-256 of the content), and `If-None-Match` answers 304.
  - No compression: the proxy compresses.
  - Every response of the main listener, including `/stream`, 404, 405 and 503, carries the same headers as `deploy/nginx/river.conf`: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, plus `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`. Not `Strict-Transport-Security`: only the proxy knows whether the site is HTTPS only.
- **Lost hub connection:** the SDK reconnects by itself, but until it does, or for good once a token has expired or been rejected on refresh (which clears the SDK's auth store and retries login with bounded backoff), host statuses are stale and the river would keep flowing on its last values. When the login is invalid or the realtime connection is down for 30 s (`UPSTREAM_GRACE_MS`, longer than the 12 s hub restart in M6), every stream is sent with `alive: false` and its pending pulses are dropped, so the river dries up, and the bridge logs a warning. `/healthz` turns 503 at once. Whenever the connection returns after a drop (including one shorter than 30 s), the bridge re-reads the `systems` list (retrying on failure) to reconcile hosts paused or deleted during the outage, and streams take their current statuses again.
- Routing compares the request-target's path (before `?`) exactly, without a URL parser: a parser throws on some targets (`//`) and resolves `..`, `\` and `//host` in its own way (`//x/stream` becomes `/stream`), which need not match how a proxy routed the request. Other methods get 405 (`HEAD /stream` included); any other target, including `//`, `/x/../stream`, `/assets/../index.html` and absolute-form ones, gets 404.

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
  - The browser reconnects by itself after a dropped connection. An HTTP error (the proxy's 502 while the bridge restarts) closes an `EventSource` for good, so `StreamSource` then reopens it after 5 s, doubling up to 60 s. The browser's `online` event skips the rest of the wait.
  - After 20 s without a connection, every stream thins out and greys as if its host were down, so a stale river does not pass for live data; the snapshot after reconnecting restores it. A bridge restart or a short network drop stays within the 20 s.
  - In dev, when the bridge is not running, the page hands over to `DemoSource` for good (it stops listening, so showing the tab again does not reconnect alongside the demo).
- **Smoothing:** each channel eases exponentially toward its latest value (time constant 1–5 s), so 60 s and 1 s updates both look continuous.
- **Simulation:**
  - The particle pool is fixed-size, held in `Float32Array`s and updated on the CPU.
  - Budget: 10 000 particles on desktop, 8 000 when `(pointer: coarse)` matches. Reduced-motion defaults are 5 000 and 4 000 respectively. Explicit `?particles=N` counts are clamped to 100–10 000 and keep the existing fixed-budget behaviour. The adaptive floor remains a quarter of the chosen pool (2 500 for the normal desktop default).
  - Consider a WebGL2 transform-feedback prototype only if CPU simulation remains a measured bottleneck after the planned CPU optimizations below; it is not required for the current implementation.
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
  - Two framebuffers alternate: each accumulation step draws the previous one dimmed by `exp(-dt / trailTau)`, then the new particles on top. Deposits and the trail floor scale by `(1 - exp(-dt / trailTau)) / (1 - exp(-(1/60) / trailTau))`, preserving the 60 Hz look and equalizing steady-state accumulation, including the floor, before tone mapping.
  - Half-float targets accumulate at the display rate using the simulation's clamped dt. The 8-bit fallback accumulates in fixed 1/60 s steps so faint deposits do not disappear at high refresh rates. It retains fractional time between callbacks, resets it on resize, and presents the latest target every callback. Simulation still follows the display rate, but visible trail motion in the fallback is limited to 60 Hz. Below 60 Hz, multiple accumulation passes use the latest particle positions; this costs extra passes and does not reconstruct missed motion. The 8-bit fallback retains its lower precision and dimmer faint trails relative to half-float at 60 Hz.
  - Particles are drawn as streaks from their previous position, so faster particles get longer tails.
- **Colour:**
  - OKLCH, so all hues look equally bright; converted to linear sRGB in the particle vertex shader.
  - Hue = slow global rotation + vertical gradient + per-stream offset + `heat` drift.
  - Additive blending makes overlapping streams glow.
- **Streams:**
  - Bands overlap with soft edges and braid over time.
  - Each stream caches 64 braid-centre samples over y = [-0.02, 1.08], rebuilt after layout easing and on slot claim. Particles interpolate that table; out-of-range callers retain the analytic sine. The tested approximation error is at most 0.001 of the band's half-width, and table storage is allocated once per slot.
  - A new stream eases in; a stream with `alive = false` thins out and desaturates; a removed stream drains out. Spawn rates are shared out so the pool turns over at the same pace however many streams there are, but never as if less than one full stream were present, so the river empties when the last stream goes.
- **Performance and accessibility:**
  - devicePixelRatio is capped at 1.5.
  - The `EventSource` closes while the tab is hidden.
  - `prefers-reduced-motion`: half the particles, half the speed and sideways noise, half-speed braiding, and pulse flashes and spawn waves at a quarter of their strength, rising over 0.6 s instead of 0.3 s.
  - Adaptive budget (`sim/budget.ts`): after 2 s of callback work above 70% of the learned display period, or frames slower than 1.5× that period (and slower than 45 fps), the live particle limit drops by a fifth, down to a quarter of the pool. Callback work includes stream updates, flow-field generation, spawning, simulation and render submission; it does not measure asynchronous GPU execution. Particles get brighter (up to 2×) so the river keeps its weight. Recovery requires work below 50% of the period and frames keeping up for 10 s, then raises the limit by a tenth; each drop doubles that wait, up to 2 min. A drop only stops spawning, so overload counts again only once particles above the new limit have died. The display period is the fastest confirmed cadence, at most 1/30 s, learned while the pool fills. Three successive faster intervals within 10% of the candidate confirm a new cadence; a single short timing glitch and the partial interval before the first callback cannot establish it. Invalid timing samples are ignored, and pauses over 0.25 s reset both timing windows and pending calibration. Switching refresh or power mode retains the fastest learned period, so it can conservatively thin the river. `?particles=N` fixes the count.
  - The simulation and renderer allocate nothing per frame: the band layout sorts into a preallocated list, and the noise function uses plain locals (its output is unchanged).
  - Without WebGL2 the page shows one line of grey text saying the animation needs it.
- **Naming:** the public page (title, visible text) never mentions Beszel or hostnames.

The bridge rejects hub URLs with unsupported schemes or embedded credentials without logging the rejected value, rejects malformed JSON recipes without echoing file snippets, and deletes secret variables (`BESZEL_PASSWORD`, `BESZEL_TOKEN`, `STREAM_SALT`) from `process.env` once configuration is loaded. Log records escape CR/LF, HTTP error URLs omit userinfo, and error cause chains stop after five entries (including cycles).

## Frontend performance implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Checkboxes and the implementation record below track progress; the Frontend section above describes implemented behaviour. Unchecked hardware acceptance is not implied by passing unit or software-browser tests.

**Goal:** Degrade smoothly on slower hardware and reduce per-particle CPU work while preserving the river's appearance and lifecycle.

**Architecture:** Keep the CPU simulation and existing WebGL2 renderer for parts 1 and 2. First adapt particle count to measured callback work and normalize trail deposits, then measure three independent hot-path optimizations. A GPU prototype is a separate, conditional experiment.

**Tech stack:** Existing TypeScript, typed arrays, raw WebGL2/GLSL and Vitest; no new dependencies.

**Spec:** This section and the existing Frontend section; privacy and stream semantics elsewhere in this document remain unchanged.

### Constraints and review focus

- No per-particle or per-frame allocations in simulation/rendering. Allocate tables and buffers at construction or resize; retain Node 24.22.1 compatibility and existing coverage thresholds.
- Preserve exact CPU stream particle accounting, filament selection, spawning weights, offline draining, daily ID rotation and reduced motion through parts 1 and 2.
- Test high-refresh displays, startup calibration, battery throttling and hidden-tab pauses in the budget task. CPU callback timing does not measure completed asynchronous GPU work.
- Test zero dt, missed frames, trail-floor behaviour and both render-target formats in the brightness task. Normalizing accumulation does not reconstruct motion between missed frames.
- Test centre-table boundaries and shrinking/resizing flow grids in the sampling tasks; particles can lie outside the visible y range.
- Test recycled particle slots, changing vitality/chroma, DPR resize, empty pools and sparse pools in the instance task. Per-particle width is not a per-stream constant.
- Browser checks must exercise stream replacement while old particles drain, lane transitions and reduced motion after every visual/layout change.

### Review and implementation record — 2026-11-12

- Review: retain the CPU-first sequence. Tasks 3–5 are measured experiments, and the GPU prototype remains conditional; there is no measured basis for accepting them in this increment. Starting implementation does not satisfy Task 0's target-device baseline.
- Task 0: production assets built with Node 24.22.1 and npm 11.19.1 before changes (27.07 kB JS, gzip 10.88 kB). X280 AC/battery and real-phone timing runs are unverified. No hardware speedup or 22 ms → 15 ms result is claimed.
- Task 1: 26 budget tests pass, including synthetic 30/60/120/240 Hz traces. New tests first failed on the old implementation. A real Chrome/SwiftShader startup fixture exposed a partial-first-interval calibration bug: a 1 ms first callback followed by 60 Hz and 8 ms work incorrectly reduced the limit to 16,000. Excluding that initial interval retained 20,000. Pause handling now resets both sustained timing windows; recovery starts fresh after resuming.
- Task 2: two new renderer tests first failed for the missing uniform, then all nine renderer tests passed. They check zero dt, 240/60/30 Hz and `LOOK.maxDt` for both formats, with identical steady-state accumulation before the floor. Actual shader readbacks in Chrome/SwiftShader confirmed zero dt deposits no energy. A stationary faint streak (lightness 0.75, chroma 0, intensity 0.05, half-width 2 px) after 2 s produced screen red bytes 131/129/116 at 30/60/240 Hz in RGBA16F, and 97/27/17 in RGBA8. This fixture demonstrates substantial residual floor/quantization effects in the 8-bit fallback; it is not proof of visual equivalence or of restored missed motion. Real-display flicker acceptance remains unverified.
- Browser correctness: deterministic seed-42 channel fixtures exercised both target formats at normal and reduced motion, with filament removal/reintroduction, replacement of all 32 stream IDs while old particles drained, offline/reconnect, aspect/DPR resize and eventual last-stream removal. Live counts matched per-stream counts, instance values stayed finite, draining finished, and no WebGL errors occurred. The draining fixture initially allowed only 20 s; matching the existing unit test's 44 s window passed without a simulation change. The rendered page was inspected at 960×640/DPR 1. These software-rendered checks do not measure target-device performance.
- Validation: `npm run typecheck`, `npm run coverage` and `npm run build` passed. Coverage ran all 204 bridge and 99 frontend tests with the existing thresholds. Target-device cadence, battery throttling and thermal measurements remain pending.
- Integration: an independent code review found no correctness issues in Tasks 1–2. The first increment implements those tasks; their hardware acceptance, Tasks 0 and 3–6, and the conditional GPU work remain pending.

#### PR #114 review corrections

- Gemini's transient-short-interval finding was reproduced by two failing tests: a 0.1 ms sample permanently lowered the work thresholds and prevented recovery at 60 Hz. Calibration now needs three consistent faster intervals instead of accepting an isolated minimum. This also avoids imposing an arbitrary maximum refresh rate; synthetic 360/480 Hz overload tests still pass.
- Qodo's faint-trail finding is supported by the initial readbacks above. Scaling the floor alone improved half-float output but left RGBA8 inconsistent: the faint-streak red bytes were 55/27/17/65 at 30/60/120/240 Hz. That experiment was rejected for the fallback.
- Task 2's unchanged-floor requirement is superseded by the trail behaviour described above: normalize the half-float floor too, and use fixed 60 Hz accumulation in RGBA8. This preserves the 60 Hz fallback look and avoids sub-byte high-refresh deposits, at the cost of 60 Hz trail motion and extra passes below 60 Hz. Hardware performance and real-display motion acceptance remain pending.
- The persistent `frontend/test/renderer.browser.ts` regression fixture first failed against the previous renderer (faint half-float red bytes 131/129/126/116). The fix passes: faint red bytes 129/129/129/127 in half-float and 27/27/27/27 in RGBA8; at intensity 0.3 they are 230/230/229/229 and 222/222/222/222. Both formats also reach black after particles leave and add no energy at zero dt. These are actual shader readbacks in Chrome/SwiftShader, not hardware performance results.
- Correction validation: all 31 budget and 16 renderer tests pass, including a further red→green check for a modest 60→64 Hz refresh increase. Typecheck, coverage (204 bridge / 111 frontend tests, unchanged thresholds), production build and diff checks pass. The initial coverage run overlapped software Chrome and hit the existing 5 s timeouts in `frees a removed stream's particles as they die, so its slot is released` and `drains the river when every stream leaves, and fades a later stream in`; rerunning after closing Chrome passed without changing either test or its timeout. The two-format lifecycle fixture again passed lane changes, all-32-stream rotation, reduced motion, offline/reconnect, aspect/DPR resize and complete draining. Independent review found no actionable issues.

#### X280 battery profile and Task 3

- The supplied 72.845 s Firefox profile runs the `index-CpdGUFPC.js` bundle from PR #114. The user confirmed battery operation without another heavy app; a separate observation concerned video playback on AC. The raw recording includes unrelated browser activity and is not committed.
- The river's 4,284 complete animation-callback markers have median 10.858 ms, p95 17.378 ms, p99 22.490 ms and maximum 67.941 ms. 272 callbacks exceed one 60 Hz display period. These are elapsed callback timings under profiling, not presented-frame or GPU execution measurements. The recording has no particle-limit telemetry, so it does not establish how far the adaptive limit had fallen.
- CPU-delta-weighted stack samples attribute about 66% of callback CPU to `ParticleSystem.step`. Its children include braid-centre sine calculations (about 15% of callback CPU) and flow sampling (about 14%). Render submission accounts for about 20%, including `bufferSubData` at about 13%; flow-field generation is another 13%. Child percentages overlap their parents. GC slices reach about 11.4 ms, which can consume remaining display headroom, but the capture does not prove that GC explains each reported 5–15 s hitch. GPU completion time and CPU clock/power transitions remain unmeasured.
- Task 3 replaces the per-particle braid sine with a preallocated `Float64Array(64)` per slot. Accuracy, table boundaries, zero width, resize, slot reuse and short deterministic plain/filament trajectories are covered. Rebuild on claim also covers pending daily replacement claiming a slot at the end of `StreamSet.update`, before its next layout pass. New cache assertions were observed failing first; an additional reuse regression was caught and fixed before handoff.
- Paired CPU-only benchmark: this ThinkPad X280/i5-8350U, Linux, isolated headless Firefox 160, **AC connected**. `frontend/test/cpu-benchmark.browser.ts` uses six prebuilt synthetic channel snapshots, seed 42, capacity/limit 20,000, aspect 1.5 and DPR scale 1.5. Each case resets simulation, warms up for 600 simulated frames, then measures 1,200 frames at dt = 1/60 s without rendering. Run order is analytic/cached/cached/analytic/analytic/cached. The analytic reference skips cache rebuilding; cached rebuilding is included. Every run finishes with 16,661 live particles.

  | Run | Analytic mean CPU work (ms/frame) | Cached mean CPU work (ms/frame) |
  |---|---:|---:|
  | 1 | 2.448 | 2.139 |
  | 2 | 2.423 | 2.244 |
  | 3 | 2.533 | 2.226 |
  | Mean | 2.468 | 2.203 |

- This is about 10.7% less CPU simulation work; all cached means are below all analytic means. Firefox's 1 ms timer granularity leaves per-frame median/p95 readings unchanged (2/3 ms), so no tail-latency improvement is claimed from this benchmark. Rendering, upload, battery cadence and phone performance are outside it; thermal conditions and other host activity were not controlled to Task 0's standard. Retain the measured CPU optimization, but keep full battery/AC acceptance pending. A new live battery profile is needed to assess the original stutter after deployment.
- Software-WebGL checks pass for plain/filament transitions, both render-target formats, reduced motion, all-32-stream replacement while draining, offline/reconnect, aspect/DPR resize and complete draining. No allocation was added to simulation hot loops; the deferred `ParticleBudget.update` complexity issue is unchanged.
- Verification: 32 targeted stream/particle tests pass; typecheck and production build pass, and coverage passes for all 204 bridge and 117 frontend tests with unchanged coverage thresholds and five-second test timeouts. The long empty-river fixture initially timed out under coverage in both the cached and unchanged analytic implementations on this X280. Its helper now skips flow-grid generation only when there are no particles to sample it, while continuing all simulation steps and assertions. Field generation is recomputed from the current time before any particle step that can sample it. Independent review found no correctness issue in the cache or the paired benchmark.
- PR #115 Gemini experiment: replace `Math.floor`/`Math.min` in interpolation with bitwise truncation and an upper-bound branch, and reuse the first table value in a local. The bounded position makes this semantically safe, but significant speedup is unproven. The same paired Firefox 160/X280/AC CPU fixture produced current means 2.823/2.833/3.124 ms and proposed means 2.843/2.758/2.948 ms (ABBAAB; all 16,661 live). Aggregate means are 2.927 vs 2.849 ms, about 2.6% apart, with overlapping run ranges and variation larger than that difference. Reject the production rewrite under the plan's beyond-noise acceptance rule; retain the existing interpolation. This is a performance suggestion, not a reproduced correctness defect.

#### Second X280 profile and the 10,000-particle ceiling

- The second supplied recording spans 77.898 s and contains sampled `rebuildCenters` calls, confirming the cache implementation is running. Its 4,418 complete animation callbacks have median 11.623 ms, p95 18.960 ms and p99 22.145 ms; 457 callbacks exceed a 60 Hz period. These are separate live captures with uncontrolled load/power conditions, so their difference does not measure a cache regression or improvement. The recording stays local and untracked.
- CPU-delta-weighted samples still attribute about 67% of callback CPU to particle stepping, including flow sampling at about 15% and cached centre sampling at about 7%. Render submission is about 20%, including buffer uploads at about 12%; flow-field generation is about 12%. These sampled CPU attributions include child work and do not measure GPU execution. There is also a 159 ms gap between callback starts following a 13 ms callback; reducing particle work cannot be assumed to explain or eliminate every visible pause.
- At the user's request, reduce the desktop default from 20,000 to 10,000 and make 10,000 the public page's hard upper bound, including explicit URL counts. Preserve the coarse-pointer default of 8,000, half-count reduced-motion defaults, fixed-count flag, minimum of 100 and quarter-pool adaptive floor. No changes to the deferred `ParticleBudget.update` complexity issue or to rendering intensity are included. The existing 20,000-particle CPU benchmark remains a diagnostic reference workload, separate from the page's configuration limit.
- Verification: new default/override assertions first failed, then all seven configuration tests passed. Typecheck, coverage (204 bridge / 121 frontend tests with unchanged thresholds/timeouts), production build and diff checks pass. The seeded demo browser smoke check reports the actual 10,000-particle desktop limit with no JavaScript errors; this correctness check does not establish battery performance. Independent review found no correctness issue in the limit, allocation bounds or preserved media/fixed-count semantics.
- Verify the lower ceiling on the deployed page before judging battery smoothness. The profiles justify continued CPU/upload investigation and assessment of an isolated GPU prototype if 10,000 still misses cadence. A transform-feedback prototype remains a separate experiment with the CPU reference, lifecycle/accounting tests and real-hardware measurements described below; this change does not switch simulation implementations or claim that the stutter is fixed.

### Task 0: Establish a repeatable baseline

**Files:** Record results under this section; inspect `frontend/src/main.ts`, `frontend/src/debug/panel.ts` and `frontend/src/render/renderer.ts`. Temporary profiling instrumentation must not allocate in hot loops or ship unintentionally.

- [ ] Build production assets and replay the same recorded channel sequence with the same seed, viewport, DPR and browser. Do not measure live host metrics while a software-rendered browser is loading that host.
- [ ] Capture three 60-second runs after a 30-second warmup on the X280, separately on AC and battery, and on an available real phone. Record browser/OS, refresh rate, power mode and thermal conditions. Mark unavailable hardware as unverified.
- [ ] Record median/p95 callback work, simulation work, upload submission time, frame intervals/missed display periods, live count and limit. Measure fixed-count runs for optimization comparisons, then adaptive runs for user-visible behaviour. CPU upload timing can include driver stalls; it is not a GPU execution measurement.
- [ ] Repeat the same procedure after each task and retain a before/after ledger, including rejected experiments. The supplied 22 ms baseline and estimated 15 ms outcome are hypotheses until reproduced. Require improvements beyond baseline run-to-run variance, without visual regressions.

### Task 1: Budget from work as well as frame intervals (part 1)

**Files:** `frontend/src/sim/budget.ts`, `frontend/src/main.ts`, `frontend/test/budget.test.ts`; update the Frontend budget description when shipped.

**Interface:** Change `ParticleBudget.update` to `update(interval: number, live: number, workSeconds: number): boolean`; all time arguments are seconds. Measure from immediately before stream/field/spawn/step work to immediately after `renderer.render`, then update the budget for the next frame using the current live count. Include the whole simulation and render submission, not only `stats.simMs`.

- [x] Add failing tests: 60 Hz with 13 ms work drops 1000 → 800 after more than 2 seconds; 60 Hz with 8 ms work remains at 1000; sustained 18–22 ms callback work triggers a drop. At 240 Hz, 3 ms work triggers a drop; at 30 Hz, 10 ms does not.
- [x] Add tests for the boundary (70% of period is not overloaded), recovery hysteresis, fixed count, live count above the new limit, floor/ceiling, pause/zero/invalid samples, and cheap callbacks with slow frame intervals. Preserve existing interval-based overload detection as a fallback for GPU pressure.
- [x] Run `npm test -w frontend -- test/budget.test.ts` and confirm the new assertions fail before implementation.
- [x] Treat work above 70% of the learned display period OR the existing slow-interval condition as overload. Permit recovery only below 50% work utilization AND the existing fast-interval condition. Preserve the 2-second drop window, 20% drops, quarter-pool floor, 10% rises, doubled recovery wait up to 120 seconds, and wait for excess particles to drain. Retain initial fastest-period calibration capped at 1/30 s, using full intervals between animation callbacks and confirming faster cadence with three consistent samples; reject nonfinite or negative timing inputs and reset sustained timing windows on pauses over 0.25 s. Do not let a long pause become measured sustained overload.
- [ ] Pass the targeted tests, then verify adaptive behaviour at 30/60/120/240 Hz in synthetic traces and on available hardware. Record that switching refresh/power mode mid-session retains the current conservative fastest-period assumption. Keep brightness compensation unchanged.

### Task 2: Normalize the particle deposit (part 1)

**Files:** `frontend/src/render/renderer.ts`, `frontend/src/render/shaders/particle.vert`, `frontend/test/renderer.test.ts`, `frontend/test/renderer.browser.ts`; update the Frontend trail description when shipped.

**Interface:** Add shader uniform `u_depositScale`; multiply particle linear RGB intensity by it once. Keep `Renderer.render`'s signature and the exponential trail decay. Following PR review, scale the floor with deposits in half-float targets and use fixed 60 Hz accumulation in RGBA8; see the review corrections above.

- [x] Add failing renderer tests for uniform values at dt = 0, 1/240, 1/60, 1/30 and `LOOK.maxDt`: scale is zero at zero dt, one at 60 Hz and finite throughout. Check the recurrence `Bnext = exp(-dt/tau) * B + depositScale` has the same steady-state B at 30/60/240 Hz within floating-point tolerance (before floor and tone mapping).
- [x] Run `npm test -w frontend -- test/renderer.test.ts` and confirm the new expectations fail.
- [x] Set the uniform to `-Math.expm1(-dt / LOOK.trailTau) / -Math.expm1(-(1 / 60) / LOOK.trailTau)` and scale the floor with it. Use the same clamped dt as simulation in half-float targets; in RGBA8 accumulate that clamped time in 1/60 s steps. Do not deposit an entire hidden-tab interval on return. Keep `intensityScale` multiplication separate and applied once.
- [ ] Pass tests and compare brightness/trails in a browser at available refresh rates, with deliberately missed frames and thin/full pools. Exercise half-float and 8-bit target paths: the existing floor and quantization mean exact visual equivalence is not guaranteed. Record residual flicker rather than claiming missed motion is restored.

### Task 3: Cache braid centres (part 2)

**Files:** `frontend/src/sim/streams.ts`, `frontend/test/streams.test.ts`, `frontend/test/particles.test.ts`, `frontend/test/cpu-benchmark.browser.ts`, `frontend/test/benchmark.html`.

**Interface:** Keep `StreamSlot.centerAt(y: number): number`; add a preallocated 64-entry centre table per slot and a `rebuildCenters(): void` method called after layout easing and derivation in `StreamSet.update`.

- [x] Add failing tests comparing interpolated centres with the analytic sine across phases, widths and y in [-0.02, 1.08]. Require absolute error at most `0.001 * half` plus floating-point tolerance. Include exact endpoints, zero width, slot reuse and resize.
- [x] Run `npm test -w frontend -- test/streams.test.ts test/particles.test.ts` and confirm the approximation/cache assertions fail.
- [x] Fill the table once per used stream per frame over [-0.02, 1.08], then interpolate in `centerAt`. Rebuild on claim as well, so pending slot reuse cannot sample the old stream's phase. Use the original analytic expression outside that interval so callers do not silently acquire clamping semantics. No array creation during rebuild or sampling.
- [x] Pass tests, inspect fixed-seed filament and plain-band runs in a browser, and measure the change alone. Accepted from the paired Firefox CPU benchmark above; full battery/AC cadence acceptance remains pending. This is an approximation, not bit-identical motion.

### Task 4: Inline interleaved flow sampling (part 2)

**Files:** `frontend/src/sim/noise.ts`, `frontend/src/sim/particles.ts`, `frontend/test/noise.test.ts`, `frontend/test/particles.test.ts`.

**Interface:** Expose read-only access to `FlowField.cols`, `rows`, `cell` and interleaved `vectors: Float32Array` (`vx, vy` per grid point). Replace separate vx/vy storage. Keep `sample(x, y)` as a reference/test API, but remove calls to it from `ParticleSystem.step`.

- [ ] Add failing checks for interleaved grid values and bilinear results at cell centres, edges, out-of-bounds positions and after aspect changes. Compare deterministic particle trajectories with the pre-change implementation within a documented float tolerance.
- [ ] Run `npm test -w frontend -- test/noise.test.ts test/particles.test.ts` and confirm new layout expectations fail.
- [ ] Cache field references and dimensions outside the particle loop; inline the existing clamping and four-corner weighted interpolation. Preserve arithmetic order where possible and avoid `sx`/`sy` property writes per particle. Reallocate the field only when grid dimensions change.
- [ ] Pass tests and benchmark separately from Task 3. Interleaving improves locality; it still reads eight scalar components per sample. JIT inlining may already remove call overhead, so reject the rewrite if the measured gain is within noise.

### Task 5: Reduce instance writes and uploads (part 2, measured experiment)

**Files:** `frontend/src/sim/particles.ts`, `frontend/src/render/renderer.ts`, `frontend/src/render/shaders/particle.vert`, `frontend/test/particles.test.ts`, `frontend/test/renderer.test.ts`, `frontend/test/fake-gl.ts` as needed.

**Design:** Start with six dynamic floats per stable particle slot: tail.xy, head.xy, hue and intensity. Keep stream index and size jitter in a separate two-float buffer updated on spawn/reuse. Supply current chroma in a preallocated 32-entry per-stream uniform array, lightness as a uniform, and size/DPR scale as a uniform. Chroma must still respond to vitality every frame. Six is an initial target; do not force five by lossy packing or extra indirection without evidence.

**Interfaces:** Keep `ParticleSystem.count` as the live count and preserve the free list and stream counters. Add `drawCount` as the highest occupied slot plus one, `metadata: Float32Array`, and preallocated dirty-slot tracking. Extend `Renderer.render` to accept the dynamic buffer, metadata updates, draw count and current stream chroma/size scale. Finalize the typed argument contract in this task's change before modifying callers; update `main.ts` and its test harness callers together.

- [ ] Add failing tests for stable slot-to-metadata identity across deaths, free-list reuse and stream rotation; exact live counts; zero intensity on dead slots; width changes on DPR resize; and per-stream chroma changes without metadata uploads. Check attribute stride/divisors, uniform uploads and metadata dirtiness clearing after upload.
- [ ] Run `npm test -w frontend -- test/particles.test.ts test/renderer.test.ts` and confirm new layout assertions fail.
- [ ] Replace live-instance compaction with stable slots; zero intensity once on death, skip inactive slots in simulation, and trim `drawCount` when high slots die. Clip zero-intensity instances in the vertex shader before expensive colour conversion. Batch adjacent dirty metadata slots without allocating temporary arrays. Upload only the dynamic prefix through `drawCount`.
- [ ] Pass tests and benchmark dense, sparse and draining pools. Six floats across holes may cost more than nine floats compacted to live particles, and metadata upload calls also cost time. Keep this design only if total callback work improves beyond noise without material sparse-pool/GPU regressions; otherwise retain the nine-float layout and record the rejected experiment. Do not trade lifecycle correctness for an upload-size target.

### Task 6: Validate and integrate parts 1 and 2

- [ ] After each accepted task, update the shipped Frontend description and run `npm run typecheck`, `npm run coverage`, `npm run build` before its logical commit. Do not lower thresholds or remove behavioural tests to accommodate a layout change.
- [ ] Repeat Task 0's fixed and adaptive runs. Record each accepted/rejected optimization and the combined result, distinguishing CPU work from frame cadence and GPU time. Check lost connection, last-stream removal, daily replacement at all 32 stream slots, reduced motion, resize and hidden-tab return in a real browser.
- [ ] Aim for sustained work below 70% of the display period after adaptation (about 11.7 ms at 60 Hz), with fewer missed periods and no visible brightness discontinuity when the pool thins. The existing quarter-pool floor may prevent this on some devices; report that outcome rather than silently lowering the floor or declaring success.
- [ ] Evaluate the conditional GPU prototype below using the CPU implementation at display cadence as the reference. On 2026-11-13 the user chose to drop fixed 30 Hz simulation with interpolated rendering and proceed directly to the isolated GPU experiment; that alternative is no longer a required comparison.

### Conditional GPU prototype plan

Detailed execution plan: [GPU Particle Prototype Implementation Plan](superpowers/plans/2026-11-13-gpu-prototype.md). The isolated CPU replay harness, GPU motion, spawning and ownership checks are implemented. Task 3 failed the fixed per-stream occupancy gate; this candidate stops before drawing integration and performance acceptance.

**Resume note — 2026-11-13:** Work is paused at the user's request after merging PR #120. Task 4 remains blocked: the original occupancy gate still fails 43/330 comparisons. The plain-spawn discrepancy is explained: on the recording laptop the GPU's `cos()` errs by 3.5e-5 there (GLSL ES leaves trigonometric precision undefined), which moved one birth across the −0.1 death boundary; see the investigation's 2026-11-14 follow-up. The validation plan is revised: a multi-seed [occupancy gate](superpowers/plans/2026-11-13-gpu-prototype.md#revised-occupancy-gate--approved-2026-11-14) was approved on 2026-11-14, aiming at an unchanged look rather than identical particles. Its test harness and CPU calibration come next; Task 4 stays blocked until the GPU passes it. Resume with the [handoff checklist](superpowers/plans/2026-11-13-gpu-prototype.md#resume-checklist--2026-11-13), before drawing integration. Merging the investigation did not clear the gate.

**Trigger:** Parts 1 and 2 have measured results, and real target hardware still misses the desired cadence because of CPU simulation/upload work. GPU fill-rate or trail-buffer bandwidth pressure alone is not a reason to port simulation.

**Explicit experiment exception — 2026-11-13:** The user authorized going straight to the isolated GPU prototype without waiting for the remaining CPU experiments and dropped the fixed 30 Hz/interpolated-rendering alternative. This permits prototype implementation only; it does not mark Parts 1–2 complete or establish the trigger from existing measurements. Freeze the current CPU reference and collect paired baseline/candidate runs, including full-screen X280 AC/battery and a real lower-end phone. Missing hardware permits correctness work but leaves performance acceptance unverified. Production migration still needs a separate proposal and measured benefit.

**Scope:** An isolated experimental branch, retaining the CPU implementation as the reference. Candidate new files are `frontend/src/sim/gpu-particles.ts` and `frontend/src/render/shaders/simulate.vert`; adapt GL program linking, renderer buffer inputs and browser tests as needed. Do not switch the production default as part of the prototype.

- [ ] Build the smallest transform-feedback pass: alternate two particle-state buffers, update velocity/position/age in a vertex shader with rasterization disabled, and draw directly from the resulting state. Never bind the same buffer as feedback output and vertex input simultaneously. Keep stream easing/layout on the CPU; initially upload the existing coarse flow grid as a texture rather than porting noise generation too.
  - Task 2 motion-only implementation is isolated in `sim/gpu-particles.ts`, with a shared 64-byte float/integer layout and CPU-generated flow/stream textures. `test/gpu-particles.browser.ts` compares preloaded CPU/GPU state with spawning disabled; the production page and benchmark GPU backend remain unchanged. Headless Firefox correctness checks passed 24 cases at the original tolerances (1e-5 one step, 1e-3 after 120 steps). Prototype replay canonicalizes the clamped step to Float32 for both references, retaining the original interval separately; production CPU timing is unchanged. Task 3's spawning/lifecycle result is below; drawing and hardware acceptance remain pending.
- [ ] Prototype global free-slot allocation without atomics: render inactive flags into R32UI, ping-pong an inclusive prefix scan, then assign unique free ranks to CPU-issued per-stream spawn requests during transform feedback. Keep the CPU rate/carry equations, slot-index request priority, filament weighting, variable lifetimes and pre-step free-slot semantics. No fixed stream ranges or probabilistic dead-slot respawning. Account for the extra flag/scan passes, full inactive capacity and integer/float data textures; no synchronous per-frame state readback.
  - Task 3 implements integer flags/prefixes and spawning. Real-shader exact allocation checks pass, including 2,075 live / 425 dead, overflow, shrink/grow, next-step reuse, counter-wrap invalidation and deterministic seeds. Long plain/filament runs pass total occupancy but fail 43 of 330 total/per-stream comparisons at the existing five-second `max(5 particles, 5%)` gate. A different-seed CPU control fails 49 comparisons, supporting sensitivity to random sequence and stream priority; it does not make the GPU candidate pass. See the detailed plan's result and retained synthetic curves.
  - The [occupancy investigation](experiments/2026-11-13-gpu-occupancy.md) reproduces those means exactly and verifies 12 million allocation decisions. A CPU control matching GPU random keys and free order passes all 330 diagnostic comparisons; free order alone leaves CPU counts unchanged. The filament control matches every active identity; the plain control diverges on 485/600 callbacks after an unresolved spawn-calculation difference crosses the death boundary. Passing plain means does not isolate randomness as the dominant cause. The committed summary processor verifies historical reproduction. Isolating the plain spawn discrepancy and defining fresh acceptance evidence remain necessary before Task 4.
- [ ] Solve safe stream-slot reuse with a mandatory release-policy seam defaulting to exact CPU particle counts. GPU mode stops requests when a removed stream's presence falls below 0.01, retains parameters until more than maximum lifetime + the maximum effective step (nominally 14.1 s; `LOOK.lifeRange[1] + Math.fround(LOOK.maxDt)`) after the last possible spawn, and resets the drain deadline if that ID returns. Keep generations and pending-frame retries; never put estimated counts into StreamSlot.particles. Compare conservative replacement delays and the suppressed residual-spawn tail with the CPU reference, especially all 32 slots rotating.
  - Task 3's seam defaults to exact CPU counts. GPU rotation/reappearance/repeated pending replacement checks pass without live-generation reuse; the final pending replacement was claimed after 21.9 s versus CPU 20.7 s. This is correctness evidence with 128 allocated slots, not visual acceptance. Local review exposed Float32 age drift for arbitrarily small steps; GPU steps now explicitly require zero or `[1/256, Math.fround(LOOK.maxDt)]` seconds and a simulation clock below 2³¹ s. These bounds prove the deadline margin covers accumulated age/clock rounding and the current callback. Unsupported traces fail; CPU timing and production behavior are unchanged.
  - PR #119 review added an internal claim counter so a fully released ID returning to the same slot resets GPU carry and generation, including when no GPU prepare observed the unused slot. Its old deadline cannot authorize the fresh claim. Reappearance before release preserves the existing carry and generation. This correction does not relax the failed occupancy gate.
- [ ] Run real-browser shader tests on small deterministic fixtures, reading back only for tests: verify motion tolerances, slope bounds, birth/death, draining, stream generations and finite state. Keep CPU unit tests for shared stream rules and fake-WebGL tests for buffer/program orchestration. Do not treat fake calls as proof that GLSL implements the rules.
- [ ] Benchmark the prototype against the frozen CPU baseline using Task 0's workload on the X280 and a real phone. Record callback work, frame cadence, GPU cost where supported, power/thermal behaviour and memory. Validate exact occupancy in separate untimed trace replays. Compare fixed limits first; for matched limit changes replay a CPU-recorded adaptive schedule through both backends. Do not feed conservative counts into ParticleBudget: live <= limit gates further overload drops, not recovery. Native GPU adaptation needs a separate asynchronous-summary design. Account for full-capacity scan/vertex work even after a limit drop and for unchanged trail rendering.
- [ ] Decide keep/reject from measured gains and visual/lifecycle parity. Only a separate production proposal should address final accounting semantics, capability/resource failure handling, context loss, CPU fallback and maintenance of both implementations. If available hardware cannot validate performance, leave the result explicitly unverified.

### Measurement ledger

Earlier cache comparisons and supplied-profile findings are recorded above. The following is a controlled battery replay of the 10,000-particle change.

#### X280 battery confirmation — 2026-11-12

- Runtime code: commit `6980d5a` (PR #116), imported locally through Vite; this is not a deployed production-bundle recording. Device: ThinkPad X280/i5-8350U, Fedora kernel `7.3.3-200.fc44.x86_64`, Firefox 160 in a separate visible GUI profile. AC was disconnected and BAT0 reported `Discharging` at every five-second monitor sample. CPU governor was `powersave`, energy preference `balance_power`, with turbo allowed. No agent build, coverage or software-WebGL jobs ran concurrently.
- CPU-only paired comparison uses the same six synthetic snapshots/seed 42/aspect 1.5/DPR scale 1.5 as the earlier cache benchmark, with cached centres in both variants. Each case resets state, warms up for 600 simulated frames and measures 1,200 more at dt = 1/60. The 20,000-particle case is an internal reference workload, not a bypass of the page's public ceiling. Run order: 20k/10k/10k/20k/20k/10k.

  | Pool ceiling | Mean CPU ms/frame, three runs | Combined mean | Final live count |
  |---|---|---:|---:|
  | 20,000 reference | 2.904 / 2.903 / 2.903 | 2.903 | 16,661 |
  | 10,000 | 1.552 / 1.533 / 1.563 | 1.549 | 8,295 |

- This is 46.6% less CPU simulation work in the tight-loop comparison. Per-frame medians/p95s are quantized by Firefox's 1 ms timer. CPU package samples were 47–60 °C. A continuously busy loop can exercise power management differently from animation callbacks; do not substitute these throughput numbers for real frame work.
- Rendering replay uses four synthetic streams with alternating plain/filament snapshots, seed 42, normal motion, a 960×640 CSS canvas, DPR 1.2 and 1152×768 framebuffers. Firefox reported an Intel renderer, used RGBA16F, and the isolated process had active i915 GPU render counters; no software-renderer flags were used. GPU completion time was not measured. The adaptive budget was enabled with a 10,000 ceiling. Each of three runs had a **30 s wall-clock warmup followed by 60 s of measurement**.

  | Run | CPU work mean / median / p95 / p99 / max (ms) | Simulation p95 (ms) | Render-submission p95 (ms) |
  |---|---|---:|---:|
  | 1 | 7.401 / 7 / 10 / 11 / 27 | 8 | 2 |
  | 2 | 7.402 / 7 / 10 / 11 / 14 | 8 | 2 |
  | 3 | 7.204 / 7 / 9 / 11 / 14 | 8 | 2 |

- All 10,809 measured callbacks kept the budget at 10,000 without a drop or rise; average live counts were 8,459–8,463, with peaks 8,686–8,694. Thus this is normal populated-scene coverage, not a fully occupied 10,000-live-particle stress case. One callback's CPU work exceeded 16.67 ms. All contexts stayed visible, WebGL reported no error, and all 56 power samples remained on battery; CPU package samples were 46–64 °C.
- Animation timestamps are not actual callback-start or presentation timestamps. A separate 10 s warmup/30 s measurement checked actual callback-entry spacing: 1,802 callbacks, mean 16.653 ms, p95/p99 18 ms and maximum 19 ms, with no interval above 25 ms. CPU work p95 was 9 ms, the budget stayed at 10,000, and all power samples again showed battery operation. This does not measure compositor presentation or prove zero dropped display frames.
- Decision: keep the 10,000 ceiling for the next deployed check. It provides CPU headroom in this battery replay, but the live SSE sequence, usual full-screen viewport, fully saturated pool, video-on-AC case, phone and GPU prototype remain unverified. No production code changed during this measurement step.

## Deployment

Commands and steps are in README, "Deployment".

- **Container** (`deploy/Dockerfile`, `deploy/compose.yml`):
  - Multi-stage image on `node:24.22.1-alpine3.24`, pinned to one multi-platform SHA256 digest in all stages (monthly Dependabot Docker updates with a seven-day cooldown, within the Node major: a new major changes the production runtime and is made together with `.nvmrc`, `engines` and the CI matrix). The build and production-dependency stages run on the build machine's platform, since their output is plain JS; the production stage fails if a dependency ships a native addon (`*.node`, `binding.gyp`), which would need a per-architecture install. The final stage has no `RUN` step, so other architectures need no emulation. It starts from `alpine:3.24.3`, also pinned by digest, and takes only `/usr/local/bin/node` and the two libraries it links against (`libstdc++.so.6`, `libgcc_s.so.1`) from the Node image for the target platform: npm, npx, yarn and corepack never run in production, and scanners reported advisories in npm's bundled packages. node is built against its image's musl and libstdc++, so both images must be on the same Alpine minor release: the Node tag names it (`-alpine3.24`, rather than `-alpine`, which moves to a new Alpine release on its own), Dependabot proposes no new Alpine minor for the runtime base and groups the two images' updates in one pull request, and the deps stage fails if they still differ. Moving to a new Alpine release changes both tags together. The final stage holds `bridge/dist`, production dependencies, `frontend/dist` as `/app/frontend` and `mix.example.json`, owned by root, and runs as uid 1000 (the Node image's `node` user; Alpine has no account for it, and nothing needs the name). Without the Node image's `docker-entrypoint.sh`, `CMD` starts node directly.
  - One process: the bridge with `STATIC_DIR=/app/frontend` serves the page, the assets and `/stream` on port 8787, with the security headers (see "HTTP API"), and `/healthz` on `127.0.0.1:8788` inside the container (`HEALTH_PORT`). The `HEALTHCHECK` (shell form, so it follows `HEALTH_PORT`) uses that listener; nothing outside the container can reach it.
  - A deployment directory holds `compose.yml`, `.env` (from `deploy/.env.example`) and `mix.json`. `.env` feeds both Compose's `${...}` substitution and, through `env_file`, the container. The compose `environment` block fixes `BIND_HOST`, `BIND_PORT`, `STATIC_DIR`, `HEALTH_PORT` and `MIX_FILE`, so `.env` cannot change them.
  - Compose interpolates `$` in unquoted and double-quoted `env_file` values; single-quoted values are literal. `deploy/.env.example` single-quotes every secret, and CI logs in with a password containing `$` to prove it.
  - Published on `127.0.0.1:${RIVER_PORT:-8787}` only; TLS, HSTS, compression and per-IP limits belong to a reverse proxy in front. `extra_hosts` maps `host.docker.internal` to the host for a hub on the host that listens beyond loopback.
  - `deploy/compose.beszel-network.yml` joins the hub's external network (`BESZEL_NETWORK`, default `beszel_default`, the network of a compose project in a directory named `beszel`), so `BESZEL_URL` is `http://<hub service>:8090`.
  - A hub that listens only on the host's loopback (such as one with `network_mode: host`) is unreachable from a bridged container. `deploy/compose.host-network.yml` then puts the river on the host network too: `!reset` removes the port mapping and `extra_hosts`, `BIND_HOST=127.0.0.1`, and both ports become host ports (`RIVER_PORT`, `RIVER_HEALTH_PORT`).
  - `mix.json` is bind-mounted read-only at `/config/mix.json` and required (`create_host_path: false`): the template's recipe is public, so production must not fall back to it. It must be readable by uid 1000.
  - `.gitignore` and `.dockerignore` exclude `.env`, `.env.*` and `mix*.json*` at any depth (including environment-specific files and backups), keeping only the `.env.example` files and `bridge/mix.example.json` as public templates. CI checks both: `git check-ignore` on the deployment paths, and an image built with marker-filled `deploy/.env`, `deploy/mix.json` and `bridge/mix.json` present must contain no such file names and no marker.
  - Read-only root filesystem, PID limit (`pids_limit: 100`), 256 MB memory limit, all capabilities dropped, `no-new-privileges`, log rotation (3 × 10 MB).
  - `deploy/compose.proxy-network.yml` is for a reverse proxy that runs in Docker itself: it joins the proxy's external network (`PROXY_NETWORK`, default `proxy`) next to the default one and removes the port mapping, so the proxy reaches `river:8787`. It does not combine with the host-network override.
  - `deploy/test/container.py` runs the image without a hub (page, asset, snapshot, 404 for `/healthz` on the public port, 503 from the health listener), then from a temporary deployment directory against a real hub from `deploy/test/compose.ci.yml` until Docker reports it healthy: on the hub's network with the proxy-network override, checked through the shipped `Caddyfile` in a Caddy container, and with the host-network override.
- **Publishing** (the `publish` job in `.github/workflows/ci.yml`):
  - Runs after `check` and `deploy` in the same run, only in this repository, for pushes to `main`, `v*` tags and manual runs on `main`. It checks out exactly `github.sha` with full history.
  - A tag must be on `main` (`git merge-base --is-ancestor`), so a tag on an unmerged branch cannot publish `latest`. `vX.Y.Z` publishes `X.Y.Z` and moves `X.Y`, `X` and `latest` only where it is the newest release, so a patch for an older line does not move them back; `vX.Y.Z-<pre-release>` publishes only its own tag; other `v*` tags fail. Release publishes share one concurrency group and check out only once they hold it, so two releases cannot race for `X` or `latest`; GitHub keeps one waiting run per group, so a third tag pushed meanwhile cancels the waiting one, which is then re-run.
  - `edge` from a push to `main` is built only when a file that goes into the image changed since the commit the published `edge` was built from (its `org.opencontainers.image.revision` label, read from the registry), so a failed publish is retried by the next push, whatever it changes. The files: after dropping `bridge/test/**`, `frontend/test/**`, `vitest.config.ts` files and `*.md`, one of `bridge/**`, `frontend/**`, `shared/**`, `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.base.json`, `deploy/Dockerfile` or `.dockerignore`. An allowlist, so a new kind of file cannot trigger builds by accident. Without a published `edge` or with a revision no longer in history (force-push) it builds. `ci.yml` is not on the list, since Dependabot bumps its action pins often; after changing the job, a manual run rebuilds `edge`.
  - Buildx builds `linux/amd64` and `linux/arm64` without QEMU (see "Container"); a `RUN` step in the final stage would need QEMU added. No build cache is shared with other jobs or runs, so a pull request cannot poison a published image; the `check` job's npm cache never reaches the image, which installs from the registry.
  - GitHub artifact attestations (`actions/attest`): SLSA build provenance and an SPDX SBOM (`anchore/sbom-action`), stored in GitHub's attestation store, from which `gh attestation verify oci://ghcr.io/juusolatva/beszel-river:<tag> -R juusolatva/beszel-river` reads them. They are not pushed to the registry: GHCR has no referrers API, so each push left two attestation manifests and a superseded `sha256-<digest>` index as package versions, four per publish. BuildKit's own attestations are off; they show up as `unknown/unknown` platforms.
  - Cleanup (`.github/workflows/ghcr-cleanup.yml`, weekly and by hand on `main` only, so no other branch's script gets the token; dry run by default when run by hand): `.github/scripts/ghcr_cleanup.py` keeps every version with a real tag and the platform manifests its index lists, and deletes everything else older than a day: replaced `edge` builds and the attestations pushed to the registry before (tags matching `sha256-<digest>` do not count). The `deploy` CI job runs its unit tests (`test_ghcr_cleanup.py`). Deleting needs only `packages: write`, since the repository's workflow created the package and so has admin on it. GitHub's generic "delete untagged versions" tools would delete the platform manifests of tagged multi-arch images.
  - `packages: write`, `id-token: write`, `attestations: write` and `artifact-metadata: write` on this job only; the workflow default stays `contents: read`. The package, created by the first push from this public repository's workflow, inherited the repository's public visibility.
  - `compose.yml` uses `image: ghcr.io/juusolatva/beszel-river:${RIVER_VERSION:-1}`, with the `build:` block commented out for building from a checkout. CI's container tests run the image built in the same run in place of the published one.
- **Reverse proxy for the container** (`deploy/nginx/river-container.conf` and `river-container-path.conf`, `deploy/caddy/Caddyfile` and `Caddyfile.path`): each forwards every path to `127.0.0.1:8787`, at a domain root or under `/river/`.
  - The proxy adds only `Strict-Transport-Security`; the container's own security and caching headers pass through. Under a path, a site's own CSP is enforced next to the container's, so it must allow inline styles.
  - Path mode redirects `/river` to `/river/` (relative URLs need the slash) and strips the prefix, so the container sees its own paths.
  - Compression for the page and assets (nginx: `gzip_types text/css text/javascript`, the container's types, plus `text/html`; Caddy: `encode` with a matcher excluding `/stream`). Caddy's default `encode` matches `text/*` and would compress `text/event-stream` too.
  - nginx's `/stream` locations include `river-stream.conf` (below) and get the same per-client limit. Caddy has no per-IP connection limit built in, so behind it only the container's global cap of 500 streams applies; the configs point to `caddy-ratelimit`.
  - Caddy needs no streaming options: it flushes `text/event-stream` at once and cancels the upstream request when the client leaves (a negative `flush_interval` is ignored for event streams).
  - `deploy/test/nginx.py` and `deploy/test/caddy.py` run the shipped files, with only ports and the site address changed, in front of a stub container (`proxy_check.py`): compression, HSTS, redirects, prefix stripping, ten events arriving within 4 s, and the upstream stream closing within 5 s after the client leaves while the stream is quiet. The container's viewer count, which stops realtime polling, depends on that close; nginx with `proxy_ignore_client_abort on` fails it.
- **Bridge under systemd** (`deploy/beszel-river-bridge.service`): when the hub does not run in Docker. Runs `node dist/main.js` in `/opt/beszel-river/bridge` as a `beszel-river` user, with the usual systemd sandboxing options plus an empty capability bounding set, `RestrictSUIDSGID`, `RestrictRealtime`, `RestrictNamespaces`, `ProtectClock`, `ProtectHostname`, `ProtectKernelLogs`, `ProtectProc=invisible`, `ProcSubset=pid`, `RemoveIPC`, `SystemCallArchitectures=native` and `UMask=0077`. Executable memory remains available for Node's JIT. `deploy/test/systemd.py` verifies the unit and smoke-tests Node JIT/HTTP, empty capabilities and file permissions in a transient system service; CI runs it with passwordless sudo.
- **Frontend:** `npm run build -w @beszel-river/frontend`, then copy `frontend/dist/` to the web root. The build uses relative asset URLs (`base: "./"`) and connects to the relative `stream`, so the same files work at a site root or under a path.
- **nginx** (`deploy/nginx/river.conf`, own server block):
  - HTTP → HTTPS redirect; HTTP/2, because HTTP/1.1 browsers open at most 6 connections per host and every open tab holds one stream.
  - `location = /stream` proxied to `127.0.0.1:8787`, with the settings shared by every `/stream` location in `river-stream.conf`:
    - `proxy_pass` naming the URI `/stream`: nginx forwards its normalized path, not the client's raw request-target, so the bridge always sees `/stream` from here.
    - `proxy_buffering off`: send events immediately.
    - `proxy_http_version 1.1` and `proxy_set_header Connection ""`: keep the upstream connection open.
    - `proxy_read_timeout 1h`: do not cut quiet streams.
    - `gzip off`, and `proxy_cache off`.
    - `river-limits.conf` defines the shared connection key: the full IPv4 address or the first eight binary IPv6 bytes (`/64`), including NUL/newline bytes. `limit_conn` allows 8 per key (each HTTP/2 request counts), answered with 429. It prevents one IPv6 `/64` from taking the bridge's 500 slots by rotating addresses; many prefixes can still exhaust the global cap. The include belongs once in the http block, whichever config is used. Changing an existing zone key requires an nginx restart.
  - `/healthz` is not proxied.
  - Caching: `index.html` gets `Cache-Control: no-cache`; `assets/` (content-hashed names) a far-future `max-age`.
  - Headers: `Content-Security-Policy` (`default-src 'self'`, inline styles allowed for `index.html` and the debug panel, no framing), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin` (as the bridge sends), `Strict-Transport-Security` (one year, this host only).
  - `deploy/nginx/river-path.conf` holds the same locations under `/river/` for an existing server block. It sets no headers of its own, so the page gets that block's; its comment lists the ones to add there. `deploy/test/nginx.py` runs nginx in Docker to check actual binary keys and held-request limits for both paths, and for the container configs' two; CI runs it after the syntax checks.

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
- [ ] **M8 – Standalone container.** One image with the bridge and the page, run with `deploy/compose.yml`, behind nginx or Caddy. Built in four PRs (bridge, container, proxies, publishing); its working plan was deleted with the last one.
  - Done when: the GHCR image started from `deploy/compose.yml` shows a flowing river from a real hub at `127.0.0.1:8787`, and also behind Caddy and nginx at a domain root and under `/river/`.
  - First publish (`edge` from b1967b9, after #103): the job succeeded; the image index has amd64 and arm64 with the commit as its revision label, pulls without logging in, has SLSA provenance and SPDX SBOM attestations (attestations API; `gh attestation verify` accepted the provenance as built and signed by `ci.yml` on `main`), and passed `container.py` as pulled.
  - Checked on a VPS: the published `v1.0.0` image, behind nginx on a public domain with a real certificate, ran without problems. That showed port 8095 clashing with another service, so the port moved to 8787 (v1.0.1).
  - Still to check: the published image against a real hub and agent with the hub on the same Docker network, reached by IP and in loopback-only host-network mode, behind Caddy, and under `/river/`.
  - Bridge part done in #97: `STATIC_DIR`, `HEALTH_PORT` and the security headers (unit tests; the built bridge served `frontend/dist` with an unreachable hub: page, asset, 304, `/stream` snapshot, 404 for `/healthz` and `/assets/../index.html` on the main listener, 503 from the health listener).
  - Container part done in #99: `deploy/Dockerfile`, `compose.yml` with the two overrides and `.env.example`, built from a checkout (`deploy/test/container.py` in CI and locally with Beszel v0.21.1: without a hub, and healthy with a `$` password in single quotes, on the hub's Docker network and with the host-network override on moved ports).
  - Proxy part done in #101: `river-stream.conf` shared by all nginx `/stream` locations, nginx and Caddy configs for the container at a root and under `/river/`, and `compose.proxy-network.yml` (`deploy/test/nginx.py` and `caddy.py` against a stub container, in CI and locally with nginx 1.30.6 and Caddy 2.11.7; `container.py` through the shipped `Caddyfile` against Beszel v0.21.1). Not yet checked behind a public domain with a real certificate.
  - Publishing done in #103: the `publish` job and `compose.yml` on the GHCR image. The job's tag and change decisions were checked by running its script on a scratch clone (main pushes with docs-only, test-only and source changes, a zero and an unknown `before`, a manual run; tags `v1.0.0`, `v1.1.0`, then `v1.0.1`, `v1.2.0-rc.1`, `v2.0.0`, then `v1.1.1`, `vfoo` and a tag off `main`). The arm64 image, built with the Dockerfile's cross-platform stages, passed `container.py` locally under QEMU. The job itself first runs when this is merged.
- [ ] **Frontend performance (parts 1 and 2).** Execute the Frontend performance implementation plan: work-aware budget and normalized deposits, followed by independently measured CPU/upload optimizations.
  - Done when: Tasks 0–6 have recorded correctness and browser results, each optimization has a measured keep/reject decision, and available target-device fixed/adaptive comparisons show the resulting cadence and appearance. Missing target-hardware checks remain explicitly open. Tasks 1–3 are implemented with unit tests (Task 3 also with the paired Firefox CPU benchmark); Task 0's baseline ledger, Tasks 4–6 and target-device acceptance remain open.
- [ ] **GPU prototype (conditional).** Evaluate transform feedback only if the trigger in the conditional prototype plan is met.
  - Done when: an isolated prototype has shader-executing correctness tests, explicit spawning/accounting/slot-reuse semantics, target-device comparisons against the optimized CPU version, and a documented keep/reject decision. This does not mark a production GPU migration complete. If the trigger is not met, leave this deferred.
- [ ] **Screenshots.** The README screenshots in `docs/images/` (added on 24 October 2026 in 5d57094) no longer fully show how the river looks now. Replace them with new ones of the current version.
  - Done when: `river1.jpg` to `river4.jpg` show the current page from a real hub, in the format AGENTS.md gives for `docs/images/` (JPEG, 1280 px wide, metadata stripped), and the caption and alt texts under "Screenshots" in `README.md` describe what the new images show.

## Risks

| Risk | Mitigation |
|---|---|
| Beszel changes field names in a minor release. | Field mapping isolated in `bridge/src/beszel/`; note the tested hub version in README; check after hub upgrades. |
| `rt_metrics` is internal and undocumented. | Optional (M6); `systems` remains the default and keeps running underneath. Its own SDK connection, one subscription change at a time, refused topics dropped; hosts fall back to `1m` records 10 s after their last realtime sample. |
| Hub unreachable or bridge login expired while running. | After 30 s every stream is sent not alive, so the river dries up instead of flowing on stale values; `/healthz` returns 503 at once. |
| 1 s polling load on agents. | Subscribe only while viewers are connected. |
| Public `/stream` abuse. | The nginx configs' `limit_conn` per IPv4 address or IPv6 `/64` (Caddy has none built in); the bridge's global cap of 500 streams; payload is tiny; one upstream subscription regardless of viewers. |
| A tampered published image. | Built only by the `publish` job from a commit that passed CI, with signed build provenance and an SBOM (`gh attestation verify`); `compose.yml` can still build from a checkout. |
| Recipe leaks via frontend code. | Mixing happens in the bridge; the frontend only knows channel → visual. |
