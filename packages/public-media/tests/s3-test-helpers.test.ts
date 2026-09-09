import { describe, expect, test, vi } from "vitest";

import { runCleanupSteps } from "./s3-test-helpers.js";

describe("test cleanup failure preservation", () => {
  test("keeps the primary assertion failure authoritative while attempting every cleanup", async () => {
    const laterCleanup = vi.fn(async () => undefined);

    await expect(runCleanupSteps(true, [async () => { throw new Error("cleanup failed"); }, laterCleanup])).resolves.toBeUndefined();
    expect(laterCleanup).toHaveBeenCalledOnce();
  });

  test("surfaces the first cleanup failure when the test body succeeded", async () => {
    const laterCleanup = vi.fn(async () => undefined);

    await expect(runCleanupSteps(false, [async () => { throw new Error("cleanup failed"); }, laterCleanup])).rejects.toThrow("cleanup failed");
    expect(laterCleanup).toHaveBeenCalledOnce();
  });
});
