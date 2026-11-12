# AGENTS.md

Instructions for coding agents working in this repository. `CLAUDE.md` only imports this file.

## Project

A public web page that turns live metrics from a Beszel hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation but must not be readable from it.

- `docs/PLAN.md` is the source of truth for design, configuration, message format and milestones. Read the relevant section before changing behaviour, and update it in the same change when the behaviour, configuration or file layout changes.
- `README.md` holds setup, deployment and maintenance. Update it when commands, environment variables, URL parameters or deployment files change; new environment variables also go in `bridge/.env.example`, and in `deploy/.env.example` unless `deploy/compose.yml` fixes them.
- Milestone status is the checklist under "Milestones" in `docs/PLAN.md`. Tick a milestone only when its "Done when" condition has been checked, and note how it was checked.

## Layout

| Path | Contents |
|---|---|
| `shared/src/index.ts` | `Frame`, `Stream`, channel and SSE event types. Type-only: `exports` has only a `types` condition, so consumers must use `import type`. |
| `bridge/` | Node service. `src/beszel/` talks to the hub (`systems-source.ts` 60 s, `realtime-source.ts` the 1 s layer), `src/pipeline/` turns samples into channels, `src/server.ts` serves SSE and, with `STATIC_DIR`, the page loaded into memory by `src/static.ts`; `src/health.ts` is `/healthz` and its own listener for `HEALTH_PORT`. Tests in `bridge/test/`. |
| `frontend/` | Vite + raw WebGL2 page. `src/source/` produces frames, `src/sim/` moves particles, `src/render/` draws them, `src/debug/` is the `?debug` panel. Look tunables are `LOOK` in `src/config.ts`. Unit tests, including WebGL2 and EventSource fakes, in `frontend/test/`. |
| `deploy/` | Container image `Dockerfile` (bridge serving the page, published to GHCR by CI), `compose.yml` (runs the published image) with the overrides `compose.beszel-network.yml`, `compose.host-network.yml` and `compose.proxy-network.yml`, and `.env.example`. Proxy configs for the container: `nginx/river-container.conf` (own server block), `nginx/river-container-path.conf` (a path in an existing one), `caddy/Caddyfile` and `caddy/Caddyfile.path`. For running without Docker, the systemd unit and `nginx/river.conf` and `nginx/river-path.conf`. Every nginx `/stream` location includes `nginx/river-stream.conf`; `river-limits.conf` defines its limit zone. `test/` holds the deployment tests and `compose.ci.yml`, which pins the images they run. A deployment directory's `.env` and `mix.json` are ignored at any depth. |
| `.github/` | Workflows (`ci.yml`, `osv-scanner.yml`, `image-scan.yml` (weekly Trivy scan of the published images), `ghcr-cleanup.yml` with its script and unit tests in `scripts/`, run by the CI `deploy` job: `python3 -m unittest discover -s .github/scripts`) and `dependabot.yml` (updates for the pinned actions, the Docker base image and, through its `docker-compose` entry, the images in `deploy/test/compose.ci.yml`). |
| `sonar-project.properties` | SonarQube Cloud settings. The scan reads `bridge/coverage/lcov.info` and `frontend/coverage/lcov.info`; CI prefixes their paths with the workspace. Coverage leaves out both `main.ts` files and `frontend/src/debug/`, the code outside the test scope. |
| `docs/PLAN.md` | Plan. |
| `GLOSSARY.md` | Domain terms for host activity, streams and the visible river. |
| `docs/images/` | README screenshots: JPEG, 1280 px wide, metadata stripped. |

## Commands

Run from the repository root.

```sh
npm ci                 # install exactly what package-lock.json lists
npm run typecheck      # tsc in every workspace
npm test               # bridge and frontend unit tests (vitest run)
npm run coverage       # the same with coverage; reports in bridge/coverage/ and frontend/coverage/ (index.html)
npm run build          # bridge → bridge/dist, frontend → frontend/dist
npm run dev:frontend   # Vite on http://localhost:5173, proxies /stream to 127.0.0.1:8787
npm run dev:bridge     # tsx watch; needs bridge/.env and bridge/mix.json (copy their example files)
```

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, `typecheck`, `coverage` and `build` on Node 24.22.1, 24 and 26, and writes both workspaces' coverage tables to the job summary. On the Node 24 job it also runs a SonarQube Cloud scan (`SONAR_TOKEN` secret; on pushes to `main` and same-repository PRs, skipped for forks and Dependabot, whose PRs get no secrets, and for tags). Its `deploy` job checks that `.env` and `mix.json` files are ignored by git and absent from an image built with them present, scans that image with Trivy (fails on a fixed HIGH or CRITICAL advisory; exceptions with a reason in `.trivyignore`), runs `python3 deploy/test/container.py <image>` (the image without a hub, then healthy against a real Beszel hub on its Docker network, reached through the shipped Caddyfile in a proxy container, and with the host-network override; it writes nothing in the checkout), and checks `deploy/compose.yml`, alone and with each override (`docker compose config`), all four nginx configs (`nginx -t`) and both Caddyfiles (`caddy validate`). It also runs `python3 deploy/test/nginx.py` (binary address grouping and concurrent requests for every `/stream` location, then the container configs) and `python3 deploy/test/caddy.py`, which put the container proxy configs in front of a stub container (`proxy_check.py`: compression, redirects, unbuffered events, the upstream closing when the client leaves), and `python3 deploy/test/systemd.py` (Node JIT/HTTP under the service sandbox; needs passwordless sudo). Its `publish` job, after both, pushes the multi-arch image to `ghcr.io/juusolatva/beszel-river` with provenance and SBOM attestations: `edge` from `main` when a file that goes into the image changed, version tags from a `vX.Y.Z` tag on `main` (`docs/PLAN.md`, "Publishing"). A new file that goes into the image must be added to the job's allowlist. Run `typecheck`, `coverage` and `build` before committing.

