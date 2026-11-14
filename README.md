# beszel-river

[![Image](https://img.shields.io/github/v/tag/juusolatva/beszel-river?sort=semver&label=image&logo=docker)](https://github.com/juusolatva/beszel-river/pkgs/container/beszel-river)
[![CI](https://github.com/juusolatva/beszel-river/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/juusolatva/beszel-river/actions/workflows/ci.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=juusolatva_beszel-river&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=juusolatva_beszel-river)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=juusolatva_beszel-river&metric=coverage)](https://sonarcloud.io/summary/new_code?id=juusolatva_beszel-river)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjuusolatva%2Fbeszel-river%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&logo=nodedotjs)](package.json)
[![License: MIT](https://img.shields.io/github/license/juusolatva/beszel-river)](LICENSE)

A web page that turns live metrics from a [Beszel](https://beszel.dev) hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation; it is not meant to be readable.

Status: milestones M0–M7 done; deployed with live data, with an optional 1 s realtime source (`SOURCE=realtime`). M8, the standalone container image, is published as `ghcr.io/juusolatva/beszel-river` (releases since v1.0.0) and awaits its end-to-end check. Tested with Beszel v0.21.1. Design, message format and milestones are in [docs/PLAN.md](docs/PLAN.md).

## Screenshots

Four moments of the live page. Each vertical band is one host; the bands overlap at soft edges and braid as they rise. Load sets how fast and how long the trails are, changes in network and disk traffic make them wiggle sideways, and the hue drifts slowly through the rainbow. Bands with per-core data split into finer strands, where a busy core draws a tight, faster line. Band IDs, order and widths change daily from a secret salt. At UTC midnight the old bands drain and new ones fade in; IDs no longer provide a permanent cross-day link, though continuous observations can still correlate streams.

| | |
|---|---|
| ![River of rainbow-coloured particle trails in four bands flowing upwards on a black background, two dense on the left and two sparser on the right](docs/images/river1.jpg) | ![The same river with brighter, denser bands and longer trails on the right](docs/images/river2.jpg) |
| ![Four distinct, fast-flowing bands with long trails in violet, orange, cyan and gold](docs/images/river3.jpg) | ![Four wide bands braiding together across the canvas in rose, cyan, blue and green](docs/images/river4.jpg) |

## Layout

| Path | Contents |
|---|---|
| `shared/` | Message types shared by bridge and frontend (type-only). |
| `bridge/` | Node service: reads the Beszel hub, mixes metrics into abstract channels, serves them over SSE at `/stream`. |
| `frontend/` | Static WebGL2 page built with Vite; unit tests for everything but the page setup and debug panel. |
| `deploy/` | Container image (`Dockerfile`), compose file, its overrides and `.env.example`; nginx and Caddy configs in front of the container; systemd unit and nginx configs for running without Docker; deployment tests. |
| `docs/PLAN.md` | Plan: design, configuration, message format, milestones. |
| [GLOSSARY.md](GLOSSARY.md) | Domain terms for host activity, streams and the visible river. |
| `docs/images/` | Screenshots used in this README. |
| `.github/` | CI workflows (`ci.yml`, `osv-scanner.yml`, `image-scan.yml`, `ghcr-cleanup.yml`) and Dependabot config for their actions and the pinned Docker images. |
| `sonar-project.properties` | SonarQube Cloud project settings; the CI scan needs the `SONAR_TOKEN` secret. |
| `AGENTS.md` | Conventions and invariants for coding agents (`CLAUDE.md` imports it). |

## Requirements

- Node.js ≥ 24.22.1 (production target: Node 24.22.1 LTS, see `.nvmrc`); CI checks 24.22.1, the latest 24 and 26
- npm ≥ 11.10 (use npm 11 on Node 24 for dependency changes so the lockfile stays consistent); `.npmrc` requires releases to be at least 7 days old when resolving package versions
- To run the container: Docker with Compose 2.24.0 or later, on a 64-bit amd64 or arm64 system (a Raspberry Pi needs a 64-bit OS)

## Development

```sh
npm ci                 # install all workspaces exactly as package-lock.json lists them
npm run dev:frontend   # Vite dev server on http://localhost:5173, proxies /stream to the bridge
npm run dev:bridge     # bridge in watch mode; needs bridge/.env and bridge/mix.json (see Bridge setup)
npm test               # bridge and frontend unit tests (vitest)
npm run coverage       # the same with coverage; HTML and lcov reports in bridge/coverage/ and frontend/coverage/
npm run typecheck      # type-check all workspaces
npm run build          # build bridge (bridge/dist) and frontend (frontend/dist)
```

For real-shader regression checks, start Vite, open the demo page, and run this in its browser console:

```js
const { runRendererBrowserChecks } = await import("/test/renderer.browser.ts");
runRendererBrowserChecks();
```

This requires WebGL2 and `EXT_color_buffer_float`. It checks faint/full-intensity accumulation at 30/60/120/240 Hz, the forced 8-bit fallback, zero dt and fading to black. It runs shader readbacks synchronously; stop other CPU-heavy checks while it runs. Software WebGL checks correctness, not device performance.

For the paired CPU benchmark, open `http://localhost:5173/test/benchmark.html` with Vite running, then run this in that page's console:

```js
const { runCpuBenchmark } = await import("/test/cpu-benchmark.browser.ts");
await runCpuBenchmark();
```

It compares analytic braid centres with the cache using fixed synthetic channel snapshots, seed, particle limit and simulated steps. It reports CPU simulation time and live counts; it does not draw or measure frame cadence, upload or GPU time. Run it separately from rendering/profiling and other heavy work, and record the browser and power conditions when comparing results.

The motion-only GPU prototype has a separate real-shader correctness check. With Vite running, open `http://localhost:5173/test/gpu-benchmark.html` and run:

```js
const { runGpuMotionBrowserChecks } = await import("/test/gpu-particles.browser.ts");
runGpuMotionBrowserChecks();
```

It preloads identical CPU/GPU states with spawning disabled, checks lifetime and boundary deaths, and compares motion after one and 120 steps, including a resized flow grid and a variable-step lifetime regression. The prototype records a Float32-effective step after clamping, feeds it to both backends, and retains the original callback interval separately. Production CPU timing is unchanged. Readbacks belong to this untimed test only. Run browser checks separately from coverage; software WebGL checks correctness, not target-device performance.

Spawning and stream ownership have separate untimed checks:

```js
const { runGpuAllocationBrowserChecks } = await import("/test/gpu-allocation.browser.ts");
runGpuAllocationBrowserChecks();
const { runGpuLifecycleBrowserChecks } = await import("/test/gpu-lifecycle.browser.ts");
const lifecycle = await runGpuLifecycleBrowserChecks();
console.log(lifecycle.parityPassed, lifecycle.failedWindows, lifecycle.transitions);
```

Allocation checks verify exact integer prefixes, birth limits, seed repeatability, strict expiry and fresh same-ID claims after release. The lifecycle check compares plain/filament occupancy and records rotation curves; `parityPassed: false` is a failed acceptance gate even when ownership assertions pass. Task 3 failed per-stream occupancy parity, so this candidate stops before drawing integration. See the [recorded result](docs/superpowers/plans/2026-11-13-gpu-prototype.md#task-3-result--2026-11-13).

To reproduce the separate occupancy investigation, run this on the same test page:

```js
const { runGpuOccupancyInvestigation } = await import("/test/gpu-occupancy.browser.ts");
const investigation = await runGpuOccupancyInvestigation();
console.log(investigation);
copy(JSON.stringify(investigation));
```

Save the copied browser JSON as `/tmp/gpu-occupancy-browser.json`, then generate the summary and check exact reproduction of the historical window means from the repository root:

```sh
python3 frontend/test/summarize_gpu_occupancy.py /tmp/gpu-occupancy-browser.json --output /tmp/gpu-occupancy-summary.json
python3 -m unittest discover -s frontend/test -p '*_test.py'
```

The browser output contains measured metadata and results; the processor adds the derived `summary` and returns a failure status if historical means differ. It rejects missing, extra, duplicate or nonfinite windows. Its default reference is the retained lifecycle JSON; `--reference PATH` selects another reference.

This checks every allocation and compares CPU controls with different random sources and free-slot orders. It uses synchronous readbacks and test-only CPU state access, so it must run separately from performance measurements and coverage. The [investigation](docs/experiments/2026-11-13-gpu-occupancy.md) records sensitivity to random inputs and a plain-spawn discrepancy; its matched-randomness control does not replace or waive the failed acceptance gate.

To check whether the shader's `cos()` precision explains that spawn discrepancy, run this on the same page, on the GPU that recorded it:

```js
const { runGpuSpawnPrecisionCheck } = await import("/test/gpu-spawn.browser.ts");
const spawn = runGpuSpawnPrecisionCheck();
console.log(spawn);
copy(JSON.stringify(spawn));
```

It replays the matched CPU control to the recorded birth (also checked in Node by `test/gpu-spawn.test.ts`), evaluates simulate.vert's `gaussian()` expression and its `log`/`cos`/`sqrt` parts with real shaders for that birth and for 65,536-point sweeps over u and v, and predicts the GPU's spawn x from the readback. `birth.explainsRecordedX: true` means the GPU's own `gaussian()` reproduces the recorded x within 1e-6, far inside the 2.1e-5 gap; on a different GPU it is expected to be false. The recording laptop's result is in `docs/experiments/2026-11-14-gpu-spawn.json` (true). Firefox may mask the renderer name, so record the device separately.

The approved occupancy gate (GPU plan, "Revised occupancy gate") runs 20 seeded runs per group for both scenarios in one session: CPU seeds 1–20, CPU calibration seeds 21–40, the PCG-keyed CPU control and the GPU with seeds 1001–1020. Run it on the target device:

1. From a checkout of `main`: `npm ci`, then `npm run dev:frontend`.
2. Open `http://localhost:5173/test/gpu-benchmark.html` in the browser under test and its developer console. Note the browser version, the device and whether it runs on mains or battery: Firefox may mask the renderer name.
3. Keep the tab in the foreground until the run finishes. Background tabs slow its timers, and other heavy work on the device slows it too. It makes the 120 CPU runs first and checks calibration in the browser; only if that passes does it make the 40 GPU runs, each with a full readback every step. Expect several minutes; the progress lines show where it is.

```js
const { runGpuOccupancyGate } = await import("/test/gpu-occupancy-gate.browser.ts");
const gate = await runGpuOccupancyGate({ onProgress: (done, total, label) => console.log(`${done}/${total} ${label}`) });
copy(JSON.stringify(gate));
```

Save the copied JSON as `/tmp/gpu-occupancy-gate.json` and apply the gate from the repository root:

```sh
npx tsx frontend/test/summarize-gpu-occupancy-gate.ts /tmp/gpu-occupancy-gate.json --output /tmp/gpu-occupancy-gate-summary.json
```

It uses the same statistic as the browser's calibration check (`test/fixtures/occupancy-gate.ts`) and exits successfully only if calibration and the GPU comparison both pass; the summary lists failures, each control's median 90 % detectable difference and the comparisons closest to their bounds. If the browser returned `gpuSkipped: true`, or `summary.calibration.passed` is false, the gate itself needs revising before any GPU run (GPU plan); keep that export too, and do not rerun with other seeds either way. Keep the `--output` file, which contains the browser export unchanged, as `docs/experiments/<date>-gpu-occupancy-gate.json`, and record the device notes from step 2 with the result. `runsPerGroup` below 20 makes a smoke run, which the processor rejects. `test/gpu-occupancy-gate.test.ts` checks in Node that the runner's CPU side reproduces the retained Task 3 and matched-control means exactly.

GPU correctness accepts zero steps or positive Float32-effective steps from 1/256 s through `Math.fround(LOOK.maxDt)`; smaller positive steps explicitly fail the experiment. This bound makes Float32 particle age safe against the conservative release clock, including a larger final callback. The simulation clock also fails at 2³¹ s to bound clock-rounding error. Feed the same effective dt to `gpu.lifecycle.advanceTime(dt)` **before** `streams.update`, then advance the field and call `gpu.step`; construct `StreamSet` with `gpu.lifecycle.canRelease`. The public CPU page has neither restriction.

The isolated GPU experiment starts with a rendered CPU reference. Open `http://localhost:5173/test/gpu-benchmark.html` with Vite running and run:

```js
const { runGpuBenchmark } = await import("/test/gpu-benchmark.browser.ts");
const result = await runGpuBenchmark({
  backend: "cpu", scenario: "dense", limit: 10000,
  refreshHz: 60, conditions: "X280, AC, balanced power, idle desktop, cool start",
});
console.log(result);
```

Record your actual refresh rate and power, thermal and other-load conditions. The default is 30 seconds of warmup and 60 seconds of measurement; repeat three times, **reloading the page before each run** to reset GL resources. Compare `limit: 10000`, `8000` and `1000` with the same 10,000-slot allocation. Scenarios are `dense` (flow 0, density 1), `rotation` (1 → 4 → 32 streams, replacement and removal), `draining` (remove streams after 30 seconds), `drained` (the same removal with 60-second warmup; rejects nonzero measured occupancy), and `empty`. Set the canvas CSS dimensions before the run for the usual full-screen viewport; its default is 960×640. DPR is capped as on the public page. `motion: 0.2` runs reduced motion; motion is fixed for each run.

Results retain a run ID, metadata, timing distributions, upload/draw counters, the complete preallocated effective-input trace and exact total/per-slot occupancy from an untimed CPU replay. Slot identity indices map through `result.validation.ids`. Submission timing includes instrumentation and driver work; it is not GPU execution time. Hidden tabs, context loss, trace overflow, GL errors and final replay mismatches invalidate the run. Save metadata and summaries alongside any retained trace; do not interpret short smoke runs as performance evidence. The GPU backend, five-second cross-backend occupancy checks and full hardware comparisons are pending; `backend: "gpu"` currently fails explicitly. See the [execution plan](docs/superpowers/plans/2026-11-13-gpu-prototype.md).


### Bridge setup

1. In Beszel, create a user for the bridge with the `readonly` role and add it to every system that should appear (or run the hub with `SHARE_ALL_SYSTEMS=true`).
2. `cp bridge/.env.example bridge/.env` and fill in `BESZEL_EMAIL`, `BESZEL_PASSWORD` and `STREAM_SALT` (at least 16 characters; generate one with `openssl rand -hex 32`). Set `BESZEL_URL` if the hub is not at `http://127.0.0.1:8090` as reached from the bridge. It must use `http:` or `https:` without embedded credentials; use the authentication variables instead.
   - If the hub has password auth disabled (OIDC only, `DISABLE_PASSWORD_AUTH=true`), the bridge cannot log in with a password. Leave `BESZEL_EMAIL` and `BESZEL_PASSWORD` empty and set `BESZEL_TOKEN` instead. To make one, open the hub's PocketBase dashboard (`<hub URL>/_/`) as a superuser, then Collections → `users` → the bridge user → the `⋯` menu → **Impersonate**. In the "Generate nonrenewable auth token" dialog, give a duration in seconds, e.g. `31536000` for a year.
   - The bridge cannot renew such a token. It logs a warning from 14 days before expiry; then make a new one and restart the bridge (Deployment, "Maintenance").
   - To revoke it, use **Reset issued tokens** in the same menu.
3. `cp bridge/mix.example.json bridge/mix.json` and tune the weights; `mix.json` is git-ignored and required. A missing, unreadable or invalid recipe stops the bridge before it listens or authenticates to the hub. Omit `filaments` or set it to `null` to disable per-core profiles. Enabling them requires all four fields (`bias`, `center`, `weight`, `tau`); incomplete sections fail startup. `pulseScatter` and `glide` are optional; fields left out take their defaults (see `docs/PLAN.md`, "Bridge configuration"). For local development only, explicitly set `MIX_FILE=mix.example.json` to use the public example without copying it.
   - An enabled filament recipe publishes a transformed per-core CPU profile; mixing, jitter and daily shuffling can still reveal sustained CPU levels. Leave `filaments` omitted or `null` if those levels must remain private. Change the example's public weights before production use.
4. Optionally set `SOURCE=realtime` for 1 s updates instead of 60 s ones. The bridge then asks the hub for each up host's live metrics while at least one page is open, and for 30 s after the last one closes; meanwhile the hub fetches from those agents every second, as it does while someone watches a system's 1-minute chart in Beszel.
5. `npm run dev:bridge`, then watch the frames with `curl -N http://127.0.0.1:8787/stream` (`-N` turns off curl's output buffering so events print as they arrive).

`STATIC_DIR` and `HEALTH_PORT` are for the container image (Deployment, "Container"): the bridge then serves the page itself and moves `/healthz` to its own loopback listener. Leave both unset when nginx serves the page. To try it locally: `npm run build`, then set `STATIC_DIR=../frontend/dist` in `bridge/.env` and open `http://127.0.0.1:8787/`.

Configuration and the mix format are described in [docs/PLAN.md](docs/PLAN.md) under "Bridge".

### Frontend URL parameters

The page reads frames from `stream` next to itself (`/stream` at the site root). In dev, when the bridge is not running, it falls back to generated demo frames.

| Parameter | Effect |
|---|---|
| `?demo` | Generated demo frames instead of the bridge. |
| `?debug` | Panel with fps/particle stats. With demo frames: per-stream channel sliders, alive/hold/filaments toggles and add/remove stream buttons. With the bridge: the latest channel values and filaments, read-only. `d` hides it. |
| `?streams=N` | Number of demo streams (default 4). |
| `?interval=MS` | Demo update interval (default 1000; `60000` mimics the Beszel `systems` source). |
| `?particles=N` | Fixed particle pool size, clamped to 100–10000. Without it the pool is 10000 (8000 with a coarse pointer), halved with reduced motion, and thins out on devices that cannot keep up. |
| `?seed=N` | Fixed random seed, for repeatable looks. |

Visual tunables (speeds, colours, trail length, easing) are in `frontend/src/config.ts` (`LOOK`).

## Deployment

Two ways to run it, both listening only on the host's loopback. Background and the reasons for each setting: [docs/PLAN.md](docs/PLAN.md), "Deployment".

- **Container:** one image, `ghcr.io/juusolatva/beszel-river`, holds the bridge and the page, started with `deploy/compose.yml` at `http://127.0.0.1:8787`.
- **Without Docker:** the bridge under systemd on `127.0.0.1:8787`, with nginx serving the page and proxying `/stream` to it.

Either way, first create the Beszel user as in "Bridge setup" above.

### Container

The image is published on GitHub's container registry for amd64 and arm64. A deployment directory holds `compose.yml`, `.env` and `mix.json`; in a checkout that is `deploy/`, where git and Docker ignore the last two. The checkout also has the proxy configs and the overrides.

```sh
git clone https://github.com/juusolatva/beszel-river.git && cd beszel-river/deploy
cp .env.example .env && chmod 600 .env     # then fill it in (below) before going on
cp ../bridge/mix.example.json mix.json     # then change the weights: the template is public
sudo chown 1000:1000 mix.json && sudo chmod 400 mix.json
docker compose up -d
docker compose ps                          # "(healthy)" once logged in to the hub
```

- `chmod 600 .env`: only you can read the secrets.
- `chown 1000:1000 mix.json`: the container runs as the `node` user (uid 1000), which must read the bind-mounted recipe; otherwise startup stops with an "unreadable recipe" error. `chmod 400`: only that user can read it, and nobody can write it; edit it later with `sudo`, which can.
- `up -d`: pulls the image and starts the container in the background. `ps` lists it with its health.

Once it is healthy, open `http://127.0.0.1:8787`. If it stays `(health: starting)` or turns `(unhealthy)`, `docker compose logs river` says why.

In `.env`, set `BESZEL_EMAIL` and `BESZEL_PASSWORD` (or `BESZEL_TOKEN`), `STREAM_SALT`, and `BESZEL_URL` as the container reaches the hub:

| Hub | `BESZEL_URL` | Also |
|---|---|---|
| On another machine, or a published port | `http://192.168.1.10:8090` (its address) | |
| In Docker on this host | `http://beszel:8090` (the hub's service name) | `COMPOSE_FILE=compose.yml:compose.beszel-network.yml`, and `BESZEL_NETWORK` if the hub's network is not `beszel_default` |
| On this host, listening beyond loopback | `http://host.docker.internal:8090` | The host firewall must allow connections from Docker's bridge network. |
| On this host, listening only on `127.0.0.1` (such as `network_mode: host`) | `http://127.0.0.1:8090` (the hub's port) | `COMPOSE_FILE=compose.yml:compose.host-network.yml` |

- `docker inspect -f '{{json .NetworkSettings.Networks}}' beszel` prints the hub container's networks; `beszel` is its container name.
- `COMPOSE_FILE` in `.env` adds an override file to every `docker compose` command run in this directory. Running them from elsewhere, pass both files instead: `docker compose -f compose.yml -f compose.host-network.yml up -d`. The overrides use `!reset`, which needs Docker Compose 2.24.0 or later (`docker compose version`).
- With `compose.host-network.yml` the container shares the host's network, so its two ports are host ports: `RIVER_PORT` (default 8787) for the page and `RIVER_HEALTH_PORT` (default 8788) for the health check. Change them in `.env` if they are taken. `RIVER_PORT` also moves the page in the other cases, except with `compose.proxy-network.yml`, which publishes no port.

**Quoting:** Compose replaces `$name` and `${name}` in unquoted and double-quoted `.env` values, usually with nothing, so a password, token or salt containing `$` changes silently and the login fails. Keep every secret in single quotes, as `.env.example` does: `STREAM_SALT='CHANGE$ME'`, which Compose would otherwise read as `CHANGE`. A `bridge/.env` from the systemd setup is read without this substitution, so add the quotes when copying values from it.

#### Image versions

`RIVER_VERSION` in `.env` picks the image tag:

| `RIVER_VERSION` | Image |
|---|---|
| `1` (default) | The newest 1.x.y release: fixes and features, never a breaking change. |
| `1.0` | The newest 1.0.x release: fixes only. |
| `1.0.0` | Exactly that release. |
| `edge` | The newest build from `main`, rebuilt when a file that goes into the image changes. For testing. |

`latest` also exists, for `docker run`, but crosses major versions. Moving to a new major version is a deliberate change of `RIVER_VERSION`, after reading the release notes.

Each published image has signed build provenance and an SBOM. To check that an image was built by this repository's CI from its source:

```sh
gh attestation verify oci://ghcr.io/juusolatva/beszel-river:1 -R juusolatva/beszel-river
```

The attestations are in GitHub's attestation store, not in the registry, so `--bundle-from-oci` finds none.

To build the image yourself instead, in `deploy/` of a checkout, comment out the `image:` line in `compose.yml`, uncomment the `build:` block and run `docker compose up -d --build`. With the `image:` line left in, the local build takes the published name, and the next `docker compose pull` replaces it. To update a build like this, see "Updates" under Maintenance.

### Reverse proxy

`compose.yml` publishes the page on `127.0.0.1` only. For a public site, put nginx or Caddy in front, with the configs below, at a domain root or under `/river/`. The proxy handles TLS, `Strict-Transport-Security` and compression of the page and its assets, and passes `/stream` through unbuffered. The container sends the other security headers (Content-Security-Policy and more). Its `/healthz` is on a separate listener inside the container, so the proxy cannot expose it. If `RIVER_PORT` moved the page off 8787, change `8787` in the config to match.

Only the nginx configs limit streams per client: 8 concurrent ones per IPv4 address or IPv6 `/64`, as in "4. nginx" below. Caddy has no such limit built in, so behind it only the container's global cap of 500 streams applies; a plugin such as `caddy-ratelimit` can add one.

**nginx**, own domain or subdomain, with `deploy/nginx/river-container.conf`:

```sh
sudo certbot certonly --nginx -d river.example.com
sudo install -D -m 644 -t /etc/nginx/snippets deploy/nginx/river-limits.conf deploy/nginx/river-stream.conf
sudo cp deploy/nginx/river-container.conf /etc/nginx/conf.d/   # then replace river.example.com in it
sudo nginx -t && sudo systemctl reload nginx
```

- `install -D -m 644 -t <dir>`: copies both snippets into `<dir>`, creating it if needed, readable by all.
- `certbot` and `nginx -t`: as in "4. nginx" below, which also has the fix for nginx older than 1.25.1.

Under a path in an existing site instead: install the two snippets the same way, copy `deploy/nginx/river-container-path.conf` to `/etc/nginx/snippets/`, add `include /etc/nginx/snippets/river-container-path.conf;` inside that site's `server` block, and add `include /etc/nginx/snippets/river-limits.conf;` once to the `http` block (for example as a file in `/etc/nginx/conf.d/`). The page is then at `/river/`. Add HSTS to the site if it serves HTTPS only. If the site sends its own Content-Security-Policy, browsers enforce both, so it must still allow inline styles.

**Caddy**, own domain or subdomain: replace `river.example.com` in `deploy/caddy/Caddyfile`, put it in `/etc/caddy/Caddyfile` (or add its site block to yours), then `sudo systemctl reload caddy`. Caddy gets the certificate itself. Under a path in an existing site instead: copy `deploy/caddy/Caddyfile.path` to `/etc/caddy/` and add `import /etc/caddy/Caddyfile.path` inside that site's block. A site-wide `encode` would also compress `/river/stream` and delay its events; give it a matcher that leaves that path out, as the snippet's own `encode` does.

#### Proxy in Docker

A proxy running in a container cannot reach the host's `127.0.0.1:8787`. Put both on a shared network instead:

1. `docker network create proxy`, and attach the proxy's container to it (in its compose file, a `proxy` network with `external: true`).
2. Add `compose.proxy-network.yml` to `COMPOSE_FILE` in `.env` (for example `COMPOSE_FILE=compose.yml:compose.proxy-network.yml`, or with `compose.beszel-network.yml` as well), set `PROXY_NETWORK` if the network has another name, and run `docker compose up -d`. The river joins that network, and its port is no longer published on the host.
3. In the proxy config, replace `127.0.0.1:8787` with `river:8787`.

This does not combine with `compose.host-network.yml`. nginx looks up `river` when it starts or reloads, so it fails to start while the river is down, and after `docker compose up -d` recreates the river, nginx needs a reload (`docker exec <nginx container> nginx -s reload`) to find its new address. Caddy looks it up on each connection.

### Without Docker

#### 1. Configure

```sh
sudo install -d -o "$USER" /opt/beszel-river
git clone https://github.com/juusolatva/beszel-river.git /opt/beszel-river && cd /opt/beszel-river
cp bridge/.env.example bridge/.env           # set BESZEL_EMAIL and BESZEL_PASSWORD (or BESZEL_TOKEN), STREAM_SALT
cp bridge/mix.example.json bridge/mix.json   # then change the weights: the template is public
```

`install -d -o "$USER"` creates `/opt/beszel-river` owned by you, so the clone and the builds below need no `sudo`. The systemd unit expects the checkout there. Keep `BESZEL_URL=http://127.0.0.1:8090` if the hub runs on the same host.

#### 2. Bridge under systemd

Needs Node 24.22.1 or later on the 24 line; the unit's `WorkingDirectory` is `/opt/beszel-river/bridge`.

```sh
sudo useradd --system --home-dir /opt/beszel-river --shell /usr/sbin/nologin beszel-river
npm ci && npm run build -w @beszel-river/bridge
sudo chown root:beszel-river bridge/.env bridge/mix.json && sudo chmod 640 bridge/.env bridge/mix.json
sudo cp deploy/beszel-river-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now beszel-river-bridge
```

- `useradd --system`: an account without login or home directory creation; `--home-dir` and `--shell` set its home and a shell that refuses logins.
- `npm run build -w @beszel-river/bridge`: builds only the bridge workspace into `bridge/dist`.
- `chmod 640`: the service user can read the secrets, other users cannot.
- `systemctl daemon-reload`: reloads unit files. `enable --now`: starts the service now and at boot.

The unit expects `/usr/bin/node`; edit `ExecStart` if `command -v node` prints another path.

The service drops all capabilities, blocks namespace creation, setuid/setgid changes and realtime scheduling, hides other users' `/proc` entries and kernel logs, protects clock and hostname, removes IPC objects on stop, limits syscalls to the native architecture, and creates files with mode 0600 (directories 0700). It leaves executable memory available for Node's JIT. After updating the unit, copy it again, run `sudo systemctl daemon-reload`, then `sudo systemctl restart beszel-river-bridge`.

#### 3. Frontend

```sh
npm ci && npm run build -w @beszel-river/frontend
sudo rsync -a --delete frontend/dist/ /var/www/beszel-river/
```

- `rsync -a`: copies recursively, keeping permissions and times. `--delete`: removes files from older builds.

The build can also be made elsewhere and copied, if the server has no Node.

#### 4. nginx

Own domain or subdomain, with `deploy/nginx/river.conf`:

```sh
sudo certbot certonly --nginx -d river.example.com
sudo install -D -m 644 -t /etc/nginx/snippets deploy/nginx/river-limits.conf deploy/nginx/river-stream.conf
sudo cp deploy/nginx/river.conf /etc/nginx/conf.d/river.conf   # then replace river.example.com in it
sudo nginx -t && sudo systemctl reload nginx
```

- `install -D -m 644 -t <dir>`: copies both snippets into `<dir>`, creating it if needed, readable by all. `river-limits.conf` sets up the per-client limit; `river-stream.conf` holds the settings every `/stream` location includes.
- `certbot certonly --nginx -d <domain>`: gets a Let's Encrypt certificate through the running nginx without changing its config. The config expects it under `/etc/letsencrypt/live/<domain>/`.
- `nginx -t`: checks the config; `reload` applies it without dropping connections.

nginx older than 1.25.1 (Debian 12, Ubuntu 24.04) does not know `http2 on;`: delete that line and use `listen 443 ssl http2;`.

Under a path in an existing site instead: install the two snippets the same way, copy `deploy/nginx/river-path.conf` to `/etc/nginx/snippets/`, add `include /etc/nginx/snippets/river-path.conf;` inside that site's `server` block, and add `include /etc/nginx/snippets/river-limits.conf;` once to the `http` block (for example as a file in `/etc/nginx/conf.d/`). The page is then at `/river/`. The snippet sets no headers, so the page gets the site's: add the `add_header` lines from `river.conf` to that `server` block if it lacks them, and keep inline styles allowed in its CSP.

Both modes, and the container configs above, allow 8 concurrent stream requests per IPv4 address or IPv6 `/64`, returning 429 above that limit. IPv6 privacy-address rotation within one `/64` shares the same allowance. This does not prevent exhaustion by clients controlling many prefixes. When upgrading an existing configuration, replace the old `limit_conn_zone $binary_remote_addr` line with the limits include and restart nginx once (`sudo systemctl restart nginx`): an existing shared zone cannot change its key during a reload.

Check: `https://river.example.com/?debug` shows `alive` streams with live channel values.

### Maintenance

Git and Docker ignore `.env`, `.env.*` and `mix*.json*` in any directory, including environment-specific copies and backups. Only the `.env.example` files and `bridge/mix.example.json` are public templates; keep private copies under the ignored names.

The bridge restarts by itself (`restart: unless-stopped` in compose, `Restart=on-failure` in the unit) and reconnects after hub restarts. If it loses the hub for more than 30 s, or its login stops being valid, it sends every stream as not alive, so the river dries up rather than flowing on old values, and logs `Beszel connection lost`. The river flows again once the connection is back.

- **Configuration changes:** after editing `.env` (e.g. `SOURCE=realtime`), run `docker compose up -d` in the deployment directory: it recreates the container with the new environment, which `docker compose restart` would not. After editing only `mix.json`, `up -d` sees no change; use `docker compose restart river` instead, since the bridge reads the file at startup. Under systemd, `sudo systemctl restart beszel-river-bridge` covers both.
- **Filament recipe migration:** older recipes without `filaments` now run without per-core profiles. An existing section must explicitly contain `bias`, `center`, `weight` and `tau`; copies of the earlier template need `center: 0` added (as JSON: `"center": 0`), or the section removed/set to `null`. Filaments publish a transformed CPU profile; smoothing and shuffling do not guarantee confidentiality. Leave them disabled when CPU levels must stay private, and change the public template weights before enabling them.
- **Slow stream readers:** the bridge bounds queued output to 256 KiB per response and disconnects clients that remain blocked for 10 s. While blocked it skips heartbeats and intermediate updates; after draining it sends the latest update. A single event exceeding the byte budget also closes that stream. Browsers reconnect normally.
- **Base image updates:** `deploy/Dockerfile` pins the multi-platform `node:24.22.1-alpine3.24` digest in every stage, and the final stage's `alpine:3.24.3` base by digest too; that stage copies only the `node` binary and its two C++ libraries from the Node image. Both must be on the same Alpine minor release, or the build stops with "Node image is on Alpine …". Dependabot proposes monthly Docker updates within the Node 24 line and Alpine 3.24 after a seven-day cooldown, both images in one pull request; moving to a new Alpine release means changing the Node tag's `alpine3.24` suffix and the `alpine` tag together; merging one rebuilds `edge`, and the next release carries it to the version tags. A new Node major is a deliberate change (see `AGENTS.md`, "Node"), so Dependabot does not propose it. Rebuilding the same checkout keeps the pinned base.
- **Image vulnerabilities** (maintainers): CI scans every image it builds with Trivy, and a fixed HIGH or CRITICAL advisory fails the `deploy` job, so nothing is published. Usually a newer base image fixes it: wait for Dependabot's digest update or bump the digests in `deploy/Dockerfile` yourself. If the advisory does not apply (code the service never runs), list its ID in a `.trivyignore` file at the repository root with a comment saying why. The Image scan workflow rescans the published `edge` and `latest` weekly, all severities with a fix, into the repository's code scanning alerts; an alert only on `latest` means the next release fixes it.
- **Updates:** `docker compose pull && docker compose up -d` in the deployment directory pulls the newest image for `RIVER_VERSION` and recreates the container if it changed. `git pull` first if you deploy from a checkout, to get changed compose files. If you build the image yourself ("Image versions"), there is nothing to pull: run `git pull && docker compose up -d --build` instead. Without Docker, rebuild the bridge (step 2's build, then `sudo systemctl restart beszel-river-bridge`) and the frontend (step 3). When a config in `deploy/nginx/` or `deploy/caddy/` changed, copy it again (with your domain and paths) and reload the proxy.
- **nginx configs from before `river-stream.conf`:** the current `river.conf` and `river-path.conf` include `/etc/nginx/snippets/river-stream.conf` instead of listing the stream settings themselves. Install it (`sudo install -m 644 deploy/nginx/river-stream.conf /etc/nginx/snippets/`) before copying the updated config, or `nginx -t` fails. Nothing else changes.
- **Releases** (maintainers): CI publishes the image only from commits that passed every check in the same run. `edge` comes from `main`, rebuilt when a file that goes into the image changed since the commit the published `edge` was built from; a `vX.Y.Z` tag on a commit on `main` publishes `X.Y.Z` and moves `X.Y`, `X` and `latest` unless a newer release already holds them. A tag such as `v1.1.0-rc.1` publishes only its own tag. Releases publish one at a time; push one tag and let its publish job start before the next, since GitHub cancels an older waiting run when a third arrives (re-run it if that happens). To release, tag `main` and push the tag:
  ```sh
  git checkout main && git pull && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # the next version, after the newest in git tag --sort=-v:refname
  ```
  The package inherits the repository's public visibility. If it ever shows as private, change it in the package settings (Danger Zone → Change visibility). A change to the `publish` job itself rebuilds nothing until the next image change; run the CI workflow on `main` by hand (Actions → CI → Run workflow) to rebuild `edge`.
- **From v1.0.0** (port 8095): the container now listens on 8787, the bridge's usual port, because 8095 clashed with other services. After `docker compose pull && docker compose up -d` the page is at `http://127.0.0.1:8787`. A proxy config copied from v1.0.0 still points at 8095: change it to 8787 (or `river:8787` on a shared network), or set `RIVER_PORT=8095` in `deploy/.env` to keep the old host port. Under `compose.host-network.yml` the default `RIVER_PORT` moves the same way.
- **From an image built from a checkout** (before the image was published): `compose.yml` now pulls the published image. Run `docker compose up -d` once; `docker image rm beszel-river-river` then removes the old local build.
- **From the bridge-only container** (`deploy/bridge.Dockerfile`, the `bridge` service on port 8787), which this image replaces:
  - Settings move from `bridge/.env` to `deploy/.env` and the recipe from `bridge/mix.json` to `deploy/mix.json`. Put secrets in single quotes ("Quoting" above) and make `mix.json` readable by uid 1000.
  - The service is now `river`, and the port is still 8787, now serving the page as well as the stream. An nginx with `river.conf` or `river-path.conf` that proxies `/stream` to `127.0.0.1:8787` keeps working unchanged: nginx still serves the page itself, and `/stream` responses carry the security headers from both, which is harmless. To let the container serve the page too, switch to `river-container.conf` or `river-container-path.conf` ("Reverse proxy" above).
  - A hub with `network_mode: host`: use the adapted `compose.host-network.yml` (table above).
  - Before the first `up`, run `docker compose down --remove-orphans` in `deploy/` (with the same `-f` options as before, if any): it removes the old `bridge` container, which would otherwise keep port 8787.
- **Token expiry** (`BESZEL_TOKEN` only): the bridge logs the expiry date every time it starts.
  ```sh
  docker compose logs river | grep 'valid until'                # Docker, in the deployment directory
  sudo journalctl -u beszel-river-bridge | grep 'valid until'   # systemd
  ```
  - `logs river`: the container's output.
  - `journalctl -u <unit>`: that unit's log.
  - `grep 'valid until'`: keeps the line with the date.

  After that date the hub rejects the token: a running bridge logs `Beszel connection lost` and the river dries up, and a restarted one does not start with it (`BESZEL_TOKEN expired on …`). Put a new token (see "Bridge setup") in `.env` and run `docker compose up -d`, which recreates the container with the new value (`docker compose restart` would keep the old one). Without Docker, put it in `bridge/.env` and run `sudo systemctl restart beszel-river-bridge`.
- **Beszel upgrades:** Beszel renames fields between minor releases, and the bridge is tested with v0.21.1. After a hub upgrade, check that `?debug` still shows changing channel values. A hub image that updates itself (`:latest` with Watchtower or similar) can stop the river without notice; pin a version to upgrade on purpose.
- **Certificate:** `sudo certbot renew --dry-run` checks that automatic renewal works. `renew` renews certificates close to expiry; `--dry-run` uses Let's Encrypt's test server and saves nothing. Certificates obtained with `--nginx` make certbot reload nginx after each renewal.

## License

MIT, see [LICENSE](LICENSE).
