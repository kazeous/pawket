import { expect, test, vi } from "vitest";
import type { PawketDatabase, PawketTransaction } from "@pawket/database";
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

type Section = Parameters<ReturnType<typeof createTrustCaseService>["readEvidence"]>[0]["section"];
function evidenceService(caseRow: { kind: string; sourceType: string; orderId: string | null }, extras: Partial<TrustCaseEvidencePort> = {}) {
  const query = { from: () => query, where: () => query, limit: () => query, for: async () => [{ ...row, ...caseRow }] };
  const tx = { select: () => query, insert: vi.fn() };
  const db = { transaction: async (run: (tx: PawketTransaction) => unknown) => run(tx as unknown as PawketTransaction) };
  const evidence = { orderSummary: vi.fn(), threadPage: vi.fn(), resolutionRecords: vi.fn(), refundDestination: vi.fn(), fileGrant: vi.fn(), ...extras };
  const consumeStepUpProof = vi.fn(async () => true);
  return { tx, evidence, consumeStepUpProof, service: createTrustCaseService({ db: db as unknown as PawketDatabase,
    applicationRevision: "synthetic-test", evidence, consumeStepUpProof }) };
}
const command = (section: Section) => ({ owner: { userId: "owner", sessionId: "session" }, stepUpProofId: "proof", caseId: row.id, requestId: "request", section });

test.each(["report", "appeal"] as const)("queue accepts kind %s with nullable order metadata", async (kind) => {
  const caseRow = { ...row, kind, orderId: null };
  const query = { from: () => query, where: () => query, orderBy: () => query, limit: async () => [caseRow] };
  const service = createTrustCaseService({ db: { select: () => query } as unknown as PawketDatabase, applicationRevision: "synthetic-test",
    consumeStepUpProof: vi.fn(), evidence: {} as TrustCaseEvidencePort });
  expect(await service.listQueue({ kind })).toEqual([expect.objectContaining({ kind, orderId: null, nextDeadline: null })]);
});

test.each(["order_summary", "thread_page", "resolution_records"] as const)("%s refuses a null order without reading evidence or consuming proof", async (section) => {
  const s = evidenceService({ kind: "report", sourceType: "commission_package", orderId: null });
  await expect(s.service.readEvidence(command(section))).rejects.toMatchObject({ code: "not_available" });
  expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(s.tx.insert).not.toHaveBeenCalled();
  for (const read of Object.values(s.evidence)) expect(read).not.toHaveBeenCalled();
});
test("file grant refuses a null order without reading evidence or consuming proof", async () => {
  const s = evidenceService({ kind: "appeal", sourceType: "trust_appeal", orderId: null });
  const read = command("order_summary");
  await expect(s.service.fileGrant({ owner: read.owner, stepUpProofId: read.stepUpProofId, caseId: read.caseId, requestId: read.requestId,
    fileId: row.sourceId, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
  expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(s.evidence.fileGrant).not.toHaveBeenCalled(); expect(s.tx.insert).not.toHaveBeenCalled();
});
test.each([
  ["report_context", "report", "commission_package"], ["package_revision", "report", "commission_package"],
  ["brief", "report", "commission_brief"], ["appeal_source", "appeal", "trust_appeal"],
] as const)("optional %s port returns not_available when absent", async (section, kind, sourceType) => {
  const s = evidenceService({ kind, sourceType, orderId: sourceType === "commission_brief" ? row.orderId : null });
  await expect(s.service.readEvidence(command(section))).rejects.toMatchObject({ code: "not_available" });
  expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(s.tx.insert).not.toHaveBeenCalled();
});
test.each([
  ["report_context", "dispute", "commission_dispute"], ["package_revision", "report", "commission_message"],
  ["package_revision", "appeal", "trust_appeal"], ["brief", "report", "commission_file"],
  ["brief", "dispute", "commission_dispute"], ["appeal_source", "report", "commission_package"],
] as const)("%s refuses incompatible kind %s / source %s", async (section, kind, sourceType) => {
  const reader = vi.fn(); const s = evidenceService({ kind, sourceType, orderId: row.orderId },
    { reportContext: reader, packageRevision: reader, brief: reader, appealSource: reader });
  await expect(s.service.readEvidence(command(section))).rejects.toMatchObject({ code: "not_available" });
  expect(reader).not.toHaveBeenCalled(); expect(s.consumeStepUpProof).not.toHaveBeenCalled(); expect(s.tx.insert).not.toHaveBeenCalled();
});
