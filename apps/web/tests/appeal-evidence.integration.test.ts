import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createAppealService, createContentHideService, createTrustCasePort, createTrustCaseService } from "@pawket/trust";
import { createCaseEvidencePort } from "../src/platform/case-evidence.js";
import { createReportFixture, fixtureKeyring, reportAt } from "../../../packages/trust/tests/report-fixture.js";
import { penaltyContext } from "../../../packages/trust/tests/penalty-service-fixture.js";

const f = createReportFixture("web_appeal_evidence"); beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
async function setup() {
  const c = await penaltyContext(f);
  const locks: string[] = [];
  const appeals = createAppealService({ ...c.input, penalties: c.service, hides: createContentHideService(c.input),
    fence: { async lockCreatorFence(tx, userId) { locks.push(`fence:${userId}`); await c.input.fence.lockCreatorFence(tx, userId); } },
    identity: { async lockSubject(tx, userId) { locks.push(`subject:${userId}`); return c.identity.lockSubject(tx, userId); } } });
  const orders = { readOrderForCase: vi.fn().mockResolvedValue({ id: c.p.orderId, brief: { text: "Original brief" }, referenceFiles: [] }),
    readThreadForCase: vi.fn().mockResolvedValue({ items: [{ kind: "message", id: "original-message", files: [] }] }) };
  const refunds = { listForOrder: vi.fn().mockResolvedValue([]), revealForCase: vi.fn().mockResolvedValue({ accountNumber: "Synthetic account" }) };
  const view = { readForCase: vi.fn().mockResolvedValue({ disputes: [{ statement: "Original statement" }] }) };
  const catalog = { readRevisionForCase: vi.fn().mockResolvedValue({ title: "Original package" }) };
  const port = createCaseEvidencePort({ orders, refunds, view, catalog, files: { caseDownloadGrant: vi.fn() }, keyring: fixtureKeyring });
  const service = createTrustCaseService({ ...c.input, evidence: port });
  async function submit(penaltyId: string) {
    return appeals.submit({ appellant: { kind: "session", actor: c.p.creator }, target: { penaltyId }, statement: "Private appeal statement", idempotencyKey: randomUUID(), requestId: randomUUID() });
  }
  async function read(caseId: string) {
    const proof = await c.base("owner.case_evidence");
    return service.readEvidence({ owner: c.owner, stepUpProofId: proof.stepUpProofId, requestId: proof.requestId, caseId, section: "appeal_source" });
  }
  return { ...c, appeals, orders, refunds, view, catalog, cases: service, read, submit, locks };
}
test("appeal evidence reuses original resolved dispute section readers and logs only appeal access", async () => {
  const c = await setup(); const penalty = await c.service.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  await f.db.transaction((tx) => createTrustCasePort().resolveCase(tx, { caseId: c.caseId, actor: c.owner, reason: null, requestId: randomUUID(), at: reportAt, resolutionKind: "withdrawn" }));
  const appealed = await c.submit(penalty.penaltyId);
  expect(await c.read(appealed.caseId)).toMatchObject({ appeal: { statement: "Private appeal statement" }, source: { caseId: c.caseId, state: "resolved" },
    sections: { order_summary: { id: c.p.orderId }, thread_page: { items: [{ id: "original-message" }] }, resolution_records: { disputes: [{ statement: "Original statement" }] } } });
  for (const reader of [c.orders.readOrderForCase, c.orders.readThreadForCase, c.view.readForCase, c.refunds.listForOrder]) expect(reader).toHaveBeenCalledOnce();
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, c.caseId))).toEqual([]);
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, appealed.caseId))).toMatchObject([{ itemType: "appeal_source", itemId: appealed.caseId }]);
  await c.appeals.decide({ ...await c.base("owner.trust_appeal_decide"), caseId: appealed.caseId, expectedCaseVersion: 1, decision: "upheld", reasoning: "Decision" });
  await expect(c.read(appealed.caseId)).rejects.toMatchObject({ code: "not_available" });
  expect(c.orders.readOrderForCase).toHaveBeenCalledOnce();
});

test.each(["refund_not_received", "refund_overdue"] as const)("appeal over %s never reveals the refund destination", async (kind) => {
  const c = await setup();
  const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind, orderId: c.p.orderId, sourceType: "commission_refund_obligation", sourceId: randomUUID(), policyRevisionId: null, requestId: randomUUID(), at: reportAt }));
  c.refunds.revealForCase.mockResolvedValue({ accountNumber: "123456789012", holderName: "Private synthetic holder" });
  c.refunds.listForOrder.mockResolvedValue([{ bankName: "Synthetic bank", suffix: "•••• 9012" }]);
  const penalty = await c.service.apply({ ...await c.command(), source: { caseId }, kind: "restriction", restriction: "reporting" });
  const appeal = await c.submit(penalty.penaltyId); const evidence = await c.read(appeal.caseId);
  expect(evidence).toMatchObject({ sections: { resolution_records: { refunds: [{ bankName: "Synthetic bank", suffix: "•••• 9012" }] } } });
  expect(c.refunds.revealForCase).not.toHaveBeenCalled();
  expect(JSON.stringify(evidence)).not.toMatch(/refund_destination|accountNumber|holderName|123456789012|Private synthetic holder/u);
});
test("orderless package appeal reads original report/package sections without order readers or reporter identity", async () => {
  const c = await setup();
  c.catalog.readRevisionForCase.mockResolvedValue({ title: "Original package", reporterEmail: "synthetic-reporter@example.invalid",
    metadata: [{ reporterIdentity: { displayName: "Synthetic reporter" } }] });
  const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "report", orderId: null, sourceType: "commission_package", sourceId: c.p.packageId, policyRevisionId: null, requestId: randomUUID(), at: reportAt }));
  await f.db.insert(schema.trustReports).values({ id: randomUUID(), reportReference: `report:v2:${randomUUID().replaceAll("-", "")}`, targetKind: "commission_package", targetId: c.p.packageId, packageRevisionId: c.p.packageRevisionId,
    contentOwnerUserId: c.p.creator.userId, reporterUserId: c.p.buyer.userId, reason: "other", caseId, createdAt: reportAt });
  const { hideId } = await createContentHideService(c.input).hide({ ...await c.base("owner.trust_hide"), caseId, expectedCaseVersion: 1, reason: "Original hide" });
  const appealed = await c.appeals.submit({ appellant: { kind: "session", actor: c.p.creator }, target: { hideId }, statement: "Private package appeal", idempotencyKey: randomUUID(), requestId: randomUUID() });
  const evidence = await c.read(appealed.caseId);
  expect(evidence).toMatchObject({ action: { hideId, reason: "Original hide" }, sections: { report_context: { revision: { title: "Original package" } }, package_revision: { title: "Original package" } } });
  expect(c.orders.readOrderForCase).not.toHaveBeenCalled(); expect(c.orders.readThreadForCase).not.toHaveBeenCalled();
  expect(c.catalog.readRevisionForCase.mock.calls.every((call) => call[1] === c.p.packageRevisionId)).toBe(true);
  expect(JSON.stringify(evidence)).not.toContain(c.p.buyer.userId);
  expect(JSON.stringify(evidence)).not.toMatch(/reporter/iu);
  c.locks.length = 0;
  await c.appeals.decide({ ...await c.base("owner.trust_appeal_decide"), caseId: appealed.caseId, expectedCaseVersion: 1, decision: "reversed", reasoning: "Restore" });
  expect(c.locks).toEqual([`fence:${c.p.creator.userId}`, `subject:${c.p.creator.userId}`]);
});
