import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateProductionLicenseMetadata } from "../../../scripts/validate-production-license-inventory.mjs";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/validate-production-license-inventory.mjs",
);

describe("production license inventory validation", () => {
  it("accepts declared license metadata without imposing an allow or deny policy", () => {
    // Catches treating a license inventory as an unapproved legal-policy gate.
    expect(
      validateProductionLicenseMetadata([
        { name: "example-mit", version: "1.0.0", license: "MIT" },
        { name: "example-custom", version: "2.0.0", license: "LicenseRef-commercial-review" },
      ]),
    ).toEqual([]);
  });

  it("rejects missing, unknown, and explicitly unlicensed production metadata", () => {
    // Catches shipping a production dependency without inventoryable license information.
    expect(
      validateProductionLicenseMetadata([
        { name: "missing", version: "1.0.0" },
        { name: "unknown", version: "2.0.0", license: "UNKNOWN" },
        { name: "unlicensed", version: "3.0.0", license: "UNLICENSED" },
      ]),
    ).toEqual([
      "missing@1.0.0: missing license metadata",
      "unknown@2.0.0: unknown license metadata",
      "unlicensed@3.0.0: explicitly unlicensed",
    ]);
  });

  it("prints a production inventory when invoked as the CI command", () => {
    // Catches a module-entrypoint mismatch that would turn the required CI license gate into a no-op.
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input: JSON.stringify({
        MIT: [
          {
            name: "example-package",
            versions: ["1.0.0"],
            paths: [path.dirname(fileURLToPath(import.meta.url))],
            license: "MIT",
          },
        ],
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Production license inventory:");
    expect(result.stdout).toContain("example-package@1.0.0: MIT");
  });
});
