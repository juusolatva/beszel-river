# beszel-river

A web page that turns live server metrics from a [Beszel](https://beszel.dev) hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation; it is not meant to be readable.

Status: project setup (M0). Design, message format and milestones are in [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | Contents |
|---|---|
| `shared/` | Message types shared by bridge and frontend (type-only). |
| `bridge/` | Node service: reads the Beszel hub, mixes metrics into abstract channels, serves them over SSE at `/stream`. |
| `frontend/` | Static WebGL2 page built with Vite. |
| `docs/PLAN.md` | Plan. |

## Requirements

- Node.js ≥ 22.12.0 (production target: Node 24 LTS, see `.nvmrc`)
- npm

## Development

```sh
npm install            # install all workspaces
npm run dev:frontend   # Vite dev server on http://localhost:5173, proxies /stream to the bridge
npm run dev:bridge     # bridge in watch mode; needs bridge/.env (copy bridge/.env.example)
npm run typecheck      # type-check all workspaces
npm run build          # build bridge (bridge/dist) and frontend (frontend/dist)
```

## License

MIT, see [LICENSE](LICENSE).
