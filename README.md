# beszel-river

A web page that turns live server metrics from a [Beszel](https://beszel.dev) hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation; it is not meant to be readable.

Status: all milestones done except the 60 fps check on a real GPU (M2); deployed with live data (M5), with an optional 1 s realtime source (M6, `SOURCE=realtime`). Tested with Beszel v0.21.0. Design, message format and milestones are in [docs/PLAN.md](docs/PLAN.md).

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
   - If the hub has password auth disabled (OIDC only, `DISABLE_PASSWORD_AUTH=true`), the bridge cannot log in with a password. Leave `BESZEL_EMAIL` and `BESZEL_PASSWORD` empty and set `BESZEL_TOKEN` instead. To make one, open the hub's PocketBase dashboard (`<hub URL>/_/`) as a superuser, then Collections → `users` → the bridge user → the `⋯` menu → **Impersonate**. In the "Generate nonrenewable auth token" dialog, give a duration in seconds, e.g. `31536000` for a year.
   - The bridge cannot renew such a token. It logs a warning from 14 days before expiry; then make a new one and restart the bridge (Deployment, "5. Maintenance").
   - To revoke it, use **Reset issued tokens** in the same menu.
3. Optionally `cp bridge/mix.example.json bridge/mix.json` and tune the weights; `mix.json` is git-ignored. Files without a `filaments` entry use its defaults.
4. Optionally set `SOURCE=realtime` for 1 s updates instead of 60 s ones. The bridge then asks the hub for each up host's live metrics while at least one page is open, and for 30 s after the last one closes; meanwhile the hub fetches from those agents every second, as it does while someone watches a system's 1-minute chart in Beszel.
5. `npm run dev:bridge`, then watch the frames with `curl -N http://127.0.0.1:8787/stream` (`-N` turns off curl's output buffering so events print as they arrive).

Configuration and the mix format are described in [docs/PLAN.md](docs/PLAN.md) under "Bridge".

### Frontend URL parameters

The page reads frames from `stream` next to itself (`/stream` at the site root). In dev, when the bridge is not running, it falls back to generated demo frames.

| Parameter | Effect |
|---|---|
| `?demo` | Generated demo frames instead of the bridge. |
| `?debug` | Panel with fps/particle stats. With demo frames: per-stream channel sliders, alive/hold/filaments toggles and add/remove stream buttons. With the bridge: the latest channel values and filaments, read-only. `d` hides it. |
| `?streams=N` | Number of demo streams (default 4). |
| `?interval=MS` | Demo update interval (default 1000; `60000` mimics the Beszel `systems` source). |
| `?particles=N` | Fixed particle pool size. Without it the pool is 20000 (8000 on touch devices, halved with reduced motion) and thins out on devices that cannot keep up. |
| `?seed=N` | Fixed random seed, for repeatable looks. |

Visual tunables (speeds, colours, trail length, easing) are in `frontend/src/config.ts` (`LOOK`).

## Deployment

The bridge runs next to the Beszel hub, in Docker or under systemd, and listens on `127.0.0.1:8787`. nginx serves the static page and proxies `/stream` to it. Background and the reasons for each setting: [docs/PLAN.md](docs/PLAN.md), "Deployment".

### 1. Configure

```sh
git clone https://github.com/juusolatva/beszel-river.git && cd beszel-river
cp bridge/.env.example bridge/.env           # set BESZEL_EMAIL and BESZEL_PASSWORD (or BESZEL_TOKEN), STREAM_SALT, BESZEL_URL (below)
cp bridge/mix.example.json bridge/mix.json   # then change the weights: the template is public
```

Any directory works for Docker; the systemd unit (2b) expects `/opt/beszel-river`. Create the Beszel user as in "Bridge setup" above.

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

If the hub runs with `network_mode: host`, it is on no Docker network. Run the bridge on the host network too, with `BESZEL_URL=http://127.0.0.1:8090` (the hub's port), adding the override file:

```sh
docker compose -f deploy/compose.yml -f deploy/compose.host-network.yml up -d --build
```

The bridge then listens on the host's `127.0.0.1:8787` directly; `BESZEL_NETWORK` is not used. Pass the same two `-f` options to every later `docker compose` command (`ps`, `logs`, `down`). The override uses `!reset`, which needs Docker Compose 2.24.0 or later (`docker compose version`).

`bridge/mix.json` must exist; compose refuses to start without it. To update: `git pull`, then the same `up -d --build` command.

### 2b. Bridge under systemd (hub not in Docker)

Needs Node 24 and the checkout in `/opt/beszel-river` (the unit's `WorkingDirectory`). Keep `BESZEL_URL=http://127.0.0.1:8090` if the hub runs on the same host.

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

### 5. Maintenance

The bridge restarts by itself (`restart: unless-stopped` in compose, `Restart=on-failure` in the unit) and reconnects after hub restarts.

- **Configuration changes:** after editing `bridge/.env` (e.g. `SOURCE=realtime`), run the same 2a `up -d` command: it recreates the container with the new environment, which `docker compose restart` would not. After editing only `bridge/mix.json`, `up -d` sees no change; use `restart bridge` instead (with the same `-f` options), since the bridge reads the file at startup. Under systemd, `sudo systemctl restart beszel-river-bridge` covers both.
- **Updates:** `git pull`, then rebuild the bridge (the 2a `up -d --build` command, or 2b's build and `sudo systemctl restart beszel-river-bridge`) and the frontend (3).
- **Token expiry** (`BESZEL_TOKEN` only): the bridge logs the expiry date every time it starts.
  ```sh
  docker compose -f deploy/compose.yml logs bridge | grep 'valid until'   # Docker
  sudo journalctl -u beszel-river-bridge | grep 'valid until'             # systemd
  ```
  - `logs bridge`: the bridge service's output. With the host-network override, pass both `-f` options as in 2a.
  - `journalctl -u <unit>`: that unit's log.
  - `grep 'valid until'`: keeps the line with the date.

  After that date the hub rejects the token, and the bridge does not start with it (`BESZEL_TOKEN expired on …`). Put a new token (see "Bridge setup") in `bridge/.env`, then run the same `up -d` command, which recreates the container with the new value (`docker compose restart` would keep the old one), or `sudo systemctl restart beszel-river-bridge`.
- **Beszel upgrades:** Beszel renames fields between minor releases, and the bridge is tested with v0.21.0. After a hub upgrade, check that `?debug` still shows changing channel values. A hub image that updates itself (`:latest` with Watchtower or similar) can stop the river without notice; pin a version to upgrade on purpose.
- **Certificate:** `sudo certbot renew --dry-run` checks that automatic renewal works. `renew` renews certificates close to expiry; `--dry-run` uses Let's Encrypt's test server and saves nothing. Certificates obtained with `--nginx` make certbot reload nginx after each renewal.

## License

MIT, see [LICENSE](LICENSE).
