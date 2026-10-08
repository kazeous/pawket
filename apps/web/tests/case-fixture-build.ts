import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "tsup";

const webRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(webRoot, ".playwright-artifacts", "case-bundle");
export async function buildCaseFixture(): Promise<string> {
  await build({ entry: [path.join(import.meta.dirname, "case-fixture.tsx").replaceAll("\\", "/")], outDir, format: ["iife"], platform: "browser", noExternal: [/.*/],
    tsconfig: path.join(webRoot, "tsconfig.json"), config: false, splitting: false, silent: true,
    // Next's production build inlines these Link flags. This standalone fixture
    // uses the same defaults as next.config.ts, without a runtime process shim.
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.__NEXT_ROUTER_BASEPATH": '""',
      "process.env.__NEXT_I18N_SUPPORT": "false",
      "process.env.__NEXT_TRAILING_SLASH": "false",
      "process.env.__NEXT_MANUAL_TRAILING_SLASH": "false",
      "process.env.__NEXT_MANUAL_CLIENT_BASE_PATH": "false",
      "process.env.__NEXT_LINK_NO_TOUCH_START": "false",
    }, esbuildOptions(options) { options.jsx = "automatic"; } });
  return readFile(path.join(outDir, "case-fixture.global.js"), "utf8");
}