## Conventions

- **Node:** production runs Node 24.22.1 (`.nvmrc`); `engines` allows ≥ 24.22.1, the security release current when Node 22 support was dropped (`vite` 8 and `eventsource` 5 need only 22.12.0). Do not use APIs newer than 24.22.1. Raise the floor when a Node release fixes something that matters here, not on every patch. If either version changes, update `package.json`, `.nvmrc`, the CI matrix, `README.md`, the decisions table in `docs/PLAN.md` and the `deploy/Dockerfile` base image together. Dependabot proposes only same-major base-image updates (an `ignore` rule in `.github/dependabot.yml`).
- **Dependencies:** exact versions only (`.npmrc` sets `save-exact=true` and `min-release-age=7`; use npm ≥ 11.10). Add few; the bridge uses `node:http` and the frontend uses no rendering library on purpose. Commit `package-lock.json` changes with the dependency change, and make them with npm 11 (Node 24): npm 10 from Node 22 adds `"peer": true` to the `@esbuild/*` entries. `vitest` and `@vitest/coverage-v8` are devDependencies of both `bridge` and `frontend`; bump them together so the lock keeps one copy.
- **TypeScript:** strict settings from `tsconfig.base.json`, whose `lib` is ES2023 only; `frontend/tsconfig.json` adds the DOM libs, so `window` and `document` do not type-check in the bridge. `noUncheckedIndexedAccess` is off on purpose so typed-array code stays readable. ES modules everywhere; bridge imports use `.js` extensions (NodeNext resolution).
- **Style:** match the surrounding code: short doc comments on exported items, comments that explain why rather than what, no formatter-driven churn. `.editorconfig` sets the whitespace rules.
- **Frontend hot path:** no allocations per particle or per frame in `src/sim/` and `src/render/`; keep state in the preallocated typed arrays.
- **CI:** pin actions to a full commit SHA with the version in a comment (`uses: actions/checkout@<sha> # v7.0.1`); Dependabot updates both. Pass `${{ }}` values to `run` scripts through `env`, not inline. Check workflow changes with `actionlint` (with `shellcheck` on the path) and `zizmor --persona=auditor .github`; both should report nothing above informational.
- **Shaders:** GLSL files in `frontend/src/render/shaders/`, imported with Vite's `?raw` suffix.
- **Frontend URLs:** keep them relative (`base: "./"` in `vite.config.ts`, stream URL `"stream"` in `src/main.ts`), so one build works at a site root and under `/river/`.
- **Content-Security-Policy:** `default-src 'self'` with only inline styles allowed, sent by the bridge when it serves the page (`SECURITY_HEADERS` in `bridge/src/static.ts`, the container) and by `deploy/nginx/river.conf` (without Docker); keep the two identical. The container's proxy configs add only HSTS. The page must not load anything from other origins or use inline scripts. In nginx, keep every `add_header` at server level: one inside a location drops the others there.

## Invariants

These protect the point of the project. Do not break them without a change to `docs/PLAN.md` explaining why.

- Raw metrics, hostnames, system IDs and Beszel field names never leave the bridge. Frames carry only the `Stream` channels, rounded to 3 decimals.
- Beszel record types are declared in `bridge/src/beszel/types.ts`. Only `bridge/src/beszel/`, `pipeline/features.ts` (stats and info → samples) and `pipeline/hosts.ts` (status, thread count) may read Beszel fields; everything after them works on samples and features. Beszel renames fields between minor releases.
- Stream IDs are HMAC-SHA256 of the UTC date and system ID (domain-separated with `:stream`) with `STREAM_SALT`, rotating daily; band order and quantized band widths are seeded daily from the salt and the UTC date; `filaments` are always 6 values resampled from the sorted per-core usage, mixed and jittered through `mix.json` and reordered daily. One band per non-paused host is the design, so their number shows on the page and in `streams.length`; do not add fields that reveal anything more (paused hosts, core counts, exact rates).
- The mixing recipe lives in a git-ignored `mix.json`: `bridge/mix.json`, or the one in a deployment directory such as `deploy/`, bind-mounted into the container. Only `bridge/mix.example.json` is committed; the frontend never learns the recipe. A missing, unreadable or invalid recipe stops startup before listening or authenticating. `MIX_FILE=mix.example.json` is an explicit opt-in for local development or isolated smoke tests only.
- Filaments are disabled when their recipe is omitted or `null`; enabling them requires all four fields (`bias`, `center`, `weight`, `tau`). A transformed per-core profile can still reveal sustained CPU levels; leave it disabled when those must remain private (see `docs/PLAN.md`, "Bridge configuration").
- The public page never mentions Beszel or hostnames in its title or visible text.
- Secrets live in `bridge/.env` or a deployment directory's `.env` such as `deploy/.env` (both git-ignored). Never commit real credentials, salts or `mix.json`.

