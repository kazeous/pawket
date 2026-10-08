import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "apps/*/tests/**/*.test.{ts,tsx}",
      "packages/*/tests/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/*.integration.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
