const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    include: [
      "apps/*/tests/**/*.integration.test.ts",
      "packages/*/tests/**/*.integration.test.ts",
    ],
    passWithNoTests: true,
  },
});
