import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/tests/**/*.integration.test.{ts,tsx}",
      "packages/*/tests/**/*.integration.test.{ts,tsx}",
    ],
    passWithNoTests: true,
  },
});
