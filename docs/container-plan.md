# Standalone container deployment plan

Nov 2, 2026 · @Juuso Latva

## Goal

The goal is one image, `ghcr.io/juusolatva/beszel-river`, that holds both the bridge and the built frontend. You run it with one `compose.yml`, a `.env` file next to it and a bind-mounted `mix.json`. It works on its own at `http://127.0.0.1:8095` for testing. For public use it sits behind a reverse proxy (nginx or Caddy to start with), which handles TLS, HSTS, compression and per-IP limits.

The non-Docker setup (systemd bridge with nginx serving `frontend/dist`) stays as an alternative. The bridge-only container goes away. The host-network override is kept, adapted to the new image, for hubs that listen only on loopback.

Status: approved; in progress. This is the working plan for the "Standalone container" milestone in [PLAN.md](PLAN.md). Each PR folds its finished part into `docs/PLAN.md`, which stays the source of truth for finished behaviour, and this file is deleted with the last PR.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Serving the frontend | The bridge's Node server also serves `frontend/dist`. There is one process and no web server in the image. | The reverse proxy is the real web server, so a second one inside the container would only add size and a supervisor. |
| Hub auth | Either `BESZEL_TOKEN` or `BESZEL_EMAIL` with `BESZEL_PASSWORD`, set in `.env`. | Works with the current `bridge/src/config.ts` unchanged. |
| Image source | Built locally until publishing exists. After that, the GHCR image is the default and a commented `build:` block remains. | Every PR leaves a working deployment (see "Work order"). |
| Port | `127.0.0.1:8095` on the host and `8095` in the container. The host port can be changed with `RIVER_PORT`. | It is close to Beszel's 8090 and avoids the crowded 8080. |
| Per-IP limits, TLS, HSTS | Handled by the reverse proxy. The container keeps its global cap of 500 streams and sends the content headers. | The container can't see real client IPs unless it trusts forwarded headers. |
| Security headers | Sent by the bridge only when `STATIC_DIR` is set. Without it, nginx sends them as today. | The non-Docker setup keeps exactly one copy of each header. |
| Proxy examples | nginx and Caddy, each for a whole domain and for a `/river/` path. All nginx configs live in `deploy/nginx/` and share one stream snippet. | These are the two you know best. One stream snippet keeps the old and new nginx configs from drifting. Traefik and others can come later. |
| Old Docker files | `deploy/bridge.Dockerfile` and the bridge-only `compose.yml` are replaced. `compose.host-network.yml` is kept and adapted. The systemd unit and the current nginx configs stay. | Hubs that listen only on loopback keep working without widening their listen address. |
| Hub over HTTPS with a private CA | Out of scope for now. | The usual setup reaches the hub over a private address or a Docker network. |
| `SOURCE` | Defaults to `systems` and can be overridden in `.env`. It reaches the container through `env_file`, so `compose.yml` does not list it. | Same as now. |
| Versions | Semver git tags starting at `v1.0.0`, plus an `edge` tag from `main` when image files change. `compose.yml` defaults to the major tag (`1`), not `latest`. | Agreed in the thread. The major tag lets `docker compose pull` bring fixes and features but never a breaking release. |
| Images used only by CI | The Beszel hub, Caddy and nginx images used in CI are pinned by digest in `deploy/test/compose.ci.yml`, which Dependabot updates. | Digests written inside `run:` scripts would never be updated. |
| Multi-arch builds | `npm ci` and the builds run on the build machine's platform. Only the final stage, which has no `RUN` step, is per architecture. | The output is plain JS and the bridge has no native modules, so nothing needs emulation. |

## Architecture

One container runs `node dist/main.js` as the unprivileged `node` user (uid 1000), with two listeners.

- **Public listener**, on `0.0.0.0:8095` inside the container and published to the host as `127.0.0.1:8095`. It answers only these requests:
  - `GET` or `HEAD` for `/` and `/index.html` returns the page.
  - `GET` or `HEAD` for any other file at the top level of the build (none today; a favicon later) or under `/assets/` returns that file.
  - `GET /stream` returns the SSE stream, unchanged.
  - Any other path gets 404. Any other method gets 405, with `Allow: GET, HEAD` for files and `Allow: GET` for `/stream`.
