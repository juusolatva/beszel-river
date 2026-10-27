import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Terminal table, the same table as a file for the CI job summary, a browsable report, and
      // lcov.info for SonarQube Cloud.
      reporter: ["text", ["text", { file: "coverage.txt" }], "html", "lcov"],
      // Everything but main.ts is gated; src/beszel/ is tested against a fake PocketBase. main.ts only
      // wires the modules together and is checked end to end against a live hub (see AGENTS.md); it
      // still appears in the report.
      thresholds: {
        "src/{config,log,server,upstream}.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/beszel/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/pipeline/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
      },
    },
  },
});
