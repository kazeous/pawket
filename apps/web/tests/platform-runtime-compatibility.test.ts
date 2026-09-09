import { expect, test } from "vitest";

import { getIdentityRuntime } from "../src/auth/runtime.js";
import { getPlatformRuntime } from "../src/platform/runtime.js";

test("the legacy identity runtime is the exact platform composition-root export", () => {
  // Catches a second singleton composition being reintroduced under auth/runtime.
  expect(getIdentityRuntime).toBe(getPlatformRuntime);
});
