import { describe, expect, test } from "vitest";
import { COMMISSION_POST_PAYMENT_CLOSE_REASONS } from "@pawket/database";
import { CommissionError, requireCommissionTransition } from "../src/index.js";

describe("post-payment commission closes", () => {
  for (const reason of COMMISSION_POST_PAYMENT_CLOSE_REASONS) {
    test.each(["in_progress", "delivered"] as const)(`allows %s to close with ${reason}`, (from) => {
      expect(() => requireCommissionTransition(from, "closed", reason)).not.toThrow();
    });
    test.each(["requested", "quoted", "awaiting_payment", "completed", "closed"] as const)(`refuses %s to close with ${reason}`, (from) => {
      expect(() => requireCommissionTransition(from, "closed", reason)).toThrow(new CommissionError("invalid_transition"));
    });
  }
});
