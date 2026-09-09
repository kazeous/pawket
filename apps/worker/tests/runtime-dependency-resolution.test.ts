import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

test("the built worker can resolve its externalized Sharp runtime", () => {
  // Break caught: dist/index.js externalizes Sharp but the worker package cannot resolve it at startup.
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import('sharp')"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  expect(result.status, result.stderr).toBe(0);
});
