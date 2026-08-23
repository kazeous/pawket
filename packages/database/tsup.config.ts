import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/migrate.ts"],
  format: ["esm"],
  noExternal: [/.*/],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node24",
});
