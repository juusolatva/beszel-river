# Task Completion Checklist

1. **Mandatory Verification Commands (run from repo root before committing):**
   - `npm run typecheck`
   - `npm run coverage`
   - `npm run build`
2. **Test & Coverage Requirements:**
   - Add or update unit tests in `bridge/test/` for any change to `bridge/src/config.ts`, `bridge/src/pipeline/**`, or `bridge/src/server.ts`.
   - Add or update unit tests in `frontend/test/` for any change to `frontend/src/config.ts`, `frontend/src/util/**`, or `parseFrame` (`frontend/src/source/stream.ts`).
   - `vitest.config.ts` in both workspaces enforces **90% statements/functions/lines and 80% branches** on those pure modules. Never lower thresholds; add tests instead.
3. **CI Workflow Changes (`.github/`):**
   - Run `actionlint` (with `shellcheck` on `PATH`) and `zizmor --persona=auditor .github`; both must report nothing above informational.
4. **Deployment File Changes (`deploy/`):**
   - Build image: `docker build -f deploy/bridge.Dockerfile -t beszel-river-bridge:test .`
   - Validate compose configs:
     - `docker compose -f deploy/compose.yml config`
     - `docker compose -f deploy/compose.yml -f deploy/compose.host-network.yml config`
   - Validate nginx configs (`deploy/nginx/river.conf` and `deploy/nginx/river-path.conf`) with `nginx -t` (in containers without IPv6, strip `listen [::]` lines before running `nginx -t`).
5. **Documentation Sync:**
   - Update `docs/PLAN.md` if behaviour, configuration, message format, or file layout changed.
   - Update `README.md` (and `bridge/.env.example`) if commands, env vars, URL parameters, or deployment files changed.
   - Update `AGENTS.md` and the Serena memories if layout, commands, conventions, or facts stated in them changed.
