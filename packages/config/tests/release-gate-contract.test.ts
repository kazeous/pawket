import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/verify.yml"), "utf8");
const gitleaksIgnore = readFileSync(path.join(repositoryRoot, ".gitleaksignore"), "utf8")
  .replace(/\r\n?/gu, "\n")
  .trim();

function indexOfRequired(text: string): number {
  const index = workflow.indexOf(text);
  expect(index, `missing release-gate contract: ${text}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("release-gate workflow contract", () => {
  it("checks out the full history before the security scan", () => {
    // Catches shallow checkout hiding historical credentials from the required Gitleaks scan.
    expect(workflow).toMatch(/uses: actions\/checkout@v4\s+with:\s+fetch-depth: 0/u);
  });

  it("runs the Docker context and installed Chromium browser checks", () => {
    // Catches releasing a context leak or skipping the existing Playwright assertions in CI.
    const dockerContext = indexOfRequired("run: corepack pnpm docker:context:validate");
    const chromiumInstall = indexOfRequired("run: corepack pnpm exec playwright install --with-deps chromium");
    const browserTests = indexOfRequired("run: corepack pnpm test:browser");

    expect(chromiumInstall).toBeLessThan(browserTests);
    expect(dockerContext).toBeLessThan(browserTests);
  });

  it("runs the pinned advisory, license-metadata, and full-history secret gates", () => {
    // Catches silently weakening supply-chain gates or replacing the approved pinned Gitleaks image.
    indexOfRequired("run: corepack pnpm audit --prod --audit-level high");
    indexOfRequired("run: corepack pnpm licenses:validate");
    indexOfRequired(
      "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
    );
    indexOfRequired("--log-opts=--all");
  });

  it("suppresses only the three reviewed historical Valkey image-tag false positives", () => {
    // Catches broad secret-scan suppression that could conceal unrelated history findings.
    expect(gitleaksIgnore).toBe(
      [
        "c53e58de35e682c1d9b0a1576568cf11052228ea:.github/workflows/verify.yml:generic-api-key:47",
        "ff07c189689698d88c8d93640ca60c83a6ee16cd:compose.prod.yaml:generic-api-key:19",
        "94db6cb9033c9e769b119d1043208cdef00e283a:compose.dev.yaml:generic-api-key:20",
      ].join("\n"),
    );
  });
});
