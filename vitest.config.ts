import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
    passWithNoTests: true,
  },
});
