import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
  },
  clean: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  sourcemap: true,
  splitting: false,
  target: "node24",
  noExternal: [/.*/],
});
