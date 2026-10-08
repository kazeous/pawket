import type { CaseDetailView, CaseQueueRow } from "../src/ui/cases/case-client";
export const ownerId = "synthetic-owner";
export const caseId = "10000000-0000-4000-8000-000000000001";
export const fileId = "10000000-0000-4000-8000-000000000002";
export const caseFixture: CaseDetailView = { caseId, orderId: caseId, sourceId: caseId, sourceType: "commission_dispute", kind: "dispute", state: "open", resolutionKind: null,
  policyRevisionId: caseId, version: 1, openedAt: "2026-10-07T00:00:00.000Z", resolvedAt: null, creatorStanding: "suspended", creatorUserId: "synthetic-creator", buyerUserId: "synthetic-buyer",
  orderState: "in_progress", amountVnd: 500_000, disputeOpenedAt: "2026-10-07T00:00:00.000Z", respondBy: "2026-10-12T00:00:00.000Z", ruling: null,
  events: [{ id: caseId, action: "opened", reason: null, fromState: null, toState: "open", occurredAt: "2026-10-07T00:00:00.000Z", resultingVersion: 1 }], accessLog: [] };
export const queueFixture: CaseQueueRow = { ...caseFixture, nextDeadline: "2026-10-12T00:00:00.000Z" };