- **Health listener**, on `127.0.0.1:8788` inside the container (`HEALTH_PORT`), answering `GET /healthz`.
  - It binds to the container's own loopback, so it can't be published or reached from the host, the proxy or the internet. Only the image's `HEALTHCHECK`, which runs inside the container, uses it.
  - The meaning of `/healthz` is unchanged: 200 while the hub subscription is live, 503 otherwise.
  - The separate listener means proxy configs don't need to block `/healthz`, which would otherwise be exposed now that the proxy forwards `/` and not just `/stream`.
  - In host-network mode this loopback is the host's. It is still not public, but local users on the host can query it. That reveals only whether the hub connection is up. If 8788 is taken on the host, `RIVER_HEALTH_PORT` moves it (see "Reaching the hub").

In the recommended deployment, traffic flows like this:

1. The browser connects over HTTPS to the proxy.
2. The proxy handles TLS, HSTS, gzip or zstd for the page and assets, and a per-IP connection limit on `/stream` where it supports one.
3. The proxy forwards to `http://127.0.0.1:8095`.
4. The container reads from the hub at `BESZEL_URL`.

The frontend already uses relative URLs (`base: "./"` and the stream URL `"stream"`), so the same image works at a domain root and under `/river/` without a rebuild. In path mode, the proxy strips the prefix and redirects `/river` to `/river/`, because relative URLs break without the trailing slash.

## Bridge changes

### Static file serving (`bridge/src/server.ts` and a new `bridge/src/static.ts`)

- A new optional setting, `STATIC_DIR`. When it is unset, the bridge serves only `/stream` and `/healthz` as it does today, with today's headers, so the systemd and nginx setup is unaffected.
- **Loading at startup:** `static.ts` exports a loader that reads the build into memory, keyed by request path. The build is a few files, well under 1 MB.
  - It loads every entry at the top level of `STATIC_DIR` and every entry directly inside `STATIC_DIR/assets/`.
  - `assets` is the only subdirectory allowed. Any other subdirectory, a subdirectory inside `assets/`, a symlink or any other non-regular file stops startup with an error naming the entry. Entries are checked with `lstat`.
  - The resolved `STATIC_DIR` itself must be a real directory.
  - A missing `index.html` stops startup, the same way a missing `mix.json` does.
  - Failing on unexpected entries instead of skipping them means a new kind of build output (a favicon, a source map, a font directory) is a deliberate change, never a silent 404 or an accidental publish.
- **Request matching:** requests are matched against that in-memory map with the raw-path rule the server already uses for `/stream`. Request paths are never turned into filesystem paths, and nothing is read from disk after startup.
  - The guarantee is that no request can make the bridge read a file. Which files exist is decided once, at startup, and only regular files in those two places qualify.
  - `/` maps to `index.html`. Query strings are ignored, so `?debug` and `?seed=N` work.
- **Content types:** `Content-Type` comes from a small fixed table: `.html`, `.js`, `.css`, `.svg`, `.png`, `.ico`, `.woff2` and `.txt`, with `charset=utf-8` on the text types. An unknown extension stops startup instead of being served with a guessed type. The table grows when the build does.
- **Caching** matches the current nginx config:
  - Files in `assets/` are sent with `Cache-Control: public, max-age=31536000, immutable`, because Vite puts a content hash in their names.
  - Top-level files, `index.html` included, are sent with `Cache-Control: no-cache`, because their names have no hash.
  - An `ETag`, hashed at startup, lets revalidation answer 304.
- **`HEAD`** is answered for static files. `/stream` stays `GET` only.
- **No compression:** the proxy compresses. Standalone testing on loopback doesn't need it.

### Security headers sent by the container

When `STATIC_DIR` is set, these headers go on every response from the public listener (files, `/stream`, 404 and 405), so the page is protected whatever proxy sits in front:

- `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, the same policy as `deploy/nginx/river.conf`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`

