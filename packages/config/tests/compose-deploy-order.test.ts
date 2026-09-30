import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const compose = readFileSync(new URL("../../../compose.prod.yaml", import.meta.url), "utf8").split(/\r?\n/u);

function serviceBlock(name: string): string[] {
  const start = compose.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`compose.prod.yaml has no ${name} service`);
  const end = compose.findIndex((line, index) => index > start && /^ {0,2}\S/u.test(line));
  return compose.slice(start + 1, end < 0 ? undefined : end);
}

function dependencies(name: string): Record<string, string> {
  const block = serviceBlock(name); const start = block.indexOf("    depends_on:");
  const result: Record<string, string> = {}; let current: string | undefined;
  if (start < 0) return result;
  for (const line of block.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    const service = /^ {6}([a-z0-9_-]+):$/u.exec(line); const condition = /^ {8}condition: (\S+)$/u.exec(line);
    if (service) current = service[1]; else if (condition && current) result[current] = condition[1]!;
  }
  return result;
}

// Coolify removes every old container before `docker compose up`, so this ordering is what keeps a
// new web from taking requests before the new worker is ready (ops/runbooks/commission-operations.md).
describe("production deploy order", () => {
  test("web starts only after migrations and a healthy worker of the same deploy", () => {
    expect(dependencies("web")).toEqual({
      migrate: "service_completed_successfully", postgres: "service_healthy", valkey: "service_healthy", worker: "service_healthy",
    });
  });
  test("the worker can become healthy without the web", () => {
    expect(dependencies("worker")).not.toHaveProperty("web");
    expect(serviceBlock("worker")).toContain("    healthcheck:");
  });
});
