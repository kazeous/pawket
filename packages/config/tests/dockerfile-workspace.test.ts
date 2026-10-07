import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";

const repositoryRoot = new URL("../../../", import.meta.url);
const dockerfile = readFileSync(new URL("Dockerfile", repositoryRoot), "utf8");
const manifests = readdirSync(new URL("packages/", repositoryRoot), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`packages/${entry.name}/package.json`, repositoryRoot)))
  .map((entry) => `packages/${entry.name}/package.json`)
  .sort();

describe("Docker workspace installation", () => {
  test("copies every package manifest before the frozen-lockfile install", () => {
    const installAt = dockerfile.search(/^RUN pnpm install --frozen-lockfile\s*$/mu);
    expect(installAt).toBeGreaterThan(0);
    const copied = [...dockerfile.slice(0, installAt).matchAll(/^COPY (packages\/[^/\s]+\/package\.json) \1\s*$/gmu)]
      .map((match) => match[1])
      .sort();
    expect(copied).toEqual(manifests);
  });
});
