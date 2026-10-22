# beszel-river

A web page that turns live server metrics from a [Beszel](https://beszel.dev) hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation; it is not meant to be readable.

Status: renderer with generated demo data (M2) and the bridge reading Beszel (M3); connecting the two is M4. Design, message format and milestones are in [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | Contents |
|---|---|
| `shared/` | Message types shared by bridge and frontend (type-only). |
| `bridge/` | Node service: reads the Beszel hub, mixes metrics into abstract channels, serves them over SSE at `/stream`. |
| `frontend/` | Static WebGL2 page built with Vite. |
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

| Parameter | Effect |
|---|---|
| `?debug` | Panel with per-stream channel sliders, alive/hold toggles, add/remove stream buttons and fps/particle stats. `d` hides it. |
| `?streams=N` | Number of demo streams (default 4). |
| `?interval=MS` | Demo update interval (default 1000; `60000` mimics the Beszel `systems` source). |
| `?particles=N` | Particle pool size (default 20000, 8000 on touch devices, halved with reduced motion). |
| `?seed=N` | Fixed random seed, for repeatable looks. |

Visual tunables (speeds, colours, trail length, easing) are in `frontend/src/config.ts` (`LOOK`).

## License

MIT, see [LICENSE](LICENSE).
