import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createCommissionResolutionOrderPort } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort } from "@pawket/payments";
import { createRemovalFreezePort } from "@pawket/resolutions";
import { decryptSensitiveField } from "@pawket/security";
import { createAppealService } from "../src/appeal-service.js";
import { createTrustCasePort } from "../src/case-port.js";
import { createTrustCaseService } from "../src/case-service.js";
import { createContentHideService } from "../src/content-hide-service.js";
import { createContentHideReadPort } from "../src/content-hide-port.js";
import { createPenaltyService } from "../src/penalty-service.js";
import { createHelpLinkService } from "../src/help-link-service.js";
import { recordEnforcementModeTransition } from "../src/enforcement-deadlines.js";
import { createReportFixture, fixtureKeyring, reportAt } from "./report-fixture.js";
import { penaltyContext } from "./penalty-service-fixture.js";

const f = createReportFixture("appeals");
const communityId = randomUUID(); const enforcementId = randomUUID();
beforeAll(async () => {
  await f.initialize();
  for (const [id, kind] of [[communityId, "community_rules"], [enforcementId, "enforcement_appeals"]] as const) {
    await f.db.insert(schema.trustPolicyRevisions).values({ id, kind, revisionNumber: 1, document: "Synthetic policy", approvalKind: "synthetic",
      checksum: `sha256:${"a".repeat(64)}`, source: "appeal-tests", effectiveAt: reportAt, createdAt: reportAt });
    await f.db.insert(schema.trustPolicyCurrent).values({ kind, revisionId: id, updatedAt: reportAt });
  }
  await f.db.transaction((tx) => schema.importConfiguredBusinessCalendarVersion(tx, { version: "vn-banking-2026-v1", holidayDates: [] }));
}, 60_000);
afterAll(f.dispose, 30_000);
async function context(freeze?: Parameters<typeof penaltyContext>[1]) {
  const c = await penaltyContext(f, freeze); let at = reportAt;
  const now = () => at;
  const penalties = createPenaltyService({ ...c.input, now });
  const hides = createContentHideService({ ...c.input, now });
  const helpLinks = createHelpLinkService({ ...c.input, canonicalizeEmail: (email) => email, logger: { error: vi.fn() }, now });
  const input = { ...c.input, now, penalties, hides, helpLinks };
  const appeals = createAppealService(input);
  const submit = (target: { penaltyId: string } | { hideId: string }) => ({ appellant: { kind: "session" as const, actor: c.p.creator }, target,
    statement: "Private appeal e\u0301\nPlease reconsider", idempotencyKey: randomUUID(), requestId: randomUUID() });
  async function decide(caseId: string, decision: "upheld" | "reduced" | "reversed" = "reversed") {
    return { ...await c.base("owner.trust_appeal_decide"), caseId, expectedCaseVersion: 1, decision, reasoning: "Private reasoning e\u0301\nDecision" };
  }
  return { ...c, penalties, hides, helpLinks, input, appeals, submit, decide, time: (value: Date) => { at = value; } };
}

test("subject appeals suspension once; replay returns IDs; a second appeal is duplicate; strangers and warnings refuse", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  const command = c.submit(target); const result = await c.appeals.submit(command);
  expect(await c.appeals.submit({ ...command, requestId: randomUUID() })).toEqual(result);
  await expect(c.appeals.submit(c.submit(target))).rejects.toMatchObject({ code: "duplicate" });
  await expect(c.appeals.submit({ ...c.submit(target), appellant: { kind: "session", actor: c.p.buyer } })).rejects.toMatchObject({ code: "not_available" });
  const warning = await c.penalties.apply(await c.command());
  await expect(c.appeals.submit(c.submit(warning))).rejects.toMatchObject({ code: "invalid_request" });
  const [row] = await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, result.caseId));
  expect(row).toMatchObject({ kind: "appeal", sourceType: "trust_appeal", sourceId: result.appealId, orderId: c.p.orderId,
    communityPolicyRevisionId: communityId, enforcementPolicyRevisionId: enforcementId });
});

test("concurrent submissions serialize to one appeal and terminal actions remain unique forever", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  const results = await Promise.allSettled([c.appeals.submit(c.submit(target)), c.appeals.submit(c.submit(target))]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((r) => r.status === "rejected"); expect(rejected?.status === "rejected" && rejected.reason.code).toBe("duplicate");
  const success = results.find((r) => r.status === "fulfilled"); if (success?.status !== "fulfilled") throw new Error("Appeal did not submit");
  await c.appeals.decide(await c.decide(success.value.caseId, "upheld"));
  await expect(c.appeals.submit(c.submit(target))).rejects.toMatchObject({ code: "duplicate" });
});

