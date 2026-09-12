import { describe, expect, it, vi } from "vitest";
import type { PawketDatabase } from "@pawket/database";
import { expireTipPaymentIntents } from "../src/tip-expiry.js";

describe("expiry scan policy", () => {
  const transaction = vi.fn();
  const input = { db: { transaction } as unknown as PawketDatabase, tips: { expireTip: vi.fn() }, paymentsMode: "disabled" as const, batchSize: 100, now: new Date("2026-09-12T00:00:00Z"), applicationRevision: "test-revision" };
  it("does not touch dependencies when disabled", async () => {
    expect(await expireTipPaymentIntents(input)).toEqual({ scanned: 0, expired: 0 }); expect(transaction).not.toHaveBeenCalled(); expect(input.tips.expireTip).not.toHaveBeenCalled();
  });
  it.each([0, -1, 501, 1.5, NaN])("rejects an invalid batch bound %s before accessing storage", async (batchSize) => {
    await expect(expireTipPaymentIntents({ ...input, batchSize })).rejects.toMatchObject({ code: "invalid_request" }); expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects invalid clock or revision metadata", async () => {
    await expect(expireTipPaymentIntents({ ...input, now: new Date(NaN) })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(expireTipPaymentIntents({ ...input, applicationRevision: "unsafe\nrevision" })).rejects.toMatchObject({ code: "invalid_request" }); expect(transaction).not.toHaveBeenCalled();
  });
});
