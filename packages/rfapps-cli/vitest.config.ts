import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000,
    include: ["src/**/*.spec.ts", "src/**/*.test.ts"],
    pool: "forks", // pin: insurance against vitest pool-default drift (4.0.17 default is already forks)
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Extend, don't replace, the defaults — a bare array would drop node_modules/dist/*.d.ts
      // excludes and leak built dist/ output into local coverage reports (plan correction 19).
      // Spec files are already covered by the defaults.
      exclude: [...coverageConfigDefaults.exclude, "src/testing/**"],
    },
  },
});
