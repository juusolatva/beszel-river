import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Terminal table, the same table as a file for the CI job summary, a browsable report, and
      // lcov.info for SonarQube Cloud.
      reporter: ["text", ["text", { file: "coverage.txt" }], "html", "lcov"],
      // Only the pure modules are gated. main.ts, log.ts and src/beszel/ do I/O against a live hub
      // and are checked end to end (see AGENTS.md), with unit tests for some error paths; they still
      // appear in the report.
      thresholds: {
        "src/{config,server}.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/pipeline/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
      },
    },
  },
});
