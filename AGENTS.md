# AGENTS.md

Instructions for coding agents working in this repository. `CLAUDE.md` only imports this file.

## Project

A public web page that turns live metrics from a Beszel hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation but must not be readable from it.

- `docs/PLAN.md` is the source of truth for design, configuration, message format and milestones. Read the relevant section before changing behaviour, and update it in the same change when the behaviour, configuration or file layout changes.
- `README.md` holds setup and usage. Update it when commands, environment variables or URL parameters change.
- Milestone status is the checklist under "Milestones" in `docs/PLAN.md`. Tick a milestone only when its "Done when" condition has been checked, and note how it was checked.

## Layout

| Path | Contents |
|---|---|
| `shared/src/index.ts` | `Frame` and `Stream` message types. Type-only: `exports` has only a `types` condition, so consumers must use `import type`. |
| `bridge/` | Node service. `src/beszel/` talks to the hub, `src/pipeline/` turns samples into channels, `src/server.ts` serves SSE. Tests in `bridge/test/`. |
| `frontend/` | Vite + raw WebGL2 page. `src/source/` produces frames, `src/sim/` moves particles, `src/render/` draws them. Look tunables are `LOOK` in `src/config.ts`. |
| `deploy/` | Bridge Dockerfile and compose file, systemd unit, nginx configs. CI builds the image and checks the configs. |
| `docs/PLAN.md` | Plan. |

## Commands

Run from the repository root.

```sh
npm ci                 # install exactly what package-lock.json lists
npm run typecheck      # tsc in every workspace
npm test               # bridge unit tests (vitest run)
npm run coverage       # the same with coverage; report in bridge/coverage/ (index.html)
npm run build          # bridge → bridge/dist, frontend → frontend/dist
npm run dev:frontend   # Vite on http://localhost:5173, proxies /stream to 127.0.0.1:8787
npm run dev:bridge     # tsx watch; needs bridge/.env (template: bridge/.env.example)
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `typecheck`, `coverage` and `build` on Node 22.12.0 and 24, and writes the coverage table to the job summary. Its `deploy` job builds `deploy/bridge.Dockerfile` and checks `deploy/compose.yml` (`docker compose config`) and both nginx configs (`nginx -t`). Run `typecheck`, `coverage` and `build` before committing.

## Conventions

- **Node:** production runs Node 24 (`.nvmrc`); `engines` allows ≥ 22.12.0, the minimum for `vite` 8 and `eventsource` 5. Do not use APIs newer than 22.12.0. If either version changes, update `package.json`, `.nvmrc`, the CI matrix, `README.md` and the decisions table in `docs/PLAN.md` together.
- **Dependencies:** exact versions only (`.npmrc` sets `save-exact=true`). Add few; the bridge uses `node:http` and the frontend uses no rendering library on purpose. Commit `package-lock.json` changes with the dependency change.
- **TypeScript:** strict settings from `tsconfig.base.json`. `noUncheckedIndexedAccess` is off on purpose so typed-array code stays readable. ES modules everywhere; bridge imports use `.js` extensions (NodeNext resolution).
- **Style:** match the surrounding code: short doc comments on exported items, comments that explain why rather than what, no formatter-driven churn. `.editorconfig` sets the whitespace rules.
- **Frontend hot path:** no allocations per particle or per frame in `src/sim/` and `src/render/`; keep state in the preallocated typed arrays.
- **Shaders:** GLSL files in `frontend/src/render/shaders/`, imported with Vite's `?raw` suffix.

## Invariants

These protect the point of the project. Do not break them without a change to `docs/PLAN.md` explaining why.

- Raw metrics, hostnames, system IDs and Beszel field names never leave the bridge. Frames carry only the `Stream` channels, rounded to 3 decimals.
- Beszel record types are declared in `bridge/src/beszel/types.ts`. Only `bridge/src/beszel/`, `pipeline/features.ts` (stats and info → samples) and `pipeline/hosts.ts` (status, thread count) may read Beszel fields; everything after them works on samples and features. Beszel renames fields between minor releases.
- Stream IDs are HMAC-SHA256 of the system ID with `STREAM_SALT`; band order is reshuffled daily from the salt and the UTC date; band widths are quantized. Do not add fields that reveal host count, core count or exact rates.
- The mixing recipe lives in `bridge/mix.json`, which is git-ignored. Only `bridge/mix.example.json` is committed; the frontend never learns the recipe.
- The public page never mentions Beszel or hostnames in its title or visible text.
- Secrets live in `bridge/.env` (git-ignored). Never commit real credentials, salts or `mix.json`.

## Testing

- Bridge logic is pure where possible; add or update vitest tests in `bridge/test/` for every change to `config.ts`, `pipeline/` or `server.ts`.
- `bridge/vitest.config.ts` sets coverage thresholds for those modules (90 % statements, functions and lines, 80 % branches); `npm run coverage` fails below them. Do not lower a threshold to make a change pass; add tests instead.
- End-to-end bridge checks need a running Beszel hub and agent (release binaries from GitHub, run outside the repository). Watch frames with `curl -N http://127.0.0.1:8787/stream`.
- The frontend has no unit tests. Check visual changes in a browser; `?debug` shows a channel panel and fps, and `?seed=N` makes runs repeatable. Headless Chromium renders WebGL2 in software (about 11 fps) with `--enable-unsafe-swiftshader --use-angle=swiftshader --ignore-gpu-blocklist`, so it can check behaviour but not performance. It also keeps every core busy, so do not run it on the machine whose metrics you are measuring; replay recorded frames instead.

## Git

- Work on a branch and open a pull request against `main`; `main` only receives merges.
- One logical change per commit, with a message that says what changed and why.
