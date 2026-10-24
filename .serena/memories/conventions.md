# Codebase Conventions

- **TypeScript Configuration:**
  - `tsconfig.base.json` sets `"lib": ["ES2023"]` without DOM types; `frontend/tsconfig.json` adds `"DOM"` and `"DOM.Iterable"`, so `window` and `document` fail typechecking in `bridge`.
  - `verbatimModuleSyntax: true` and `isolatedModules: true` are enabled; use `import type` for type-only imports.
  - `noUncheckedIndexedAccess` is intentionally disabled so typed-array indexing in simulation/pipeline code stays concise.
- **Module Resolution & Imports:**
  - `bridge` uses `NodeNext` resolution: relative imports in `bridge/` must end with `.js`.
  - Keep dependencies minimal (`node:http` in bridge, zero runtime dependencies in frontend).
- **Formatting & Comments:**
  - Follow `.editorconfig` (2-space indentation, LF, UTF-8, final newline).
  - Add brief doc comments on exported functions/types; inline comments should explain *why* rather than *what*. Avoid formatter-driven diff churn.
- **GitHub Actions (`.github/workflows/ci.yml`):**
  - Pin every `uses:` action to a full 40-char commit SHA followed by the version tag in a comment (`uses: actions/checkout@<sha> # v7.0.1`) for Dependabot compatibility.
  - Never interpolate `${{ }}` expressions directly inside `run:` scripts; pass them through step `env:` variables.
- **Git Workflow:**
  - Work on a branch and open a pull request against `main` (`main` receives merges only).
  - Make one logical change per commit with a commit message explaining what changed and why.
