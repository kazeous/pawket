import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { vi } from "vitest";
import * as schema from "@pawket/database";
import { lockCommissionCreator } from "@pawket/orders";
import { createIdentityEnforcementPort, createEnforcementNoticePort } from "@pawket/identity";
import { canonicalizeEmailAddress } from "@pawket/identity/email-address";
import { createHelpLinkService } from "../src/help-link-service.js";
import { createPenaltyService } from "../src/penalty-service.js";
import { createTrustCasePort } from "../src/case-port.js";
import { createReportFixture, fixtureKeyring, fixtureLookupKey, reportAt } from "./report-fixture.js";

export { fixtureKeyring, reportAt };
export function canonicalizeHelpEmail(raw: string): string | null {
  try { return canonicalizeEmailAddress(raw).canonical; } catch { return null; }
}
export async function penaltyContext(f: ReturnType<typeof createReportFixture>, freeze?: Parameters<typeof createPenaltyService>[0]["freeze"]) {
  const p = await f.paidOrder();
  const [grant] = await f.db.select().from(schema.identityRoleGrants).where(and(eq(schema.identityRoleGrants.role, "owner"), eq(schema.identityRoleGrants.state, "active")));
  const owner = { userId: grant?.userId ?? await f.person(), sessionId: randomUUID() };
  const applicationId = randomUUID(); const revisionId = randomUUID(); const capabilityId = randomUUID();
  await f.db.insert(schema.creatorApplications).values({ id: applicationId, userId: p.creator.userId, state: "approved", createdAt: reportAt, updatedAt: reportAt });
  await f.db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, createdAt: reportAt, updatedAt: reportAt });
  await f.db.insert(schema.identityCreatorCapabilities).values({ id: capabilityId, userId: p.creator.userId, state: "active", approvedApplicationId: applicationId, approvedRevisionId: revisionId, createdAt: reportAt, updatedAt: reportAt });
  if (!grant) await f.db.insert(schema.identityRoleGrants).values({ userId: owner.userId, role: "owner", grantSource: "bootstrap_cli" });
  for (const actor of [owner, p.creator]) await f.db.insert(schema.identitySessions).values({ id: actor.sessionId, userId: actor.userId, token: randomUUID(), createdAt: reportAt, updatedAt: reportAt,
    expiresAt: new Date(reportAt.getTime() + 86_400_000), absoluteExpiresAt: new Date(reportAt.getTime() + 86_400_000), idleExpiresAt: new Date(reportAt.getTime() + 86_400_000), lastUsedAt: reportAt });
  const { caseId } = await f.db.transaction((tx) => createTrustCasePort().openCase(tx, { kind: "dispute", orderId: p.orderId, sourceType: "commission_dispute", sourceId: randomUUID(), policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, requestId: randomUUID(), at: reportAt }));
  const consume = vi.fn<Parameters<typeof createPenaltyService>[0]["consumeStepUpProof"]>(async (tx, proof) => {
    const rows = await tx.update(schema.identityStepUpProofs).set({ consumedAt: proof.now }).where(and(eq(schema.identityStepUpProofs.id, proof.proofId), eq(schema.identityStepUpProofs.userId, proof.userId),
      eq(schema.identityStepUpProofs.sessionId, proof.sessionId), eq(schema.identityStepUpProofs.actionClass, proof.actionClass), isNull(schema.identityStepUpProofs.consumedAt), gt(schema.identityStepUpProofs.expiresAt, proof.now))).returning();
    return rows.length === 1;
  });
  const identity = createIdentityEnforcementPort({ async clearPublishedHeadForSuspension(tx, c) {
    const [page] = await tx.select().from(schema.creatorPages).where(eq(schema.creatorPages.userId, c.creatorUserId));
    if (!page) return { pageId: null, previousPublishedRevisionId: null };
    await tx.update(schema.creatorPages).set({ publishedRevisionId: null, updatedAt: c.occurredAt }).where(eq(schema.creatorPages.id, page.id));
    return { pageId: page.id, previousPublishedRevisionId: page.publishedRevisionId };
  } });
  const frozen = vi.fn(async () => ({ closedOrders: 0 }));
  const notices = createEnforcementNoticePort({ keyring: fixtureKeyring });
  const helpLinks = createHelpLinkService({ db: f.db, mode: "enabled", lookupHmacKey: fixtureLookupKey, notices,
    canonicalizeEmail: canonicalizeHelpEmail, logger: { error: vi.fn() }, now: () => reportAt });
  const input = { db: f.db, mode: "enabled" as const, keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey, applicationRevision: "synthetic-penalty", consumeStepUpProof: consume,
    fence: { lockCreatorFence: lockCommissionCreator }, identity, helpLinks, notices, freeze: freeze ?? { freezeForRemoval: frozen }, policies: { readCurrentIds: async () => ({ communityRulesRevisionId: null, enforcementRevisionId: null }) }, now: () => reportAt };
  const service = createPenaltyService(input);
  async function base(actionClass = "owner.trust_penalty_apply") {
    const stepUpProofId = randomUUID(); await f.db.insert(schema.identityStepUpProofs).values({ id: stepUpProofId, ...owner, actionClass, assuranceMethod: "mfa", issuedAt: reportAt, expiresAt: new Date(reportAt.getTime() + 3_600_000) });
    return { owner, stepUpProofId, idempotencyKey: randomUUID(), requestId: randomUUID() };
  }
  async function command() { return { ...await base(), subjectUserId: p.creator.userId, source: { caseId }, kind: "warning" as const, reasonCategory: "other" as const, explanation: "Private explanation e\u0301", internalNote: "Private internal note" }; }
  return { p, owner, caseId, capabilityId, revisionId, consume, identity, frozen, input, service, base, command };
}