When `STATIC_DIR` is unset, the bridge sends what it sends today (`nosniff` on `/stream` and `/healthz`). The existing nginx configs add the headers at server level and hide the bridge's `nosniff`, so each header still appears once.

The container does not send `Strict-Transport-Security`, because only the proxy knows whether the site is HTTPS only. The proxy configs add it.

### Health listener (new `bridge/src/health.ts`, `bridge/src/main.ts`, `bridge/src/config.ts`)

- A new setting, `HEALTH_PORT` (1–65535, different from `BIND_PORT`).
  - When it is unset, `/healthz` stays on the main listener as it is today, for systemd.
  - When it is set, `/healthz` is served only on `127.0.0.1:HEALTH_PORT`, and the main listener answers 404 for it. The host is fixed: there is no setting to bind it elsewhere.
- **Refactor:** `/healthz` is currently handled inside `StreamServer.handle`. Its response moves to a small `health.ts` that both servers use: `StreamServer` when `HEALTH_PORT` is unset, and a minimal `HealthServer` on its own listener when it is set. `HealthServer` answers `GET /healthz` and 404 or 405 for everything else. Shutdown closes both listeners.
- The health logic itself (`live && client.connected`) is not changed.
- The image's `HEALTHCHECK` uses the shell form, so it follows the setting at run time: `wget -q -O /dev/null "http://127.0.0.1:${HEALTH_PORT}/healthz" || exit 1`. `--start-interval=2s` checks often during the 30 s start period, so the container turns healthy within seconds of logging in.

### Unchanged

These stay as they are:

- the data pipeline
- hub auth
- `SOURCE` and `STREAM_SALT`
- the `mix.json` rules and the privacy invariants

Secrets are still deleted from `process.env` after loading.

## Image (`deploy/Dockerfile`)

This file replaces `deploy/bridge.Dockerfile`. It has three stages:

1. **Build stage**, `FROM --platform=$BUILDPLATFORM node:24.22.1-alpine` with the same pinned digest: `npm ci` for the bridge and frontend workspaces, then `npm run build` for both.
2. **Dependencies stage**, also on `$BUILDPLATFORM`: `npm ci -w @beszel-river/bridge --omit=dev --ignore-scripts`, as now. A following `RUN` fails the build if `node_modules` contains a native addon (`*.node` or `binding.gyp`). A dependency like that would need a per-architecture install, and this check makes the change visible instead of shipping an amd64 binary in the arm64 image.
3. **Final stage**, on the same Node base for the target platform. It has no `RUN` step, so building it for arm64 needs no emulation. It contains:
   - `bridge/dist` and the production `node_modules`
   - `frontend/dist`, copied to `/app/frontend`
   - `bridge/mix.example.json`, kept only for the explicit `MIX_FILE=mix.example.json` smoke test (the working directory stays `/app/bridge`, so the relative name resolves there)
   - defaults for plain `docker run`: `ENV NODE_ENV=production BIND_HOST=0.0.0.0 BIND_PORT=8095 STATIC_DIR=/app/frontend HEALTH_PORT=8788 MIX_FILE=/config/mix.json`
   - `USER node`, `EXPOSE 8095` and the new `HEALTHCHECK`
   - OCI labels (`org.opencontainers.image.source`, `.licenses=MIT`, `.version`, `.revision`), so GHCR links the package to the repository

The files are copied as root-owned and are read-only to `node`. The image `ENV` values are only defaults, because `env_file` and `docker run -e` can override them. Compose enforces the required values in its `environment` block (see below).

## Keeping secrets out of git and the build context

- The deployment directory in a checkout is `deploy/`, so `deploy/.env` and `deploy/mix.json` will exist there. `.env` is already ignored at any depth by `.gitignore` and `.dockerignore`. The `mix.json` patterns currently cover only `bridge/`.
- In both `.gitignore` and `.dockerignore`, the pattern `bridge/mix*.json*` becomes `**/mix*.json*`, with the exception `!bridge/mix.example.json`. This covers `deploy/mix.json`, backups such as `deploy/mix.json.bak` and `deploy/mix.json~`, and any other deployment directory inside the checkout.
- `.dockerignore` stops excluding `frontend/src` and `frontend/index.html`, which the frontend build now needs. Its header comment changes to match.
- A new CI step fails if any of these is not ignored, using `git check-ignore -q` on each:
  - `deploy/mix.json`, `deploy/mix.json.bak`, `deploy/.env` and `bridge/mix.json`
