# AGENTS.md

Instructions for coding agents working in this repository. `CLAUDE.md` only imports this file.

## Project

A public web page that turns live metrics from a Beszel hub into an abstract river of rainbow-coloured particles flowing upwards. The data steers the animation but must not be readable from it.

- `docs/PLAN.md` is the source of truth for design, configuration, message format and milestones. Read the relevant section before changing behaviour, and update it in the same change when the behaviour, configuration or file layout changes.
- `README.md` holds setup, deployment and maintenance. Update it when commands, environment variables, URL parameters or deployment files change; new environment variables also go in `bridge/.env.example`.
- Milestone status is the checklist under "Milestones" in `docs/PLAN.md`. Tick a milestone only when its "Done when" condition has been checked, and note how it was checked.
- `.serena/memories/` holds dense notes for agents using Serena, starting from `core.md`. They repeat facts from this file and the code (source maps, constants, commands), so update them in the same change when those facts change.

## Layout

| Path | Contents |
|---|---|
| `shared/src/index.ts` | `Frame` and `Stream` message types. Type-only: `exports` has only a `types` condition, so consumers must use `import type`. |
| `bridge/` | Node service. `src/beszel/` talks to the hub (`systems-source.ts` 60 s, `realtime-source.ts` the 1 s layer), `src/pipeline/` turns samples into channels, `src/server.ts` serves SSE. Tests in `bridge/test/`. |
| `frontend/` | Vite + raw WebGL2 page. `src/source/` produces frames, `src/sim/` moves particles, `src/render/` draws them, `src/debug/` is the `?debug` panel. Look tunables are `LOOK` in `src/config.ts`. Tests of the pure modules in `frontend/test/`. |
| `deploy/` | Bridge Dockerfile, `compose.yml` and its host-network override `compose.host-network.yml`, systemd unit, nginx configs (`river.conf` for an own server block, `river-path.conf` for a path in an existing one). CI builds the image and checks the configs. |
| `.github/` | Workflows (`ci.yml`, `osv-scanner.yml`) and `dependabot.yml` (updates for the pinned actions). |
| `.serena/` | Serena's `project.yml` and `memories/`; `cache/` and `project.local.yml` are git-ignored, and `.dockerignore` keeps the directory out of the image. |
| `sonar-project.properties` | SonarQube Cloud settings. The scan reads `bridge/coverage/lcov.info` and `frontend/coverage/lcov.info`; CI prefixes their paths with the workspace. |
| `docs/PLAN.md` | Plan. |
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
npm run dev:bridge     # tsx watch; needs bridge/.env (template: bridge/.env.example)
```

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, `typecheck`, `coverage` and `build` on Node 22.12.0 and 24, and writes both workspaces' coverage tables to the job summary. On the Node 24 job it also runs a SonarQube Cloud scan (`SONAR_TOKEN` secret; skipped for forks and Dependabot, whose PRs get no secrets). Its `deploy` job builds `deploy/bridge.Dockerfile`, starts the image without a hub and expects `/stream` to answer with a snapshot, and checks `deploy/compose.yml`, alone and with `deploy/compose.host-network.yml` (`docker compose config`), and both nginx configs (`nginx -t`). Run `typecheck`, `coverage` and `build` before committing.

## Conventions

- **Node:** production runs Node 24 (`.nvmrc`); `engines` allows ≥ 22.12.0, the minimum for `vite` 8 and `eventsource` 5. Do not use APIs newer than 22.12.0. If either version changes, update `package.json`, `.nvmrc`, the CI matrix, `README.md` and the decisions table in `docs/PLAN.md` together.
- **Dependencies:** exact versions only (`.npmrc` sets `save-exact=true`). Add few; the bridge uses `node:http` and the frontend uses no rendering library on purpose. Commit `package-lock.json` changes with the dependency change, and make them with npm 11 (Node 24): npm 10 from Node 22 adds `"peer": true` to the `@esbuild/*` entries. `vitest` and `@vitest/coverage-v8` are devDependencies of both `bridge` and `frontend`; bump them together so the lock keeps one copy.
- **TypeScript:** strict settings from `tsconfig.base.json`, whose `lib` is ES2023 only; `frontend/tsconfig.json` adds the DOM libs, so `window` and `document` do not type-check in the bridge. `noUncheckedIndexedAccess` is off on purpose so typed-array code stays readable. ES modules everywhere; bridge imports use `.js` extensions (NodeNext resolution).
- **Style:** match the surrounding code: short doc comments on exported items, comments that explain why rather than what, no formatter-driven churn. `.editorconfig` sets the whitespace rules.
- **Frontend hot path:** no allocations per particle or per frame in `src/sim/` and `src/render/`; keep state in the preallocated typed arrays.
- **CI:** pin actions to a full commit SHA with the version in a comment (`uses: actions/checkout@<sha> # v7.0.1`); Dependabot updates both. Pass `${{ }}` values to `run` scripts through `env`, not inline. Check workflow changes with `actionlint` (with `shellcheck` on the path) and `zizmor --persona=auditor .github`; both should report nothing above informational.
- **Shaders:** GLSL files in `frontend/src/render/shaders/`, imported with Vite's `?raw` suffix.
- **Frontend URLs:** keep them relative (`base: "./"` in `vite.config.ts`, stream URL `"stream"` in `src/main.ts`), so one build works at a site root and under `/river/`.
- **Content-Security-Policy:** the nginx configs send `default-src 'self'` with only inline styles allowed. The page must not load anything from other origins or use inline scripts. Keep every `add_header` at server level: one inside a location drops the others there.

## Invariants

These protect the point of the project. Do not break them without a change to `docs/PLAN.md` explaining why.

- Raw metrics, hostnames, system IDs and Beszel field names never leave the bridge. Frames carry only the `Stream` channels, rounded to 3 decimals.
- Beszel record types are declared in `bridge/src/beszel/types.ts`. Only `bridge/src/beszel/`, `pipeline/features.ts` (stats and info → samples) and `pipeline/hosts.ts` (status, thread count) may read Beszel fields; everything after them works on samples and features. Beszel renames fields between minor releases.
- Stream IDs are HMAC-SHA256 of the system ID with `STREAM_SALT`; band order and quantized band widths are seeded daily from the salt and the UTC date; `filaments` are always 6 values resampled from the sorted per-core usage, mixed and jittered through `mix.json` and reordered daily. Do not add fields that reveal host count, core count or exact rates.
- The mixing recipe lives in `bridge/mix.json`, which is git-ignored. Only `bridge/mix.example.json` is committed; the frontend never learns the recipe.
- The public page never mentions Beszel or hostnames in its title or visible text.
- Secrets live in `bridge/.env` (git-ignored). Never commit real credentials, salts or `mix.json`.

## Testing

- Bridge logic is pure where possible; add or update vitest tests in `bridge/test/` for every change to `config.ts`, `pipeline/` or `server.ts`, and in `frontend/test/` for every change to `frontend/src/config.ts` or `src/util/`.
- `bridge/vitest.config.ts` and `frontend/vitest.config.ts` set coverage thresholds for those modules (90 % statements, functions and lines, 80 % branches); `npm run coverage` fails below them. Do not lower a threshold to make a change pass; add tests instead. Under a coding agent, vitest leaves fully covered files out of the terminal table; CI shows them all.
- End-to-end bridge checks need a running Beszel hub and agent (release binaries from GitHub, run outside the repository). Watch frames with `curl -N http://127.0.0.1:8787/stream`. With `SOURCE=realtime`, the bridge logs "Realtime metrics on/off" as viewers come and go.
- Token mode (`BESZEL_TOKEN`): start the hub with `DISABLE_PASSWORD_AUTH=true` and get a token as a superuser with `POST /api/collections/users/impersonate/<user id>` and the body `{"duration": <seconds>}`.
- Deployment files: run the CI `deploy` job's commands. `nginx -t` opens the listen sockets, so in a container without IPv6 remove the `listen [::]` lines first, as CI does.
- Vite's dev proxy keeps `/stream` open when the bridge dies, so check lost-connection behaviour behind nginx (the CI configs work locally with `nginx:stable-alpine`) or against the bridge directly.
- The frontend's unit tests cover only code without a browser (`config.ts`, `util/math.ts`, `parseFrame`). Check visual changes in a browser; `?debug` shows a channel panel and fps, and `?seed=N` makes runs repeatable. Headless Chromium renders WebGL2 in software (about 11 fps) with `--enable-unsafe-swiftshader --use-angle=swiftshader --ignore-gpu-blocklist`, so it can check behaviour but not performance. It also keeps every core busy, so do not run it on the machine whose metrics you are measuring; replay recorded frames instead.

## Git

- Work on a branch and open a pull request against `main`; `main` only receives merges.
- One logical change per commit, with a message that says what changed and why.
