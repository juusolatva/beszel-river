# Suggested Commands

Run workspace commands from the repository root:

- `npm ci` — Install exact workspace dependencies from `package-lock.json`.
- `npm run typecheck` — Run `tsc` across `shared`, `bridge`, and `frontend`.
- `npm test` — Run `vitest run` in `bridge` and `frontend`.
- `npm run coverage` — Run unit tests with v8 coverage and threshold enforcement; writes HTML reports to `bridge/coverage/index.html` and `frontend/coverage/index.html`.
- `npm run build` — Build `bridge` (`bridge/dist`) and `frontend` (`frontend/dist`).
- `npm run dev:bridge` — Run bridge in `tsx watch` mode (requires `bridge/.env`, copied from `bridge/.env.example`).
- `npm run dev:frontend` — Start Vite dev server on `http://localhost:5173` (proxies `/stream` to `http://127.0.0.1:8787`).
- `curl -N http://127.0.0.1:8787/stream` — Stream live SSE events from the local bridge with output buffering disabled.