- The same step writes a dummy `deploy/mix.json`, `deploy/.env` and `bridge/mix.json`, each containing a random marker string, and builds the image with them present. It then checks the image two ways:
  - by name: `find / -xdev \( \( -name 'mix*.json*' ! -name mix.example.json \) -o \( -name '.env*' ! -name .env.example \) \) -print` must print nothing. `-xdev` keeps it out of `/proc` and `/sys`.
  - by content: `grep -rqsF "$MARKER" /app` must find nothing, which also catches a secret copied under another name.

## Compose setup (`deploy/compose.yml`)

A deployment directory contains three files:

- `compose.yml`
- `.env`, made from `deploy/.env.example`
- `mix.json`, made from `bridge/mix.example.json` and then edited

Compose reads `.env` both for `${...}` substitution in `compose.yml` and, through `env_file`, for the container's environment. Values in `environment` take precedence over `env_file`, so the container settings listed there can't be changed by accident from `.env`.

**Quoting in `.env`:** Compose interpolates unquoted and double-quoted values in `env_file`, so `$name` or `${name}` inside a password, token or salt is replaced, usually by nothing. Only single-quoted values are taken literally. Node's `process.loadEnvFile`, used by the systemd setup, never interpolates, so a `bridge/.env` that works today can break when copied. `deploy/.env.example` single-quotes every secret value and explains why, and the README repeats it.

This is the target file after publishing exists. Before that, see "Work order".

```yaml
name: beszel-river

services:
  river:
    # A major version (1), a minor (1.0) or an exact release (1.0.0); edge follows main.
    image: ghcr.io/juusolatva/beszel-river:${RIVER_VERSION:-1}
    # Build from a checkout instead (run from deploy/):
    # build:
    #   context: ..
    #   dockerfile: deploy/Dockerfile
    restart: unless-stopped
    env_file: .env
    environment:
      # Fixed container settings; listed here so .env cannot override them.
      BIND_HOST: 0.0.0.0
      BIND_PORT: "8095"
      STATIC_DIR: /app/frontend
      HEALTH_PORT: "8788"
      MIX_FILE: /config/mix.json
    volumes:
      - type: bind
        source: ./mix.json
        target: /config/mix.json
        read_only: true
        bind:
          create_host_path: false
    ports:
      # Loopback only: put a reverse proxy in front for anything public.
      - "127.0.0.1:${RIVER_PORT:-8095}:8095"
      # LAN testing only, plain HTTP: replace the line above with
      # - "${RIVER_PORT:-8095}:8095"
    extra_hosts:
      # Lets BESZEL_URL=http://host.docker.internal:8090 reach a hub on this host.
      - "host.docker.internal:host-gateway"
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 100
    mem_limit: 256m
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
```

### Reaching the hub

There are four cases. Each is chosen in `.env`, with an override file where needed:

1. **Hub reachable by IP or hostname**, on another machine or through a published port: set `BESZEL_URL=http://192.168.1.10:8090`. The default network is enough.
2. **Hub in Docker on the same Docker network:** add the override `deploy/compose.beszel-network.yml`, which joins the hub's external network (`BESZEL_NETWORK`, default `beszel_default`), and set `BESZEL_URL=http://beszel:8090`.
3. **Hub on the host network or installed natively, listening beyond loopback:** set `BESZEL_URL=http://host.docker.internal:8090`. This needs a host firewall that allows the Docker bridge.
4. **Hub listening only on loopback** (for example `127.0.0.1:8090` with host networking): use `deploy/compose.host-network.yml`, adapted from the current file.
   - The override sets `network_mode: host`, with `!reset` removing the networks, the port mapping and `extra_hosts`. `host.docker.internal` has no use when the container already shares the host's network, and some Docker versions reject host mappings in host-network mode.
   - It sets `BIND_HOST=127.0.0.1` and uses `BESZEL_URL=http://127.0.0.1:8090`.
   - It sets `BIND_PORT: ${RIVER_PORT:-8095}` and `HEALTH_PORT: ${RIVER_HEALTH_PORT:-8788}`, because both ports are now on the host and may clash with something already there.
   - The page is still on `127.0.0.1:8095` (or `RIVER_PORT`) because of host networking.
   - The hub's listen address doesn't need to change. This is the existing behaviour, kept for compatibility.

