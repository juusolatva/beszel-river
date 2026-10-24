# Project Core (`beszel-river`)

Turns live server metrics from a Beszel hub into an abstract upward-flowing WebGL2 particle river over SSE.

## Top-Level Layout

- `shared/src/index.ts` — Type-only `Frame` and `Stream` SSE message definitions.
- `bridge/` — Node service that ingests Beszel metrics, normalizes/mixes/anonymizes them into abstract channels, and broadcasts SSE frames on `/stream`.
- `frontend/` — Static Vite + raw WebGL2 client that eases stream channels, simulates particles on the CPU, and renders trails.
- `deploy/` — Production `bridge.Dockerfile`, `compose.yml`, `compose.host-network.yml`, systemd service unit, and nginx configs (`river.conf`, `river-path.conf`).
- `.github/` — CI workflow (`workflows/ci.yml`) and Dependabot config for the SHA-pinned actions.
- `.serena/` — Serena `project.yml` and these memories (`cache/`, `project.local.yml` git-ignored; excluded from the Docker build context).
- `docs/images/` — README screenshots (JPEG, 1280 px wide, metadata stripped).
- `docs/PLAN.md` — Authoritative specification for architecture, configuration, math, message format, and milestones.
- `AGENTS.md` — Repository instructions and invariants (`CLAUDE.md` imports it).

## Project-Wide Invariants

- **Data opacity:** Raw metrics, hostnames, system IDs, core counts, exact byte rates, and Beszel field names must never leave `bridge/`. SSE frames contain only `Stream` channels rounded to 3 decimal places.
- **Secret isolation:** `bridge/.env` (credentials, `STREAM_SALT`) and `bridge/mix.json` (mixing recipe weights) are git-ignored. Only `.env.example` and `mix.example.json` are committed; the frontend must never learn the mixing recipe.
- **Public page anonymity:** The frontend (`index.html`, title, visible DOM text) must never mention "Beszel" or hostnames.
- **Documentation sync:**
  - Read and update `docs/PLAN.md` in the same change whenever behaviour, configuration, message format, or file layout changes. Tick milestone checkboxes only after verifying their "Done when" conditions and recording how they were checked.
  - Update `README.md` (and `bridge/.env.example` for new env vars) whenever commands, environment variables, URL parameters, or deployment files change.
  - Update `AGENTS.md` and these memories when the layout, commands, conventions, or facts they state change.

## Memory Graph

- Read `mem:tech_stack` when adding dependencies, checking Node/TypeScript/Vite/Vitest version constraints, or modifying `package.json` / `package-lock.json`.
- Read `mem:conventions` when writing or reviewing TypeScript code, imports, comments, commits, or GitHub Actions workflows.
- Read `mem:suggested_commands` when running local dev servers, unit tests, builds, or inspecting the SSE stream.
- Read `mem:task_completion` before finishing any coding, CI, or deployment task to run required verification gates and coverage checks.
- Read `mem:memory_maintenance` when maintaining, adding, or pruning agent memories.
- Read `mem:bridge/core` when working in `bridge/` on Beszel hub adapters, metric normalization, channel mixing, anonymization, or the SSE HTTP server.
- Read `mem:frontend/core` when working in `frontend/` on the WebGL2 renderer, particle simulation, frame sources, URL parameters, or browser testing.
