import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  incrementThreeStorageEnvironment,
  resolveIncrementThreeStorageFixture,
} from "../../../apps/web/tests/increment-three-environment";

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

function releaseGateEnvironment(): Record<string, string> {
  const block = workflow.match(/\n    env:\r?\n(?<body>(?:      [A-Z0-9_]+:.*\r?\n)+)    services:/u)
    ?.groups?.body;
  expect(block, "release-gate environment block is missing").toBeDefined();
  return Object.fromEntries(
    block!
      .trimEnd()
      .split(/\r?\n/u)
      .map((line) => {
        const match = line.match(/^\s{6}([A-Z0-9_]+):\s*(.*)$/u);
        if (!match) throw new Error("Release-gate environment entry is malformed");
        return [match[1]!, match[2]!.replace(/^(['"])(.*)\1$/u, "$2")];
      }),
  );
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

  it("uses one synthetic S3Mock fixture and exact candidate revision for browser and ARM64 gates", () => {
    // Catches CI setup/runtime bucket divergence, skipped S3Mock, or artifact builds detached from the candidate SHA.
    const environment = releaseGateEnvironment();
    const storage = resolveIncrementThreeStorageFixture(environment);
    expect(incrementThreeStorageEnvironment(storage)).toEqual({
      PUBLIC_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9090",
      PUBLIC_MEDIA_S3_REGION: "us-east-1",
      PUBLIC_MEDIA_S3_ACCESS_KEY_ID: "ci-media-access-key",
      PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY: "ci-media-secret-key",
      PUBLIC_MEDIA_QUARANTINE_BUCKET: "pawket-ci-media-quarantine",
      PUBLIC_MEDIA_DERIVATIVE_BUCKET: "pawket-ci-media-derivatives",
      PUBLIC_MEDIA_S3_FORCE_PATH_STYLE: "true",
    });
    const candidateRevision = "${{ github.event.pull_request.head.sha || github.sha }}";
    expect(environment.PAWKET_BROWSER_APP_REVISION).toBe(candidateRevision);
    indexOfRequired(`ref: ${candidateRevision}`);
    indexOfRequired('test "$(git rev-parse HEAD)" = "$PAWKET_BROWSER_APP_REVISION"');
    indexOfRequired('git merge-base --is-ancestor "$PAWKET_PR_BASE_REVISION" HEAD');
    expect(environment.PAWKET_PR_BASE_REVISION).toBe("${{ github.event.pull_request.base.sha }}");
    expect(environment.CREATOR_PUBLISHING_MODE).toBe("disabled");
    expect(environment.TIP_PAYMENTS_MODE).toBe("disabled");
    expect(environment.PUBLIC_MEDIA_RETENTION_MODE).toBe("report_only");
    indexOfRequired("image: adobe/s3mock:5.2.0");
    indexOfRequired("run: corepack pnpm increment-three:validate");
    expect(workflow.match(/--build-arg SOURCE_COMMIT="\$PAWKET_BROWSER_APP_REVISION"/gu)).toHaveLength(3);
    indexOfRequired("run: corepack pnpm test:browser:increment-four");
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

  it("suppresses only reviewed historical image-tag and synthetic idempotency-key false positives", () => {
    // Catches broad secret-scan suppression that could conceal unrelated history findings.
    expect(gitleaksIgnore).toBe(
      [
        "c53e58de35e682c1d9b0a1576568cf11052228ea:.github/workflows/verify.yml:generic-api-key:47",
        "ff07c189689698d88c8d93640ca60c83a6ee16cd:compose.prod.yaml:generic-api-key:19",
        "94db6cb9033c9e769b119d1043208cdef00e283a:compose.dev.yaml:generic-api-key:20",
        // Both findings are the fixed HTTP unit-test request key, not credentials.
        "4004a30b48f5e06674134be40b43530172186b1e:packages/admin/tests/tip-policy-http.test.ts:generic-api-key:20",
        "4004a30b48f5e06674134be40b43530172186b1e:packages/admin/tests/tip-policy-http.test.ts:generic-api-key:31",
      ].join("\n"),
    );
  });
});
