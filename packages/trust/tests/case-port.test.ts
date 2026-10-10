import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { PawketTransaction } from "@pawket/database";
import { createTrustCasePort } from "../src/case-port.js";

const port = createTrustCasePort();
type Open = Parameters<typeof port.openCase>[1];
const command: Open = { kind: "report", sourceType: "commission_package", orderId: null, sourceId: randomUUID(),
  policyRevisionId: null, requestId: "synthetic-request", at: new Date("2026-10-10T04:00:00Z") };
test.each([
  { orderId: randomUUID() }, { kind: "dispute", sourceType: "commission_dispute" },
  { kind: "refund_not_received", sourceType: "commission_refund_obligation" }, { kind: "refund_overdue", sourceType: "commission_refund_obligation" },
  { kind: "late_payment", sourceType: "commission_late_payment_claim" },
  { sourceType: "commission_brief" }, { sourceType: "commission_message" }, { sourceType: "commission_file" },
  { kind: "appeal" }, { sourceType: "trust_appeal" }, { communityPolicyRevisionId: "bad" }, { enforcementPolicyRevisionId: "bad" },
  { kind: "appeal", sourceType: "trust_appeal", orderId: "bad" },
])("openCase refuses invalid kind/source/order/policy combination %# before writes", async (change) => {
  const tx = { insert: vi.fn() };
  await expect(port.openCase(tx as unknown as PawketTransaction, { ...command, ...change } as Open)).rejects.toMatchObject({ code: "invalid_request" });
  expect(tx.insert).not.toHaveBeenCalled();
});
