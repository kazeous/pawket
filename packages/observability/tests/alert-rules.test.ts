import { access, readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

const rulesUrl = new URL("../../../ops/alerts/pawket.rules.yml", import.meta.url);

describe("Pawket alert rules", () => {
  test("use the constrained Prometheus rule shape and link existing runbooks", async () => {
    const source = await readFile(rulesUrl, "utf8");
    expect(source).toMatch(/^groups:\n  - name: [a-z0-9-]+\n    rules:\n/u);
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
});
