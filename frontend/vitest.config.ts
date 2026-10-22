import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/util/math.ts"],
      reporter: ["text", ["text", { file: "coverage.txt" }], "html"],
    },
  },
});
