import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDirectory = path.join(repositoryRoot, ".docker-context-regression");

const sensitiveFixtures = [
  "raw-dump.sql",
  "database.bak",
  "settings.local",
  "api.secret",
  "credentials.json",
  "service-account-review.json",
  "firebase-adminsdk-review.json",
  "signing.jks",
  "signing.keystore",
  "profile.mobileprovision",
  "deployment.coolify-export",
  "coolify/export.json",
  "coolify-exports/export.json",
];

if (process.cwd() !== repositoryRoot) {
  console.error("Docker context validation must run from the repository root.");
  process.exitCode = 1;
} else {
  let fixtureDirectoryCreated = false;

  try {
    mkdirSync(fixtureDirectory, { recursive: false });
    fixtureDirectoryCreated = true;
    writeFileSync(path.join(fixtureDirectory, "ordinary.txt"), "context canary\n", "utf8");

    for (const relativePath of sensitiveFixtures) {
      const fixturePath = path.join(fixtureDirectory, relativePath);
      mkdirSync(path.dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, "sensitive context sentinel\n", "utf8");
    }

    const assertions = sensitiveFixtures
      .map((relativePath) => `test ! -e /context/.docker-context-regression/${relativePath}`)
      .join(" && \\\n    ");
    const dockerfile = `FROM node:24.16.0-bookworm-slim
COPY . /context
RUN test -f /context/.docker-context-regression/ordinary.txt && \\
    ${assertions} && \\
    test -f /context/packages/database/migrations/0000_system-outbox.sql
`;
    const result = spawnSync(
      "docker",
      [
        "buildx",
        "build",
        "--no-cache",
        "--progress=plain",
        "--output",
        "type=cacheonly",
        "--file",
        "-",
        ".",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        input: dockerfile,
        windowsHide: true,
      },
    );

    if (result.error) {
      console.error(`Docker context validation could not run Buildx: ${result.error.message}`);
      process.exitCode = 1;
    } else if (result.status !== 0) {
      console.error("Docker context validation found excluded files in the build context.");
      if (result.stderr.trim()) {
        console.error(result.stderr.trim());
      }
      process.exitCode = result.status ?? 1;
    } else {
      console.log("Docker context validation passed.");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown fixture error";
    console.error(`Docker context validation could not create isolated fixtures: ${reason}`);
    process.exitCode = 1;
  } finally {
    if (fixtureDirectoryCreated) {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  }
}
