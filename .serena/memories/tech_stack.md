# Tech Stack & Dependencies

- **Language:** TypeScript `7.0.2` across all workspaces (`"type": "module"`, target `ES2023`, strict mode).
- **Runtime:** Node.js 24 LTS in production (`.nvmrc`, `node:24-alpine` in Docker); `engines.node` supports `>=24.22.1` (security floor; `vite` 8 and `eventsource` 5 need only 22.12.0). CI matrix: 24.22.1, 24, 26.
  - Do not use Node.js APIs introduced after `24.22.1`.
  - Any Node version change must update `package.json`, `.nvmrc`, `.github/workflows/ci.yml`, `README.md`, and the decisions table in `docs/PLAN.md` together.
- **Package Manager & Workspaces:** npm workspaces (`shared`, `bridge`, `frontend`) with a single root `package-lock.json`.
  - `.npmrc` sets `save-exact=true`; pin exact dependency versions only.
  - Always generate and commit `package-lock.json` changes with **npm 11 (Node 24)**; npm 10 (Node 22) adds extraneous `"peer": true` flags to `@esbuild/*` entries.
- **Shared (`@beszel-river/shared`):** Type-only package (`exports["."]` defines only `"types": "./src/index.ts"`). Runtime imports fail; consumers must use `import type`.
- **Bridge (`@beszel-river/bridge`):**
  - HTTP server: built-in `node:http` (no web framework).
  - Upstream client: `pocketbase` `0.28.1` + `eventsource` `5.1.3` polyfill.
  - Dev runner: `tsx` `4.23.15`.
- **Frontend (`@beszel-river/frontend`):**
  - Bundler/dev server: `vite` `8.3.4`.
  - Graphics: raw WebGL2 and GLSL 300 es shaders (no rendering library).
- **Testing:** `vitest` `5.0.5` and `@vitest/coverage-v8` `5.0.5` in both `bridge` and `frontend`. Keep their versions identical across both workspaces so `package-lock.json` deduplicates to a single copy.
