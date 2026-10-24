import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Terminal table, the same table as a file for the CI job summary, a browsable report, and
      // lcov.info for SonarQube Cloud.
      reporter: ["text", ["text", { file: "coverage.txt" }], "html", "lcov"],
      // Only the pure modules are gated. The simulation, renderer, sources and debug panel need a
      // browser and WebGL2 and are checked there (see AGENTS.md); they still appear in the report.
      thresholds: {
        "src/config.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/util/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
      },
    },
  },
});