test("appeal text uses 4000 code points and immutable rows require a complete terminal decision", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  for (const statement of ["😀".repeat(4001), "Invalid\rstatement", "Invalid\u0000statement"]) await expect(c.appeals.submit({ ...c.submit(target), statement })).rejects.toMatchObject({ code: "invalid_request" });
  const result = await c.appeals.submit({ ...c.submit(target), statement: "😀".repeat(4000) });
  const [row] = await f.db.select().from(schema.trustAppeals).where(eq(schema.trustAppeals.id, result.appealId));
  await expect(f.db.update(schema.trustAppeals).set({ state: "upheld", version: 2 }).where(eq(schema.trustAppeals.id, result.appealId))).rejects.toThrow();
  await expect(f.db.update(schema.trustAppeals).set({ submittedVia: "help_link" }).where(eq(schema.trustAppeals.id, result.appealId))).rejects.toThrow();
  expect(row?.state).toBe("open");
  await c.appeals.decide({ ...await c.decide(result.caseId, "upheld"), reasoning: "😀".repeat(4000) });
});

test("failed replacement atomically preserves original standing, appeal, case, proof and outbox", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  await c.penalties.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  const result = await c.appeals.submit(c.submit(target)); const command = { ...await c.decide(result.caseId, "reduced"), replacement: { kind: "restriction" as const, restriction: "reporting" as const, endsAt: null } };
  await expect(c.appeals.decide(command)).rejects.toMatchObject({ code: "duplicate" });
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, target.penaltyId)))[0]?.state).toBe("active");
  expect((await f.db.select().from(schema.trustAppeals).where(eq(schema.trustAppeals.id, result.appealId)))[0]?.state).toBe("open");
  expect((await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, result.caseId)))[0]?.state).toBe("open");
  expect((await f.db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, command.stepUpProofId)))[0]?.consumedAt).toBeNull();
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("suspended");
  expect(await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.replacesPenaltyId, target.penaltyId))).toEqual([]);
  expect((await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.appealId))).map((e) => e.eventType)).toEqual(["trust.appeal_submitted.v1"]);
});

test("14-day boundary closes; pause extends appeal to resume plus 48 hours", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  const deadline = new Date(reportAt.getTime() + 14 * 86_400_000); c.time(deadline);
  await expect(c.appeals.submit(c.submit(target))).rejects.toMatchObject({ code: "window_closed" });
  await recordEnforcementModeTransition(f.db, { mode: "disabled", at: new Date(reportAt.getTime() + 86_400_000) });
  const resume = new Date(deadline.getTime() + 86_400_000);
  await recordEnforcementModeTransition(f.db, { mode: "enabled", at: resume });
  c.time(new Date(resume.getTime() + 48 * 3_600_000));
  await expect(c.appeals.submit(c.submit(target))).rejects.toMatchObject({ code: "window_closed" });
  c.time(new Date(resume.getTime() + 48 * 3_600_000 - 1));
  await c.appeals.submit(c.submit(target));
});

test("help session appeals only its linked penalty and rejects invalid or read-only sessions", async () => {
  const c = await context(); const linked = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "account" });
  const other = await c.penalties.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  const { token } = await f.db.transaction((tx) => c.helpLinks.issue(tx, { userId: c.p.creator.userId, penaltyId: linked.penaltyId, at: reportAt }));
  const { sessionToken } = await c.helpLinks.openSession({ token, networkKeyHmac: `hmac-sha256:v1:${"a".repeat(43)}` });
  const appellant = { kind: "help_session" as const, sessionToken };
  await expect(c.appeals.submit({ ...c.submit(other), appellant })).rejects.toMatchObject({ code: "not_available" });
  await expect(c.appeals.submit({ ...c.submit(linked), appellant: { kind: "help_session", sessionToken: "invalid" } })).rejects.toMatchObject({ code: "not_available" });
  // More requests than the fixture's pool capacity must complete without a nested-transaction wait.
  const submitted = await Promise.allSettled(Array.from({ length: 6 }, () => c.appeals.submit({ ...c.submit(linked), appellant })));
  expect(submitted.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(submitted.filter((r) => r.status === "rejected").every((r) => r.status === "rejected" && r.reason.code === "duplicate")).toBe(true);
  c.time(new Date(reportAt.getTime() + 1_800_000));
  await expect(c.appeals.submit({ ...c.submit(linked), appellant })).rejects.toMatchObject({ code: "not_available" });
});

