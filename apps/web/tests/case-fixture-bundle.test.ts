import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { buildCaseFixture } from "./case-fixture-build";

test("case fixture initializes without a Node process global", async () => {
  const bundle = await buildCaseFixture();
  expect(() => runInNewContext(bundle, { setTimeout, clearTimeout, performance }, { timeout: 5_000 })).not.toThrow();
  expect(/\bprocess\.env\b/.test(bundle)).toBe(false);
}, 20_000);
