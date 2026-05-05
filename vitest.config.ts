import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Long-running git + LLM-mock tests can exceed the default 5s.
    testTimeout: 15_000,
  },
});