test("reversal restores standing but leaves page unpublished; statement/reasoning encrypted and reporter absent", async () => {
  const c = await context(); const publishedId = randomUUID();
  await f.db.insert(schema.creatorPublicationRevisions).values({ id: publishedId, pageId: c.p.pageId, revisionNumber: 1, canonicalHandle: `artist-${publishedId.slice(0, 8)}`, displayName: "Artist", shortIntroduction: "Introduction", primaryDiscipline: "illustration", secondaryDisciplines: [], actorUserId: c.p.creator.userId, actorSessionId: c.p.creator.sessionId, expectedDraftVersion: 1, requestId: randomUUID(), publishedAt: reportAt });
  await f.db.update(schema.creatorPages).set({ publishedRevisionId: publishedId }).where(eq(schema.creatorPages.id, c.p.pageId));
  const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  const submitted = c.submit(target); const result = await c.appeals.submit(submitted); const decision = await c.decide(result.caseId);
  await c.appeals.decide(decision); const calls = c.consume.mock.calls.length;
  await c.appeals.decide({ ...decision, stepUpProofId: randomUUID(), requestId: randomUUID() }); expect(c.consume).toHaveBeenCalledTimes(calls);
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
  expect((await f.db.select().from(schema.creatorPages).where(eq(schema.creatorPages.id, c.p.pageId)))[0]?.publishedRevisionId).toBeNull();
  const [appeal] = await f.db.select().from(schema.trustAppeals).where(eq(schema.trustAppeals.id, result.appealId));
  for (const field of ["statement", "reasoning"] as const) expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: field === "statement" ? appeal!.statementEnvelope : appeal!.reasoningEnvelope!, binding: { recordType: "trust_appeals", recordId: result.appealId, fieldName: field } })).toBe((field === "statement" ? submitted.statement : decision.reasoning).normalize("NFC"));
  const events = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.appealId));
  expect(events.map((e) => e.eventType)).toEqual(["trust.appeal_submitted.v1", "trust.appeal_decided.v1"]);
  expect(JSON.stringify(events)).not.toMatch(/Private|reporter/u);
  const list = await c.appeals.listForUser(c.p.creator.userId); expect(list).toMatchObject([{ appealId: result.appealId, state: "reversed" }]);
  expect(JSON.stringify(list)).not.toContain(c.p.buyer.userId);
  expect(await c.appeals.listForUser(c.p.buyer.userId)).toEqual([]);
  await expect(f.db.delete(schema.trustAppeals).where(eq(schema.trustAppeals.id, result.appealId))).rejects.toThrow();
  await expect(f.db.update(schema.trustAppeals).set({ state: "upheld", version: 3 }).where(eq(schema.trustAppeals.id, result.appealId))).rejects.toThrow();
});

test("reduced suspension creates a restriction using one proof, same source, replacement ID and full reasoning", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability" });
  const { caseId } = await c.appeals.submit(c.submit(target)); c.consume.mockClear();
  const decision = { ...await c.decide(caseId, "reduced"), reasoning: "😀".repeat(3999) + "\n", replacement: { kind: "restriction" as const, restriction: "commission_intake" as const, endsAt: null } };
  await c.appeals.decide(decision); expect(c.consume).toHaveBeenCalledOnce();
  expect(c.consume.mock.calls[0]?.[1].actionClass).toBe("owner.trust_appeal_decide");
  const [replacement] = await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.replacesPenaltyId, target.penaltyId));
  expect(replacement).toMatchObject({ kind: "restriction", state: "active", sourceCaseId: c.caseId, subjectUserId: c.p.creator.userId });
  expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: replacement!.explanationEnvelope, binding: { recordType: "trust_penalties", recordId: replacement!.id, fieldName: "explanation" } })).toBe(decision.reasoning);
  expect((await f.db.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.id, c.capabilityId)))[0]?.state).toBe("active");
});

test("replacement must be strictly milder; invalid decision rolls back proof and state", async () => {
  const c = await context(); const endsAt = new Date(reportAt.getTime() + 86_400_000).toISOString();
  const target = await c.penalties.apply({ ...await c.command(), kind: "suspension", target: "creator_capability", endsAt });
  const { caseId } = await c.appeals.submit(c.submit(target)); const decision = await c.decide(caseId, "reduced");
  for (const replacement of [{ kind: "suspension" as const, target: "creator_capability" as const, endsAt }, { kind: "suspension" as const, target: "creator_capability" as const, endsAt: new Date(reportAt.getTime() + 2 * 86_400_000).toISOString() }])
    await expect(c.appeals.decide({ ...decision, replacement })).rejects.toMatchObject({ code: "invalid_request" });
  expect((await f.db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, decision.stepUpProofId)))[0]?.consumedAt).toBeNull();
  await c.appeals.decide({ ...decision, replacement: { kind: "suspension", target: "creator_capability", endsAt: new Date(reportAt.getTime() + 1000).toISOString() } });
});