For cases 2 and 4, either run `docker compose -f compose.yml -f <override> up -d`, or set `COMPOSE_FILE=compose.yml:<override>` in `.env` so that a plain `docker compose up -d` works.

### `deploy/.env.example`

This file has the same hub, auth, `SOURCE` and `STREAM_SALT` variables as `bridge/.env.example`, with comments for the four hub cases and the quoting rule above. It adds `RIVER_PORT`, `RIVER_HEALTH_PORT` (host-network only), `RIVER_VERSION`, `BESZEL_NETWORK` and `COMPOSE_FILE`. It leaves out the settings that Compose enforces. These Compose-only variables also reach the container through `env_file`; the bridge ignores them and none is secret. `bridge/.env.example` stays for development and systemd.

The README will tell you to:

- run `chmod 600 .env`
- make `mix.json` readable by uid 1000 with `chown 1000:1000 mix.json && chmod 400 mix.json`. Otherwise the container's `node` user can't read the bind mount, and startup stops with the existing "unreadable recipe" error.

## Reverse proxy configs

### nginx (`deploy/nginx/`)

The new configs sit next to the existing ones, and all four share the stream settings:

- **`river-stream.conf`** (new snippet) holds the directives every `/stream` location needs: `limit_conn river_stream 8`, `limit_conn_status 429`, HTTP/1.1 to the upstream with an empty `Connection` header, `proxy_buffering off`, `proxy_cache off`, `proxy_read_timeout 1h` and `gzip off`. It leaves out `proxy_pass` (the port differs) and `proxy_hide_header` (only the old configs need it).
- **`river.conf` and `river-path.conf`** (existing, non-Docker) replace their copies of those lines with `include /etc/nginx/snippets/river-stream.conf;`. Nothing else changes. The README's upgrade notes say to install the new snippet before reloading.
- **`river-container.conf`** is a full server block for the container:
  - It redirects HTTP to HTTPS and enables HTTP/2.
  - It adds `add_header Strict-Transport-Security` at server level only. The other headers come from the container, so they are not duplicated.
  - `location /` uses `proxy_pass http://127.0.0.1:8095/;`. With a URI there, nginx forwards its normalized path. It also turns on `gzip` with `gzip_types` for JS and CSS.
  - `location = /stream` uses `proxy_pass http://127.0.0.1:8095/stream;` and includes `river-stream.conf`.
- **`river-container-path.conf`** holds locations to include in an existing server block:
  - `location = /river { return 301 /river/; }`
  - `location /river/ { proxy_pass http://127.0.0.1:8095/; }`
  - `location = /river/stream`, with `proxy_pass http://127.0.0.1:8095/stream;` and the stream snippet
  - a comment saying that if the existing site already sends a CSP, browsers enforce both policies, so a stricter site policy must still allow inline styles. Other duplicated headers, such as `nosniff`, are harmless.

### Caddy (`deploy/caddy/`)

- **`Caddyfile`** is for a whole domain:
  - `river.example.com { ... }` with automatic HTTPS
  - `header Strict-Transport-Security "max-age=31536000"`
  - `encode` for every path except `/stream`
  - a plain `reverse_proxy 127.0.0.1:8095` with no `flush_interval`. Caddy already flushes `text/event-stream` responses immediately, and negative `flush_interval` values also change how backend requests are cancelled. The setting is added only if a test shows it is needed.
