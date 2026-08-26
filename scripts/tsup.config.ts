import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
  },
  clean: true,
  entry: { "bootstrap-owner": "scripts/bootstrap-owner.ts" },
  format: ["esm"],
  noExternal: [/.*/],
  outDir: "dist/ops",
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node24",
});
