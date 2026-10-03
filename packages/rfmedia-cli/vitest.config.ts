import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    benchmark: {
      include: ["benchmarks/**/*.bench.ts"],
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/lib/lidarr/generated/**",
        "src/test-utils/**",
        "src/actions/test-helpers/**",
      ],
    },
  },
});
