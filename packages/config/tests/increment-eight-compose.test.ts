import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const compose = readFileSync(new URL("../../../compose.prod.yaml", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const service = (name: string) => { const start = compose.indexOf(`\n  ${name}:\n`); const next = compose.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/u); return compose.slice(start, next < 0 ? undefined : start + 1 + next); };

describe("production compose for commission resolution", () => {
  test.each(["web", "worker"])("keeps %s resolution literally disabled", (name) => {
    expect(/^      COMMISSION_RESOLUTION_MODE: disabled$/mu.test(service(name))).toBe(true);
  });
});
