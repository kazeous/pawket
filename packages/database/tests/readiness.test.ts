import { describe, expect, it } from "vitest";

import { createDatabaseReadinessCheck } from "../src/readiness.js";

describe("database readiness check", () => {
  it("destroys a stalled client before rejecting an aborted check", async () => {
    let destroyed = false;
    const controller = new AbortController();
    const check = createDatabaseReadinessCheck("postgresql://localhost/pawket", {
      createClient: () => ({
        unsafe: () => new Promise<void>(() => undefined),
        end: async () => {
          destroyed = true;
        },
      }),
    });

    const checkPromise = check(controller.signal);
    controller.abort();

    await expect(checkPromise).rejects.toThrow("aborted");
    expect(destroyed).toBe(true);
  });
});