- **`Caddyfile.path`** is a snippet for an existing site: `redir /river /river/ 308` and `handle_path /river/* { reverse_proxy 127.0.0.1:8095 }`.

Caddy has no built-in per-IP connection limit. The Caddy configs therefore rely on the container's global cap of 500 streams, and their comments point to the `caddy-ratelimit` plugin. The README will say plainly that only the nginx configs include per-IP limits.

### Proxy in Docker

When the proxy itself runs in Docker on another network, it can't reach `127.0.0.1:8095`. A short README section will show joining both containers to a shared external network (`proxy`) and pointing the proxy at `river:8095`. The `ports:` line can then be removed.

## CI and image publishing

### `ci.yml` `deploy` job (updated)

- **Secrets check:** the `git check-ignore` and image-content checks from "Keeping secrets out of git and the build context".
- **Container tests** in `deploy/test/container.py`, which takes the image built by the secrets check and runs each Compose case from a temporary deployment directory (copies of the shipped Compose files plus an override swapping `build:` for that image), so it writes nothing in the checkout and runs the same locally.
- **Smoke test without a hub:** run the image with `MIX_FILE=mix.example.json`, dummy credentials and an unreachable `BESZEL_URL`. Then check that:
  - `GET /` returns `index.html` with the CSP header
  - one file under `/assets/` is served with `immutable`
  - `GET /stream` returns a snapshot
  - `GET /healthz` on the published port returns 404
  - `docker exec <container> wget -S -O - http://127.0.0.1:8788/healthz` returns **503**, because there is no hub, so the meaning of "healthy" is unchanged
- **Healthy-state test with a real hub:**
  - Start the official Beszel hub image, pinned by digest in `deploy/test/compose.ci.yml` (see "CI images"), on a Docker network.
  - Create a superuser with the hub's CLI, and a read-only user through its API.
  - Start the river with `compose.yml` plus `compose.beszel-network.yml`, using a `.env` that points at the hub. The password in that `.env` contains `$`, single-quoted, so the test also proves the quoting advice.
  - Wait until `docker inspect` reports the container `healthy` and `/stream` sends a snapshot.
  - This needs no agent or systems, because health depends only on a live login and subscription. It also tests the network override and the compose `environment` block.
- **Host-network override:** a second run of the same check uses the hub with `network_mode: host` listening on `127.0.0.1:8090`, plus `compose.host-network.yml`. It confirms the loopback-only case still works.
- **Config checks:** `docker compose config --quiet` for `compose.yml` alone and with each override, `nginx -t` for all four nginx configs, and `caddy validate` for both Caddyfiles using the official `caddy` image. The nginx and Caddy images come from `deploy/test/compose.ci.yml`.
- **Proxy behaviour tests:**
  - `deploy/test/nginx.py` gains the container configs. The address grouping and connection limits apply to their `/stream` locations too, through the shared snippet.
  - A new `deploy/test/caddy.py` puts Caddy in front of a stub SSE upstream written in the script, for both Caddyfiles. It checks that:
    - events arrive without buffering
    - `/river` redirects
    - closing the client connection closes the upstream connection within a few seconds. Realtime polling depends on the viewer count dropping.
  - `nginx.py` gets the same disconnect check for the container configs.

### CI images (`deploy/test/compose.ci.yml`)

- **What it holds:** one service per third-party image the CI jobs run, each pinned by digest after its tag: the Beszel hub, `caddy` and `nginx:stable-alpine`. Only the hub is started from it (on a random loopback port); the others are in a profile that is never enabled.
- **How CI uses it:**
  - The healthy-hub tests start the hub through this file.
  - The config checks and the Python tests read each image reference from it through `deploy/test/ci_images.py` (`docker compose config --format json`), so no digest is written twice.
- **Updates:** `.github/dependabot.yml` gains a `docker-compose` entry for `/deploy/test`, with the same monthly schedule and 7-day cooldown as the existing `docker` entry. A hub bump then also runs the healthy-hub test against the new hub release before it is merged, which is an early warning when Beszel changes its API.

