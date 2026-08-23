import { describe, expect, it } from "vitest";

import { getRequestContext, withRequestContext } from "../src/index.js";

describe("request context", () => {
  it("returns undefined outside an installed context", () => {
    // Catches ambient state that survives after a request has finished.
    expect(getRequestContext()).toBeUndefined();
  });

  it("makes the current request available through nested asynchronous operations", async () => {
    // Catches async propagation that loses the outer context or fails to restore it after nesting.
    const outerContext = { requestId: "request-outer" };
    const nestedContext = { requestId: "request-nested", actorId: "actor-demo" };

    await withRequestContext(outerContext, async () => {
      await Promise.resolve();
      expect(getRequestContext()).toEqual(outerContext);

      await withRequestContext(nestedContext, async () => {
        await Promise.resolve();
        expect(getRequestContext()).toEqual(nestedContext);
      });

      expect(getRequestContext()).toEqual(outerContext);
    });
  });

  it("keeps concurrent request IDs isolated", async () => {
    // Catches a shared mutable context that lets one overlapping request overwrite another.
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = withRequestContext({ requestId: "request-first" }, async () => {
      await firstReady;
      return getRequestContext()?.requestId;
    });
    const second = withRequestContext({ requestId: "request-second" }, async () => {
      await secondReady;
      return getRequestContext()?.requestId;
    });

    releaseSecond?.();
    releaseFirst?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "request-first",
      "request-second",
    ]);
  });
});
