import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import * as schema from "@pawket/database";
import { createThreadReportTargetPort } from "@pawket/commission-files";
import { createBriefReportTargetPort, lockCommissionCreator } from "@pawket/orders";
import { decryptSensitiveField, encryptSensitiveField } from "@pawket/security";
import { createContentHideService } from "../src/content-hide-service.js";
import { createContentHideReadPort } from "../src/content-hide-port.js";
import { createPrivateReportService } from "../src/private-report-service.js";
import { createTrustRestrictionPort } from "../src/penalty-port.js";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "./report-fixture.js";

const f = createReportFixture("hides");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
async function setup(kind: "commission_message" | "commission_brief" = "commission_message") {
  const p = await f.paidOrder(); const messageId = await f.message(p.orderId, p.creator.userId);
  const reports = createPrivateReportService({ db: f.db, mode: "enabled", keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey, challengeKey: fixtureLookupKey,
    restrictions: createTrustRestrictionPort({ mode: "enabled" }), now: () => reportAt,
    policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) },
    targets: { resolve: (tx, target, actor) => target.kind === "commission_brief" ? createBriefReportTargetPort().resolve(tx, target, actor) : createThreadReportTargetPort().resolve(tx, target, actor) } });
  const { caseId } = await reports.submit({ requester: { kind: "authenticated", actor: kind === "commission_brief" ? p.creator : p.buyer },
    target: kind === "commission_brief" ? { kind, orderId: p.orderId } : { kind, orderId: p.orderId, messageId },
    reason: "other", detail: null, idempotencyKey: randomUUID(), requestId: randomUUID() });
  const owner = { userId: await f.person(), sessionId: randomUUID() };
  await f.db.insert(schema.identitySessions).values({ id: owner.sessionId, userId: owner.userId, token: randomUUID(), createdAt: reportAt, updatedAt: reportAt,
    expiresAt: new Date(reportAt.getTime() + 86_400_000), absoluteExpiresAt: new Date(reportAt.getTime() + 86_400_000), idleExpiresAt: new Date(reportAt.getTime() + 86_400_000), lastUsedAt: reportAt });
  const consume = vi.fn<Parameters<typeof createContentHideService>[0]["consumeStepUpProof"]>(async (tx, proof) => {
    const rows = await tx.update(schema.identityStepUpProofs).set({ consumedAt: proof.now }).where(and(eq(schema.identityStepUpProofs.id, proof.proofId),
      eq(schema.identityStepUpProofs.userId, proof.userId), eq(schema.identityStepUpProofs.sessionId, proof.sessionId), eq(schema.identityStepUpProofs.actionClass, proof.actionClass),
      isNull(schema.identityStepUpProofs.consumedAt), gt(schema.identityStepUpProofs.expiresAt, proof.now))).returning(); return rows.length === 1;
  });
  const fence = vi.fn(lockCommissionCreator);
  const service = createContentHideService({ db: f.db, mode: "enabled", keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey, consumeStepUpProof: consume,
    applicationRevision: "synthetic-hide", fence: { lockCreatorFence: fence }, now: () => reportAt });
  async function command(actionClass = "owner.trust_hide") {
    const stepUpProofId = randomUUID();
    await f.db.insert(schema.identityStepUpProofs).values({ id: stepUpProofId, ...owner, actionClass, assuranceMethod: "mfa", issuedAt: reportAt, expiresAt: new Date(reportAt.getTime() + 3_600_000) });
    const [row] = await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, caseId));
    return { owner, caseId, stepUpProofId, expectedCaseVersion: row!.version, reason: "Private hide reason e\u0301", idempotencyKey: randomUUID(), requestId: randomUUID() };
  }
  return { p, messageId, caseId, service, command, consume, fence, owner };
}

