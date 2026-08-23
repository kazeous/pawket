import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/*.{ts,tsx}",
    "**/.next/**",
    "**/dist/**",
    "**/coverage/**",
  ]),
]);
