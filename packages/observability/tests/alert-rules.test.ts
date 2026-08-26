import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

const rulesUrl = new URL("../../../ops/alerts/pawket.rules.yml", import.meta.url);
const ruleTestsUrl = new URL("../../../ops/alerts/pawket.rules.test.yml", import.meta.url);
const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((complete) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => complete({ code, stdout, stderr }));
  });
}

async function fakeDocker() {
  const directory = await mkdtemp(join(tmpdir(), "pawket-promtool-"));
  const log = join(directory, "calls.jsonl");
  const implementation = join(directory, "fake-docker.mjs");
  await writeFile(
    implementation,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { basename } from "node:path";',
      'const preloadedWindowsDocker = basename(process.execPath).toLowerCase() === "docker.exe";',
      'if (preloadedWindowsDocker || process.env.PAWKET_FAKE_DOCKER_MAIN === "1") {',
      'const args = process.argv.slice(preloadedWindowsDocker ? 1 : 2);',
      'if (preloadedWindowsDocker) args[0] = basename(args[0]);',
      'appendFileSync(process.env.PAWKET_FAKE_DOCKER_LOG, `${JSON.stringify(args)}\\n`);',
      'const failOn = Number(process.env.PAWKET_FAKE_DOCKER_FAIL_ON ?? "0");',
      'const call = readFileSync(process.env.PAWKET_FAKE_DOCKER_LOG, "utf8").trim().split("\\n").length;',
      'if (failOn === call) process.exit(23);',
      'process.exit(0);',
      '}',
    ].join("\n"),
    "utf8",
  );
  let nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (process.platform === "win32") {
    await copyFile(process.execPath, join(directory, "docker.exe"));
    nodeOptions = `${nodeOptions} --import=${pathToFileURL(implementation).href}`.trim();
  } else {
    const wrapper = join(directory, "docker");
    await writeFile(wrapper, `#!/bin/sh\nPAWKET_FAKE_DOCKER_MAIN=1 exec "${process.execPath}" "${implementation}" "$@"\n`, {
      encoding: "utf8",
      mode: 0o755,
    });
  }
  return { directory, log, nodeOptions };
}

describe("Pawket alert rules", () => {
  test("use safe labels and link existing runbooks", async () => {
    const source = await readFile(rulesUrl, "utf8");
    const alerts = [...source.matchAll(/^      - alert: ([A-Za-z][A-Za-z0-9]+)$/gmu)];
    const expressions = [...source.matchAll(/^        expr: (.+)$/gmu)];
    const severities = [...source.matchAll(/^          severity: (warning|critical)$/gmu)];
    const runbooks = [...source.matchAll(/^          runbook: (ops\/runbooks\/[a-z0-9-]+[.]md)$/gmu)];
    expect(alerts.length).toBeGreaterThanOrEqual(13);
    expect(expressions).toHaveLength(alerts.length);
    expect(severities).toHaveLength(alerts.length);
    expect(runbooks).toHaveLength(alerts.length);
    expect(new Set(alerts.map((match) => match[1])).size).toBe(alerts.length);
    for (const [, expression] of expressions) {
      expect(expression).not.toMatch(/email=|user_id|request_id|revision=|account=|subject=/iu);
      expect(expression).not.toMatch(/[{}][^}]*=~[^}]*[}]/u);
    }
    for (const [, runbook] of runbooks) {
      await expect(
        access(new URL(`../../../${runbook}`, import.meta.url)),
      ).resolves.toBeUndefined();
    }
  });

  test("validates rules and fixtures through the pinned promtool image in order", async () => {
    // Catches CI only inspecting YAML text instead of executing both promtool modes.
    const fake = await fakeDocker();
    try {
      const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "corepack";
      const args = process.platform === "win32"
        ? ["/d", "/s", "/c", "corepack pnpm alerts:validate"]
        : ["pnpm", "alerts:validate"];
      const result = await run(command, args, {
        ...process.env,
        PATH: `${fake.directory}${delimiter}${process.env.PATH ?? ""}`,
        PAWKET_FAKE_DOCKER_LOG: fake.log,
        NODE_OPTIONS: fake.nodeOptions,
      });
      expect(result.code, result.stderr).toBe(0);
      const calls = (await readFile(fake.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(2);
      const image =
        "prom/prometheus:v3.14.0@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0";
      expect(calls[0]).toEqual([
        "run",
        "--rm",
        "--mount",
        expect.stringMatching(/^type=bind,source=.+[\\/]ops[\\/]alerts,target=\/rules,readonly$/u),
        "--entrypoint",
        "promtool",
        image,
        "check",
        "rules",
        "/rules/pawket.rules.yml",
      ]);
      expect(calls[1]).toEqual([
        "run",
        "--rm",
        "--mount",
        expect.stringMatching(/^type=bind,source=.+[\\/]ops[\\/]alerts,target=\/rules,readonly$/u),
        "--entrypoint",
        "promtool",
        image,
        "test",
        "rules",
        "/rules/pawket.rules.test.yml",
      ]);
      await expect(access(ruleTestsUrl)).resolves.toBeUndefined();
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });

  test("rejects caller paths and propagates the first promtool failure", async () => {
    // Catches an overrideable mount or a validator that hides Docker failures.
    const fake = await fakeDocker();
    try {
      const nodeResult = await run(
        process.execPath,
        ["scripts/validate-prometheus-rules.mjs", "C:\\untrusted-rules"],
        {
          ...process.env,
          PATH: `${fake.directory}${delimiter}${process.env.PATH ?? ""}`,
          PAWKET_FAKE_DOCKER_LOG: fake.log,
          NODE_OPTIONS: fake.nodeOptions,
        },
      );
      expect(nodeResult.code).not.toBe(0);
      await expect(access(fake.log)).rejects.toThrow();

      const failed = await run(process.execPath, ["scripts/validate-prometheus-rules.mjs"], {
        ...process.env,
        PATH: `${fake.directory}${delimiter}${process.env.PATH ?? ""}`,
        PAWKET_FAKE_DOCKER_LOG: fake.log,
        PAWKET_FAKE_DOCKER_FAIL_ON: "1",
        NODE_OPTIONS: fake.nodeOptions,
      });
      expect(failed.code).toBe(23);
      const calls = (await readFile(fake.log, "utf8")).trim().split("\n");
      expect(calls).toHaveLength(1);
    } finally {
      await rm(fake.directory, { recursive: true, force: true });
    }
  });
});
