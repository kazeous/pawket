import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/*/tests/**/*.test.{ts,tsx}",
      "packages/*/tests/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/*.integration.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
