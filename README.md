# beszel-river

A web page that turns live server metrics from a [Beszel](https://beszel.dev) hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation; it is not meant to be readable.

Status: the page runs on live data from the bridge (M4); deployment files are ready (M5). Tested with Beszel v0.21.0. Design, message format and milestones are in [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | Contents |
|---|---|
| `shared/` | Message types shared by bridge and frontend (type-only). |
| `bridge/` | Node service: reads the Beszel hub, mixes metrics into abstract channels, serves them over SSE at `/stream`. |
| `frontend/` | Static WebGL2 page built with Vite. |
| `deploy/` | Bridge Dockerfile, compose file, systemd unit, nginx configs. |
| `docs/PLAN.md` | Plan: design, configuration, message format, milestones. |
| `AGENTS.md` | Conventions and invariants for coding agents (`CLAUDE.md` imports it). |

## Requirements

- Node.js ≥ 22.12.0 (production target: Node 24 LTS, see `.nvmrc`); CI checks both versions
- npm

## Development

```sh
npm ci                 # install all workspaces exactly as package-lock.json lists them
npm run dev:frontend   # Vite dev server on http://localhost:5173, proxies /stream to the bridge
npm run dev:bridge     # bridge in watch mode; needs bridge/.env (copy bridge/.env.example)
npm test               # bridge unit tests (vitest)
npm run coverage       # bridge tests with coverage; HTML report in bridge/coverage/index.html
npm run typecheck      # type-check all workspaces
npm run build          # build bridge (bridge/dist) and frontend (frontend/dist)
```

### Bridge setup

1. In Beszel, create a user for the bridge with the `readonly` role and add it to every system that should appear (or run the hub with `SHARE_ALL_SYSTEMS=true`).
2. `cp bridge/.env.example bridge/.env` and fill in `BESZEL_EMAIL`, `BESZEL_PASSWORD` and `STREAM_SALT`.
3. Optionally `cp bridge/mix.example.json bridge/mix.json` and tune the weights; `mix.json` is git-ignored.
4. `npm run dev:bridge`, then watch the frames with `curl -N http://127.0.0.1:8787/stream` (`-N` turns off curl's output buffering so events print as they arrive).

Configuration and the mix format are described in [docs/PLAN.md](docs/PLAN.md) under "Bridge".

### Frontend URL parameters

The page reads frames from `stream` next to itself (`/stream` at the site root). In dev, when the bridge is not running, it falls back to generated demo frames.

| Parameter | Effect |
|---|---|
| `?demo` | Generated demo frames instead of the bridge. |
| `?debug` | Panel with fps/particle stats. With demo frames: per-stream channel sliders, alive/hold toggles and add/remove stream buttons. With the bridge: the latest channel values, read-only. `d` hides it. |
| `?streams=N` | Number of demo streams (default 4). |
| `?interval=MS` | Demo update interval (default 1000; `60000` mimics the Beszel `systems` source). |
| `?particles=N` | Particle pool size (default 20000, 8000 on touch devices, halved with reduced motion). |
| `?seed=N` | Fixed random seed, for repeatable looks. |

Visual tunables (speeds, colours, trail length, easing) are in `frontend/src/config.ts` (`LOOK`).

## Deployment

The bridge runs next to the Beszel hub, in Docker or under systemd, and listens on `127.0.0.1:8787`. nginx serves the static page and proxies `/stream` to it. Background and the reasons for each setting: [docs/PLAN.md](docs/PLAN.md), "Deployment".

### 1. Configure

```sh
git clone https://github.com/juusolatva/beszel-river.git /opt/beszel-river && cd /opt/beszel-river
cp bridge/.env.example bridge/.env           # set BESZEL_EMAIL, BESZEL_PASSWORD, STREAM_SALT (and BESZEL_URL, below)
cp bridge/mix.example.json bridge/mix.json   # then change the weights: the template is public
```

Create the Beszel user as in "Bridge setup" above.

### 2a. Bridge in Docker (hub in Docker)

Set `BESZEL_URL=http://<hub service>:8090` in `bridge/.env` (`http://beszel:8090` with Beszel's example compose file). `BIND_HOST` and `BIND_PORT` are set by the compose file.

```sh
docker inspect -f '{{json .NetworkSettings.Networks}}' beszel   # the hub container's network names
BESZEL_NETWORK=beszel_default docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml ps                          # "(healthy)" once logged in to the hub
curl -N http://127.0.0.1:8787/stream
```

- `docker inspect -f '<template>' <container>`: prints the container's networks; `beszel` is the hub's container name.
- `BESZEL_NETWORK`: the hub's network, default `beszel_default`.
- `docker compose -f deploy/compose.yml`: uses that compose file. `up -d` starts in the background; `--build` builds the image first. `ps` lists the service and its health.
- `curl -N`: prints events as they arrive.

`bridge/mix.json` must exist; compose refuses to start without it. To update: `git pull`, then the same `up -d --build` command.

### 2b. Bridge under systemd (hub not in Docker)

Needs Node 24. Keep `BESZEL_URL=http://127.0.0.1:8090` if the hub runs on the same host.

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

### 3. Frontend

```sh
npm ci && npm run build -w @beszel-river/frontend
sudo rsync -a --delete frontend/dist/ /var/www/beszel-river/
```

- `rsync -a`: copies recursively, keeping permissions and times. `--delete`: removes files from older builds.

The build can also be made elsewhere and copied, if the server has no Node.

### 4. nginx

Own domain or subdomain, with `deploy/nginx/river.conf`:

```sh
sudo certbot certonly --nginx -d river.example.com
sudo cp deploy/nginx/river.conf /etc/nginx/conf.d/river.conf   # then replace river.example.com in it
sudo nginx -t && sudo systemctl reload nginx
```

- `certbot certonly --nginx -d <domain>`: gets a Let's Encrypt certificate through the running nginx without changing its config. The config expects it under `/etc/letsencrypt/live/<domain>/`.
- `nginx -t`: checks the config; `reload` applies it without dropping connections.

nginx older than 1.25.1 (Debian 12, Ubuntu 24.04) does not know `http2 on;`: delete that line and use `listen 443 ssl http2;`.

Under a path in an existing site instead: copy `deploy/nginx/river-path.conf` to `/etc/nginx/snippets/`, add `include /etc/nginx/snippets/river-path.conf;` inside that site's `server` block, and add `limit_conn_zone $binary_remote_addr zone=river_stream:10m;` to the `http` block (for example as a file in `/etc/nginx/conf.d/`). The page is then at `/river/`.

Check: `https://river.example.com/?debug` shows `alive` streams with live channel values.

## License

MIT, see [LICENSE](LICENSE).