## Testing

- Add or update vitest tests in `bridge/test/` for every change to `bridge/src/` except `main.ts`, and in `frontend/test/` for every change to `frontend/src/` except `main.ts` and `debug/`. `src/beszel/` is tested against a fake PocketBase, `Renderer` and `gl.ts` against the fake WebGL2 context in `frontend/test/fake-gl.ts`, and `StreamSource` against stubbed `EventSource` and `document`. `bridge/test/privacy.test.ts` checks the rules under Invariants on a served snapshot; extend it when frames gain a field.
- `bridge/vitest.config.ts` and `frontend/vitest.config.ts` set coverage thresholds for those modules (90 % statements, functions and lines, 80 % branches); `npm run coverage` fails below them. The reports also include the entry points and debug panel, which have no thresholds; SonarQube excludes them from coverage. Do not lower a threshold to make a change pass; add tests instead. Under a coding agent, vitest leaves fully covered files out of the terminal table; CI shows them all.
- End-to-end bridge checks need a running Beszel hub and agent (release binaries from GitHub, run outside the repository). Watch frames with `curl -N http://127.0.0.1:8787/stream`. With `SOURCE=realtime`, the bridge logs "Realtime metrics on/off" as viewers come and go.
- Token mode (`BESZEL_TOKEN`): start the hub with `DISABLE_PASSWORD_AUTH=true` and get a token as a superuser with `POST /api/collections/users/impersonate/<user id>` and the body `{"duration": <seconds>}`.
- Deployment files: run the CI `deploy` job's commands; build the image with `docker build -f deploy/Dockerfile -t beszel-river:dev .` first. Images the tests run come from `deploy/test/compose.ci.yml` (read them with `python3 deploy/test/ci_images.py <service>`); add new ones there rather than in a script. `nginx -t` opens the listen sockets, so in a container without IPv6 remove the `listen [::]` lines first, as CI does. The proxy tests run nginx and Caddy with host networking on free loopback ports, so they need a Docker engine whose host network is the machine running the test.
- Vite's dev proxy keeps `/stream` open when the bridge dies, so check lost-connection behaviour behind nginx (the CI configs work locally with `nginx:stable-alpine`) or against the bridge directly.
- The frontend's unit tests run in Node: they check the simulation's rules and the renderer's GL calls, not how the river looks or how fast it draws. Check visual changes in a browser; `?debug` shows a channel panel and fps, and `?seed=N` makes runs repeatable. Headless Chromium renders WebGL2 in software (about 11 fps) with `--enable-unsafe-swiftshader --use-angle=swiftshader --ignore-gpu-blocklist`, so it can check behaviour but not performance. It also keeps every core busy, so do not run it on the machine whose metrics you are measuring; replay recorded frames instead.

## Planned frontend performance work

- Follow `docs/PLAN.md`, "Frontend performance implementation plan", and its progress checkboxes. Work-aware budgeting and frame-rate-normalized deposits are implemented, with target-device acceptance pending. Cached braid centres, inlined interleaved flow sampling and smaller instance uploads remain measured experiments to implement.
- Measure each optimization separately with the same recorded frames, seed, viewport, particle limit and power mode. Preserve the river's appearance, stream draining, daily ID rotation and reduced motion; keep hot paths allocation-free. Do not claim the estimated 22 ms → 15 ms improvement without hardware measurements.
- A WebGL2 transform-feedback GPU prototype is conditional on CPU work remaining the bottleneck after those changes. Follow the prototype gate and tasks in `docs/PLAN.md`; keep the CPU implementation as the reference. Start with CPU stream easing and a CPU-generated flow texture, and explicitly solve spawning, particle accounting and safe stream-slot reuse without per-frame synchronous GPU readback.
- GPU simulation needs browser tests that execute shaders and compare small deterministic readbacks within tolerances; fake-WebGL tests only verify orchestration. Software WebGL is suitable for correctness, not laptop or phone performance claims. A prototype is not authorization to replace the production simulation.

## Git

- Work on a branch and open a pull request against `main`; `main` only receives merges.
- One logical change per commit, with a message that says what changed and why.
