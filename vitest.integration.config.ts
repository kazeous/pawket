import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/tests/**/*.integration.test.{ts,tsx}",
      "packages/*/tests/**/*.integration.test.{ts,tsx}",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    passWithNoTests: true,
  },
});
