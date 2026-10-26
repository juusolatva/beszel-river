import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Terminal table, the same table as a file for the CI job summary, a browsable report, and
      // lcov.info for SonarQube Cloud.
      reporter: ["text", ["text", { file: "coverage.txt" }], "html", "lcov"],
      // Everything but main.ts and the debug panel is gated. The renderer is tested against a fake
      // WebGL2 context (test/fake-gl.ts) and StreamSource against stubbed EventSource and document;
      // how the page looks and performs is still checked in a browser (see AGENTS.md). main.ts and
      // src/debug/ only build the page and still appear in the report.
      thresholds: {
        "src/config.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
        "src/{render,sim,source,util}/**": { statements: 90, branches: 80, functions: 90, lines: 90 },
      },
    },
  },
});
