const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    include: ["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
    passWithNoTests: true,
  },
});