### Publishing (a `publish` job in `ci.yml`)

Publishing is a job in `ci.yml`, not a separate workflow, so that images are only built from a commit that has passed every check in the same run.

- **Triggers:** `ci.yml` also runs on `v*` tag pushes. `workflow_dispatch` is added for a manual rebuild of `main`.
- **Gating:** `needs: [check, deploy]`, and the job runs only for pushes to `main`, `v*` tags, or a manual run on `main`. If any check fails on that commit, nothing is published. It checks out exactly `github.sha` with `fetch-depth: 0`, which both the tag guard and the change check below need.
- **Tag guard:** for a tag, the job first confirms that the tagged commit is on `main` (`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`). This stops a tag on an unmerged branch from publishing `latest`.
- **When `edge` is built:** on `main`, a short shell step lists the files changed in `github.event.before..github.sha` (`git diff --name-only`) and builds only if one of them goes into the image.
  - Excluded paths are dropped first: `bridge/test/**`, `frontend/test/**`, `**/vitest.config.ts` and `**/*.md`.
  - The rest are matched against an allowlist: `bridge/**`, `frontend/**`, `shared/**`, `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.base.json`, `deploy/Dockerfile` and `.dockerignore`.
  - If `before` is all zeros or missing, or the diff fails for any other reason (a force-push, for example), the step builds. A spare build is cheap; a missed one leaves `edge` stale.
  - `.github/workflows/ci.yml` is not on the allowlist. Dependabot bumps its action pins often, and most of its changes don't affect the image. A change to the `publish` job itself is followed by a manual run.
  - Tags and manual runs always build. Dependabot base-image bumps change `deploy/Dockerfile`, so they rebuild `edge`.
  - An allowlist is used instead of an ignore list so that a new kind of non-image file can't trigger builds by accident.
- **Build:** multi-arch (`linux/amd64`, `linux/arm64`) with Buildx, pushed to `ghcr.io/juusolatva/beszel-river`. QEMU is not set up, because the final stage has no `RUN` step (see "Image"). If one is ever added, QEMU has to be added with it.
  - A `vX.Y.Z` tag publishes `X.Y.Z`, `X.Y`, `X` and `latest`. `compose.yml` uses `X` by default; `latest` is there for `docker run` users and crosses major versions.
  - `main` publishes `edge`.
  - No build cache is shared with other jobs or runs, so a pull-request run can't poison what gets published. zizmor flags caches in publishing jobs for this reason.
- **Attestations:** build provenance and an SBOM attestation, so `gh attestation verify` works.
- **Permissions:** `packages: write`, `id-token: write` and `attestations: write` on this job only. The workflow default stays `contents: read`.
- **Conventions:** actions are pinned by SHA, `${{ }}` values are passed through `env`, and the workflow is checked with `actionlint` and `zizmor`, as `AGENTS.md` requires.
- **GHCR visibility:** new GHCR packages start private, so the package has to be made public once after the first push. The README will say so.

## Docs and repository housekeeping

- **This plan** lives in `docs/container-plan.md` (moved there in the first PR), and the new milestone in `docs/PLAN.md` links to it. Each PR folds its finished part into `docs/PLAN.md`, and the file is deleted with the last PR, so there is never a second source of truth for finished behaviour.
- **README, "Deployment"**, rewritten in three parts:
  1. **Container quick start:** get three files, fill in `.env` (with the quoting rule) and `mix.json`, run `docker compose up -d` and open `http://127.0.0.1:8095`.
  2. **Reverse proxy:** nginx or Caddy, at a domain root or a path.
  3. **Without Docker:** the current systemd and nginx steps, plus installing `river-stream.conf`.
- **README, maintenance:** updating (`docker compose pull && docker compose up -d`), renewing a token (edit `.env`, then `docker compose up -d`), checking health and logs, and migration notes:
  - for bridge-only container users: the new port 8095, the service name `river` instead of `bridge`, where `.env` and `mix.json` now live, quoting secrets in `.env`, and that host-network users switch to the adapted override
  - for non-Docker nginx users: install `river-stream.conf` before reloading the updated configs
