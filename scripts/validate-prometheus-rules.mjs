import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";

const PROMETHEUS_IMAGE =
  "prom/prometheus:v3.14.0@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0";

if (process.argv.length !== 2) {
  console.error("Prometheus rule validation does not accept caller-provided paths.");
  process.exit(2);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rulesDirectory = resolve(repositoryRoot, "ops", "alerts");
const rulesRelativeToRoot = relative(repositoryRoot, rulesDirectory);
if (
  rulesRelativeToRoot === "" ||
  rulesRelativeToRoot === ".." ||
  rulesRelativeToRoot.startsWith(`..${sep}`)
) {
  console.error("Prometheus rules directory is outside the repository.");
  process.exit(2);
}

const mount = `type=bind,source=${rulesDirectory},target=/rules,readonly`;
const commands = [
  ["check", "rules", "/rules/pawket.rules.yml"],
  ["test", "rules", "/rules/pawket.rules.test.yml"],
];

for (const command of commands) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      mount,
      "--entrypoint",
      "promtool",
      PROMETHEUS_IMAGE,
      ...command,
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.error) {
    console.error("Prometheus rule validation could not start Docker.");
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
