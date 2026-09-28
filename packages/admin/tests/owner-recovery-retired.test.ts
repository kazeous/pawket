import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("retired local owner-MFA CLI refuses before reading environment or database", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/recover-owner-mfa.ts", import.meta.url)), "--apply"], {
    env: { ...process.env, DATABASE_URL: "must-not-connect", PII_KEYRING_JSON: "must-not-decrypt" }, encoding: "utf8",
  });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("AUTH_MOVED");
  expect(result.stderr).not.toContain("must-not-");
});