test("hide is encrypted, audited and atomic; replay returns its ID without consuming a second proof", async () => {
  const c = await setup(); const command = await c.command(); const result = await c.service.hide(command);
  expect(await c.service.hide({ ...command, stepUpProofId: randomUUID(), requestId: randomUUID() })).toEqual(result);
  expect(c.consume).toHaveBeenCalledOnce(); expect(c.consume.mock.calls[0]![1].actionClass).toBe("owner.trust_hide");
  expect(c.fence.mock.calls[0]![1]).toBe(c.p.creator.userId);
  const [row] = await f.db.select().from(schema.trustContentHides).where(eq(schema.trustContentHides.id, result.hideId));
  expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: row!.reasonEnvelope, binding: { recordType: "trust_content_hides", recordId: result.hideId, fieldName: "reason" } })).toBe(command.reason.normalize("NFC"));
  const [event] = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.hideId));
  expect(event!.payload).toEqual({ hideId: result.hideId, caseId: c.caseId, targetKind: "commission_message" });
  expect(JSON.stringify(event!.payload)).not.toMatch(/Synthetic message|Private hide reason|reporter/u);
  expect(await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.subjectId, result.hideId))).toHaveLength(1);
  await expect(c.service.hide({ ...command, reason: "Changed" })).rejects.toMatchObject({ code: "idempotency_conflict" });
});
test("restore releases once, restores visibility, records an event and replays without another proof", async () => {
  const c = await setup(); const { hideId } = await c.service.hide(await c.command()); const read = createContentHideReadPort();
  expect(await f.db.transaction((tx) => read.hiddenIds(tx, "commission_message", [c.messageId]))).toEqual(new Set([c.messageId]));
  const command = { ...await c.command("owner.trust_restore"), hideId }; await c.service.restore(command); await c.service.restore(command);
  expect(c.consume).toHaveBeenCalledTimes(2);
  expect(await f.db.transaction((tx) => read.activeHide(tx, "commission_message", c.messageId))).toBeNull();
  expect(await f.db.select().from(schema.trustCaseEvents).where(eq(schema.trustCaseEvents.caseId, c.caseId)).orderBy(asc(schema.trustCaseEvents.resultingVersion))).toMatchObject([
    { action: "opened" }, { action: "report_added" }, { action: "content_hidden" }, { action: "content_restored" }]);
  await expect(f.db.update(schema.trustContentHides).set({ releasedAt: new Date(reportAt.getTime() + 1) }).where(eq(schema.trustContentHides.id, hideId))).rejects.toThrow();
  await expect(f.db.delete(schema.trustContentHides).where(eq(schema.trustContentHides.id, hideId))).rejects.toThrow();
});
test("brief cannot be hidden; actioned requires an action and dismissed requires no recorded action", async () => {
  const brief = await setup("commission_brief"); await expect(brief.service.hide(await brief.command())).rejects.toMatchObject({ code: "invalid_request" });
  await expect(brief.service.closeReportCase({ ...await brief.command("owner.trust_report_close"), resolution: "actioned" })).rejects.toMatchObject({ code: "invalid_transition" });
  const close = { ...await brief.command("owner.trust_report_close"), resolution: "dismissed" as const }; await brief.service.closeReportCase(close); await brief.service.closeReportCase(close);
  expect(await f.db.select().from(schema.trustReports).where(eq(schema.trustReports.caseId, brief.caseId))).toMatchObject([{ state: "closed" }]);
  const c = await setup(); const { hideId } = await c.service.hide(await c.command());
  await c.service.restore({ ...await c.command("owner.trust_restore"), hideId });
  await expect(c.service.closeReportCase({ ...await c.command("owner.trust_report_close"), resolution: "dismissed" })).rejects.toMatchObject({ code: "invalid_transition" });
  await c.service.closeReportCase({ ...await c.command("owner.trust_report_close"), resolution: "actioned" });
});
test("stale version, wrong action proof and duplicate active hides leave no partial writes", async () => {
  const c = await setup(); const stale = { ...await c.command(), expectedCaseVersion: 1 };
  await expect(c.service.hide(stale)).rejects.toMatchObject({ code: "version_conflict" });
  const [proof] = await f.db.select().from(schema.identityStepUpProofs).where(eq(schema.identityStepUpProofs.id, stale.stepUpProofId)); expect(proof!.consumedAt).toBeNull();
  await expect(c.service.hide(await c.command("owner.trust_restore"))).rejects.toMatchObject({ code: "owner_step_up_required" });
  const { hideId } = await c.service.hide(await c.command());
  await expect(c.service.hide(await c.command())).rejects.toMatchObject({ code: "invalid_transition" });
  await expect(f.db.update(schema.trustContentHides).set({ targetId: randomUUID() }).where(eq(schema.trustContentHides.id, hideId))).rejects.toThrow();
  expect(await f.db.select().from(schema.trustContentHides).where(eq(schema.trustContentHides.caseId, c.caseId))).toHaveLength(1);
});

test("a case-linked penalty permits actioned closure without a hide", async () => {
  const c = await setup("commission_brief"); const penaltyId = randomUUID();
  await f.db.insert(schema.trustPenalties).values({ id: penaltyId, subjectUserId: c.p.buyer.userId, kind: "warning", reasonCategory: "other",
    explanationEnvelope: encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Private penalty", binding: { recordType: "trust_penalties", recordId: penaltyId, fieldName: "explanation" } }),
    sourceCaseId: c.caseId, startsAt: reportAt, ownerUserId: c.owner.userId, ownerSessionId: c.owner.sessionId, stepUpProofId: randomUUID(), requestId: randomUUID(), createdAt: reportAt });
  await c.service.closeReportCase({ ...await c.command("owner.trust_report_close"), resolution: "actioned" });
  const [row] = await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, c.caseId)); expect(row).toMatchObject({ state: "resolved", resolutionKind: "actioned" });
});

test("disabled commands refuse before proof consumption and new reasons reject invalid text", async () => {
  const c = await setup(); const command = await c.command();
  const disabled = createContentHideService({ db: f.db, mode: "disabled", keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey,
    applicationRevision: "synthetic-hide", consumeStepUpProof: c.consume, fence: { lockCreatorFence: c.fence }, now: () => reportAt });
  await expect(disabled.hide(command)).rejects.toMatchObject({ code: "enforcement_disabled" }); expect(c.consume).not.toHaveBeenCalled(); expect(c.fence).not.toHaveBeenCalled();
  for (const reason of ["", "x".repeat(2_001), "control\r", "lone\ud800"]) await expect(c.service.hide({ ...command, reason })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await f.db.transaction((tx) => createContentHideReadPort().hiddenIds(tx, "commission_message", []))).toEqual(new Set());
});