test("upheld leaves action active; stale case, wrong proof, missing reasoning and disabled mode refuse", async () => {
  const c = await context(); const target = await c.penalties.apply({ ...await c.command(), kind: "restriction", restriction: "reporting" });
  const { caseId } = await c.appeals.submit(c.submit(target)); const command = await c.decide(caseId, "upheld");
  await expect(c.appeals.decide({ ...command, expectedCaseVersion: 2 })).rejects.toMatchObject({ code: "version_conflict" });
  await expect(c.appeals.decide({ ...command, ...await c.base("owner.trust_penalty_lift") })).rejects.toMatchObject({ code: "owner_step_up_required" });
  await expect(c.appeals.decide({ ...command, reasoning: "" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(createAppealService({ ...c.input, mode: "disabled" }).submit(c.submit(target))).rejects.toMatchObject({ code: "enforcement_disabled" });
  await c.appeals.decide(command);
  expect((await f.db.select().from(schema.trustPenalties).where(eq(schema.trustPenalties.id, target.penaltyId)))[0]?.state).toBe("active");
});

test("reversed hide releases content after report closure; appeal_source reads original evidence and logs appeal access", async () => {
  const c = await context(); const messageId = await f.message(c.p.orderId, c.p.creator.userId);
  const { caseId: originalCaseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "report", orderId: c.p.orderId, sourceType: "commission_message", sourceId: messageId, policyRevisionId: null, at: reportAt, requestId: randomUUID() }));
  await f.db.insert(schema.trustReports).values({ id: randomUUID(), reportReference: `report:v2:${randomUUID().replaceAll("-", "")}`, targetKind: "commission_message", targetId: messageId, orderId: c.p.orderId, contentOwnerUserId: c.p.creator.userId, reporterUserId: c.p.buyer.userId, reason: "other", caseId: originalCaseId, createdAt: reportAt });
  const { hideId } = await c.hides.hide({ ...await c.base("owner.trust_hide"), caseId: originalCaseId, expectedCaseVersion: 1, reason: "Hide" });
  await c.hides.closeReportCase({ ...await c.base("owner.trust_report_close"), caseId: originalCaseId, expectedCaseVersion: 2, resolution: "actioned", reason: "Close" });
  const { caseId } = await c.appeals.submit(c.submit({ hideId }));
  const appealSource = vi.fn().mockResolvedValue({ report_context: { messages: [{ id: messageId }] } });
  const evidence = { orderSummary: vi.fn(), threadPage: vi.fn(), resolutionRecords: vi.fn(), refundDestination: vi.fn(), fileGrant: vi.fn(), appealSource };
  const cases = createTrustCaseService({ ...c.input, evidence });
  const base = await c.base("owner.case_evidence");
  expect(await cases.readEvidence({ owner: c.owner, stepUpProofId: base.stepUpProofId, requestId: base.requestId, caseId, section: "appeal_source" })).toMatchObject({ report_context: { messages: [{ id: messageId }] } });
  expect(appealSource.mock.calls[0]?.[1]).toBe(caseId);
  expect(await f.db.select().from(schema.trustCaseAccessLog).where(eq(schema.trustCaseAccessLog.caseId, caseId))).toMatchObject([{ itemType: "appeal_source", itemId: caseId }]);
  await c.appeals.decide(await c.decide(caseId));
  expect(await f.db.transaction((tx) => createContentHideReadPort().activeHide(tx, "commission_message", messageId))).toBeNull();
  expect((await f.db.select().from(schema.trustContentHides).where(eq(schema.trustContentHides.id, hideId)))[0]).toMatchObject({ releaseKind: "appeal_reversed", releasedByUserId: null });
});

test("reversing removal preserves frozen orders and refunds", async () => {
  const freeze = createRemovalFreezePort({ mode: "enabled", orders: createCommissionResolutionOrderPort({ applicationRevision: "appeal-test", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: fixtureKeyring, calendarVersion: "vn-banking-2026-v1" }), payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort() });
  const c = await context(freeze); const target = await c.penalties.apply({ ...await c.command(), kind: "removal", target: "creator_capability" });
  const { caseId } = await c.appeals.submit(c.submit(target)); await c.appeals.decide(await c.decide(caseId));
  expect((await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, c.p.orderId)))[0]).toMatchObject({ state: "closed", closeReason: "fulfillment_frozen" });
  expect(await f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, c.p.orderId))).toHaveLength(1);
});
