import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextTypeScript from "eslint-config-next/typescript";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...fixupConfigRules([...nextVitals, ...nextTypeScript]),
  {
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  globalIgnores(["**/.next/**", "**/dist/**", "**/coverage/**"]),
]);