- **`docs/PLAN.md`:** update these sections:
  - Deployment
  - HTTP API: static routes, `HEAD`, the security headers, the health listener
  - Bridge configuration: `STATIC_DIR`, `HEALTH_PORT`
  - Repository layout
  - the decisions table

  Add a new milestone, "Standalone container". It is done when the GHCR image started from `deploy/compose.yml` shows a flowing river from a real hub at `127.0.0.1:8095`, and also behind Caddy and nginx at a domain root and under `/river/`.
- **`AGENTS.md`:** the `deploy/` row in the layout table, the CI description, the new ignore patterns and the `docker-compose` Dependabot entry in the `.github/` row.
- **README, version pinning:** `RIVER_VERSION` takes `1`, `1.0`, `1.0.0` or `edge`. Upgrading to a new major version is a deliberate change of that value, made after reading the release notes.
- **Removed:** `deploy/bridge.Dockerfile`.

## Testing

- **`bridge/test/static.test.ts`** covers:
  - index, top-level and asset responses: content types, cache headers, ETag and 304, `HEAD`, query strings
  - 404 for `/..%2f`, `//`, `/assets/../index.html`, `/assets/`, unknown files and directory paths
  - the security headers on every public response, including 404, 405 and `/stream`, and their absence when `STATIC_DIR` is unset
  - 405 with the right `Allow` header for `POST /` and `HEAD /stream`
  - startup failures for a missing `index.html`, an unknown extension, a symlink (at the top level and in `assets/`), a subdirectory other than `assets`, and a subdirectory inside `assets/`
- **`bridge/test/health.test.ts`** covers the health listener: the existing 200/503 meaning, 404 for other paths and 405 for other methods.
- **`bridge/test/server.test.ts`** covers `/healthz` returning 404 on the main listener when `HEALTH_PORT` is set, and keeping today's behaviour when it isn't.
- **`bridge/test/config.test.ts`** covers the two new settings, including `HEALTH_PORT` equal to `BIND_PORT` and out-of-range values.
- **`bridge/test/privacy.test.ts`**: frames don't change. One assertion is added: static responses never contain the salt or the hub URL.
- Coverage thresholds stay as they are.
- Before the milestone is ticked, an end-to-end check runs against a real hub and agent, with the hub on the same Docker network, reached by IP, and in loopback-only host-network mode, each behind Caddy and nginx locally. The arm64 image is started at least once (on an arm64 machine or under local QEMU), since CI never runs it.

## Work order

Each PR leaves a working, tested deployment:

1. **Bridge** (done, #97): moving this plan to `docs/container-plan.md`, then static serving, security headers and the health listener, with tests and the PLAN HTTP API update. The systemd setup is unaffected because both settings default to off.
2. **Container** (next):
   - `deploy/Dockerfile`, the new `compose.yml` with an active `build:` block and the `image:` line commented out
   - `compose.beszel-network.yml`, the adapted `compose.host-network.yml` and `deploy/.env.example`
   - the ignore-file changes and their CI check, the CI smoke and healthy-hub tests
   - `deploy/test/compose.ci.yml` with the hub and nginx images, and its Dependabot entry
   - the README quick start, which says to build from a checkout for now
3. **Proxies:** the stream snippet and the old configs switched to it, the container nginx configs, the Caddy configs (with the Caddy image added to `compose.ci.yml`), CI validation, the proxy behaviour and disconnect tests, and the README proxy section and nginx upgrade note.
4. **Publishing:**
   - the `publish` job and tag triggers
   - switching `compose.yml` to the GHCR `image:` line, with `build:` commented out
   - the README GHCR notes
   - then tagging `v1.0.0`

## Confirmed choices

- **Port:** 8095.
- **Image name:** `ghcr.io/juusolatva/beszel-river`, matching the repository.
- **Versioning:** semver git tags starting with `v1.0.0`, published as `X.Y.Z`, `X.Y`, `X` and `latest`, plus `edge` from `main` when image files change. Compose defaults to `X`.
