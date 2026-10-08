import { expect, test, vi } from "vitest";
import type { PawketDatabase } from "@pawket/database";
import { createTrustCaseService, type TrustCaseEvidencePort } from "../src/case-service.js";
const row = { id: "10000000-0000-4000-8000-000000000001", kind: "dispute", orderId: "10000000-0000-4000-8000-000000000002",
  sourceType: "commission_dispute", sourceId: "10000000-0000-4000-8000-000000000003", state: "open", resolutionKind: null,
  policyRevisionId: null, openedAt: new Date("2026-10-08T00:00:00Z"), resolvedAt: null, version: 1 };
test("queue enriches timestamps through a structural port without any evidence, proof or writes", async () => {
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn(async () => [row]) };
  const db = { select: vi.fn(() => query), insert: vi.fn(), transaction: vi.fn() };
  const deadlines = { nextDeadlines: vi.fn(async () => new Map([[row.id, new Date("2026-10-13T00:00:00Z")]])) };
  const evidence = { orderSummary: vi.fn(), threadPage: vi.fn(), resolutionRecords: vi.fn(), refundDestination: vi.fn(), fileGrant: vi.fn() };
  const consumeStepUpProof = vi.fn();
  const service = createTrustCaseService({ db: db as unknown as PawketDatabase, applicationRevision: "synthetic-test", deadlines,
    consumeStepUpProof, evidence: evidence as TrustCaseEvidencePort });
  expect((await service.listQueue())[0]?.nextDeadline).toBe("2026-10-13T00:00:00.000Z");
  expect(deadlines.nextDeadlines).toHaveBeenCalledWith(db, [expect.objectContaining({ caseId: row.id })]);
  expect(db.insert).not.toHaveBeenCalled(); expect(consumeStepUpProof).not.toHaveBeenCalled();
  for (const read of Object.values(evidence)) expect(read).not.toHaveBeenCalled();
});
test("queue has a null deadline without a port", async () => {
  const query = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [row] };
  const service = createTrustCaseService({ db: { select: () => query } as unknown as PawketDatabase, applicationRevision: "synthetic-test",
    consumeStepUpProof: vi.fn(), evidence: {} as TrustCaseEvidencePort });
  expect((await service.listQueue())[0]?.nextDeadline).toBeNull();
});
