import { randomUUID } from "node:crypto";

import {
  appendAdminAuditEvent,
  beginIdempotentCommand,
  completeIdempotentCommand,
  creatorApplicationAttestations,
  creatorApplicationDecisions,
  creatorApplicationRevisions,
  creatorApplications,
  identityCreatorCapabilities,
  identityCreatorCapabilityEvents,
  identitySessions,
  identityUsers,
  insertOutboxEvent,
  paymentsReceivingAccountOnboarding,
  paymentsVerificationDepositChallenges,
  paymentsVerificationDepositRefundObligations,
  type PawketDatabase,
  type PawketTransaction,
} from "@pawket/database";
import { rejectionCooldownUntil } from "@pawket/identity";
import { createLookupHmac, decryptSensitiveField, type EncryptionEnvelope, type EncryptionKeyring } from "@pawket/security";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

const CLAIM_LEASE_MS = 15 * 60_000;
const IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60_000;
const requiredAttestations = new Map([
  ["dob_truthfulness", "increment-2-v1"], ["portfolio_rights", "increment-2-v1"], ["truthful_information", "increment-2-v1"], ["creator_terms", "increment-2-v1"], ["privacy", "increment-2-v1"],
]);
const reasonCodes = new Set([
  "portfolio_insufficient",
  "portfolio_control_unclear",
  "contact_unverified",
  "receiving_account_unverified",
  "content_policy_risk",
  "information_inconsistent",
  "eligibility_not_met",
  "other",
]);

export type CreatorDecisionAction = "request_changes" | "approve" | "reject" | "reopen";

export class CreatorReviewError extends Error {
  constructor(readonly code: string) {
    super("Creator review request was not accepted");
    this.name = "CreatorReviewError";
  }
}

type StepUpInput = {
  proofId: string;
  sessionId: string;
  userId: string;
  actionClass: string;
  now: Date;
};

type ServiceInput = {
  db: PawketDatabase;
  keyring: EncryptionKeyring;
  commandFingerprintKey: Uint8Array;
  consumeStepUpProof: (tx: PawketTransaction, input: StepUpInput) => Promise<boolean>;
  idFactory?: () => string;
  now?: () => Date;
};

function policy(condition: unknown, code: string): asserts condition {
  if (!condition) throw new CreatorReviewError(code);
}

function bounded(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : null;
}

function decisionAction(action: CreatorDecisionAction): "changes_requested" | "approved" | "rejected" | "reopened" {
  if (action === "request_changes") return "changes_requested";
  if (action === "approve") return "approved";
  if (action === "reject") return "rejected";
  return "reopened";
}

function resultReference(applicationId: string, state: string): string {
  return `creator-review-v1:${applicationId}:${state}`;
}

function parseResultReference(value: string): { applicationId: string; state: string } | null {
  const match = /^creator-review-v1:([0-9a-f-]{36}):(changes_requested|approved|rejected|reopened)$/u.exec(value);
  return match ? { applicationId: match[1]!, state: match[2]! } : null;
}

function reviewFingerprint(input: ServiceInput, command: Record<string, unknown>): { keyHash: string; requestFingerprint: string } {
  const key = bounded(command.idempotencyKey, 8, 200);
  policy(key && /^[A-Za-z0-9._-]+$/u.test(key), "invalid_idempotency_key");
  return {
    keyHash: createLookupHmac({ value: key, context: "creator-review-command-key", key: input.commandFingerprintKey }),
    requestFingerprint: createLookupHmac({ value: JSON.stringify(command), context: "creator-review-command", key: input.commandFingerprintKey }),
  };
}

async function requireStepUp(input: ServiceInput, tx: PawketTransaction, proof: StepUpInput): Promise<void> {
  if (!(await input.consumeStepUpProof(tx, proof))) throw new CreatorReviewError("owner_totp_required");
}

async function revalidateApproval(tx: PawketTransaction, application: typeof creatorApplications.$inferSelect, at: Date): Promise<void> {
  policy(application.currentRevisionId, "missing_revision");
  const [revision] = await tx.select().from(creatorApplicationRevisions).where(eq(creatorApplicationRevisions.id, application.currentRevisionId)).limit(1).for("update");
  const [user] = await tx.select().from(identityUsers).where(eq(identityUsers.id, application.userId)).limit(1).for("update");
  policy(revision && revision.submittedAt && revision.dobEnvelope && revision.ageAtSubmission !== null && revision.ageAtSubmission >= 18 && /^\d{4}-\d{2}-\d{2}$/u.test(revision.ageEvaluatedOn ?? ""), "age_snapshot_invalid");
  policy(bounded(revision.artistDisplayName, 1, 200) && bounded(revision.shortIntroduction, 1, 2000) && bounded(revision.applicantEmail, 3, 320) && Array.isArray(revision.portfolioUrls) && revision.portfolioUrls.length > 0 && revision.portfolioUrls.length <= 5 && revision.portfolioUrls.every((value) => typeof value === "string" && /^https:\/\//iu.test(value)) && bounded(revision.primaryArtDiscipline, 1, 100) && bounded(revision.practiceDescription, 1, 4000) && (revision.contentIntent === "general_audience_only" || revision.contentIntent === "may_include_age_restricted"), "snapshot_incomplete");
  policy(user && user.accessStatus === "active" && user.emailVerified, "account_ineligible");
  policy(revision.applicantEmail === user.email, "email_changed");
  policy(revision.proposedReceivingAccountId, "missing_receiving_account");
  const attestations = await tx.select({ type: creatorApplicationAttestations.type, policyVersion: creatorApplicationAttestations.policyVersion }).from(creatorApplicationAttestations).where(eq(creatorApplicationAttestations.revisionId, revision.id)).for("update");
  policy(attestations.length === requiredAttestations.size && attestations.every((item) => requiredAttestations.get(item.type) === item.policyVersion), "attestations_invalid");
  const [account] = await tx.select().from(paymentsReceivingAccountOnboarding).where(and(eq(paymentsReceivingAccountOnboarding.id, revision.proposedReceivingAccountId), eq(paymentsReceivingAccountOnboarding.applicantUserId, application.userId), isNull(paymentsReceivingAccountOnboarding.retiredAt))).limit(1).for("update");
  const proofAge = account?.proofVerifiedAt ? at.getTime() - account.proofVerifiedAt.getTime() : null;
  policy(account && account.proofState === "verified" && proofAge !== null && proofAge >= 0 && proofAge <= 30 * 24 * 60 * 60_000, "proof_expired");
  const [proof] = await tx.select({ id: paymentsVerificationDepositChallenges.id }).from(paymentsVerificationDepositChallenges).where(and(eq(paymentsVerificationDepositChallenges.applicationId, application.id), eq(paymentsVerificationDepositChallenges.revisionId, revision.id), eq(paymentsVerificationDepositChallenges.accountVersionId, account.id), eq(paymentsVerificationDepositChallenges.state, "verified"))).limit(1).for("update");
  policy(proof, "receiving_account_unverified");
  const [obligation] = await tx.select({ id: paymentsVerificationDepositRefundObligations.id }).from(paymentsVerificationDepositRefundObligations).where(and(eq(paymentsVerificationDepositRefundObligations.challengeId, proof.id), eq(paymentsVerificationDepositRefundObligations.accountVersionId, account.id), eq(paymentsVerificationDepositRefundObligations.applicantUserId, application.userId))).limit(1).for("update");
  policy(obligation, "refund_obligation_missing");
}

export function createCreatorReviewService(input: ServiceInput) {
  const now = input.now ?? (() => new Date());
  const id = input.idFactory ?? randomUUID;

  return {
    async getDetail(command: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; applicationId: string; requestId: string }) {
      const at = now();
      return input.db.transaction(async (tx) => {
        const [application] = await tx.select().from(creatorApplications).where(eq(creatorApplications.id, command.applicationId)).limit(1).for("update");
        policy(application && application.currentRevisionId, "application_not_found");
        await requireStepUp(input, tx, { proofId: command.stepUpProofId, sessionId: command.ownerSessionId, userId: command.ownerUserId, actionClass: "owner.creator_application_detail", now: at });
        const revisions = await tx.select().from(creatorApplicationRevisions).where(eq(creatorApplicationRevisions.applicationId, application.id)).orderBy(desc(creatorApplicationRevisions.revisionNumber));
        const currentRevision = revisions.find((revision) => revision.id === application.currentRevisionId);
        policy(currentRevision && currentRevision.submittedAt, "missing_submitted_revision");
        const attestations = await tx.select({ type: creatorApplicationAttestations.type, policyVersion: creatorApplicationAttestations.policyVersion, acceptedAt: creatorApplicationAttestations.acceptedAt }).from(creatorApplicationAttestations).where(eq(creatorApplicationAttestations.revisionId, currentRevision.id));
        const [account] = currentRevision.proposedReceivingAccountId
          ? await tx.select({ id: paymentsReceivingAccountOnboarding.id, bankName: paymentsReceivingAccountOnboarding.bankName, maskedSuffix: paymentsReceivingAccountOnboarding.maskedSuffix, proofState: paymentsReceivingAccountOnboarding.proofState }).from(paymentsReceivingAccountOnboarding).where(eq(paymentsReceivingAccountOnboarding.id, currentRevision.proposedReceivingAccountId)).limit(1)
          : [];
        const [challenge] = account
          ? await tx.select({ id: paymentsVerificationDepositChallenges.id }).from(paymentsVerificationDepositChallenges).where(and(eq(paymentsVerificationDepositChallenges.applicationId, application.id), eq(paymentsVerificationDepositChallenges.revisionId, currentRevision.id), eq(paymentsVerificationDepositChallenges.accountVersionId, account.id))).orderBy(desc(paymentsVerificationDepositChallenges.createdAt)).limit(1)
          : [];
        const [obligation] = challenge
          ? await tx.select({ state: paymentsVerificationDepositRefundObligations.state, refundNotBefore: paymentsVerificationDepositRefundObligations.refundNotBefore, refundDue: paymentsVerificationDepositRefundObligations.refundDue }).from(paymentsVerificationDepositRefundObligations).where(eq(paymentsVerificationDepositRefundObligations.challengeId, challenge.id)).limit(1)
          : [];
        const decisions = await tx.select({ applicationId: creatorApplicationDecisions.applicationId, action: creatorApplicationDecisions.action, reasonCode: creatorApplicationDecisions.reasonCode, createdAt: creatorApplicationDecisions.createdAt }).from(creatorApplicationDecisions).innerJoin(creatorApplications, eq(creatorApplications.id, creatorApplicationDecisions.applicationId)).where(eq(creatorApplications.userId, application.userId)).orderBy(desc(creatorApplicationDecisions.createdAt));
        const projectRevision = (revision: typeof creatorApplicationRevisions.$inferSelect) => ({
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          artistDisplayName: revision.artistDisplayName,
          shortIntroduction: revision.shortIntroduction,
          applicantEmail: revision.applicantEmail,
          dateOfBirth: revision.dobEnvelope
            ? decryptSensitiveField({ envelope: revision.dobEnvelope as EncryptionEnvelope<"creator_application_revision", "date_of_birth">, binding: { recordType: "creator_application_revision", recordId: revision.id, fieldName: "date_of_birth" }, keyring: input.keyring })
            : null,
          portfolioUrls: revision.portfolioUrls,
          primaryArtDiscipline: revision.primaryArtDiscipline,
          practiceDescription: revision.practiceDescription,
          contentIntent: revision.contentIntent,
          ageAtSubmission: revision.ageAtSubmission,
          ageEvaluatedOn: revision.ageEvaluatedOn,
          submittedAt: revision.submittedAt,
        });
        await appendAdminAuditEvent(tx, { actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, subjectType: "creator_application", subjectId: application.id, action: "creator.application.detail.reveal", outcome: "succeeded", beforeState: null, afterState: { applicationId: application.id, revisionId: currentRevision.id }, assurance: { method: "totp", actionClass: "owner.creator_application_detail" }, applicationRevision: currentRevision.id, requestId: command.requestId, occurredAt: at });
        return {
          application: { id: application.id, state: application.state, version: application.version, currentRevisionId: currentRevision.id },
          revision: projectRevision(currentRevision),
          revisions: revisions.map(projectRevision),
          attestations,
          priorOutcomes: decisions.filter((decision) => decision.applicationId !== application.id),
          payment: { bankName: account?.bankName ?? null, maskedSuffix: account?.maskedSuffix ?? null, proofState: account?.proofState ?? "unverified", refundState: obligation?.state ?? null, refundNotBefore: obligation?.refundNotBefore ?? null, refundDue: obligation?.refundDue ?? null },
        };
      });
    },

    async listSubmitted() {
      return input.db.select({ id: creatorApplications.id, version: creatorApplications.version, submittedAt: creatorApplicationRevisions.submittedAt, artistDisplayName: creatorApplicationRevisions.artistDisplayName, primaryArtDiscipline: creatorApplicationRevisions.primaryArtDiscipline, emailVerified: identityUsers.emailVerified, ageEligible: sql<boolean>`coalesce(${creatorApplicationRevisions.ageAtSubmission} >= 18, false)`, bankName: paymentsReceivingAccountOnboarding.bankName, maskedSuffix: paymentsReceivingAccountOnboarding.maskedSuffix, proofState: paymentsReceivingAccountOnboarding.proofState }).from(creatorApplications).innerJoin(creatorApplicationRevisions, eq(creatorApplicationRevisions.id, creatorApplications.currentRevisionId)).innerJoin(identityUsers, eq(identityUsers.id, creatorApplications.userId)).leftJoin(paymentsReceivingAccountOnboarding, sql`${paymentsReceivingAccountOnboarding.id}::text = ${creatorApplicationRevisions.proposedReceivingAccountId}`).where(eq(creatorApplications.state, "submitted")).orderBy(asc(creatorApplicationRevisions.submittedAt));
    },

    async claim(command: { ownerUserId: string; ownerSessionId: string; applicationId: string; expectedVersion: number; requestId: string }) {
      const at = now();
      return input.db.transaction(async (tx) => {
        const [application] = await tx.select().from(creatorApplications).where(eq(creatorApplications.id, command.applicationId)).limit(1).for("update");
        policy(application && application.version === command.expectedVersion, "stale_version");
        policy(application.state === "submitted" || (application.state === "under_review" && application.reviewClaimExpiresAt && application.reviewClaimExpiresAt <= at), "claim_unavailable");
        const [updated] = await tx.update(creatorApplications).set({ state: "under_review", reviewerUserId: command.ownerUserId, reviewClaimedAt: at, reviewClaimExpiresAt: new Date(at.getTime() + CLAIM_LEASE_MS), version: application.version + 1, updatedAt: at }).where(and(eq(creatorApplications.id, application.id), eq(creatorApplications.version, application.version))).returning();
        policy(updated, "stale_version");
        return { version: updated.version, leaseExpiresAt: updated.reviewClaimExpiresAt! };
      });
    },

    async decide(command: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; applicationId: string; revisionId: string; expectedVersion: number; idempotencyKey: string; requestId: string; action: CreatorDecisionAction; reasonCode: string; applicantExplanation: string; privateNote?: string }) {
      const at = now();
      const reasonCode = bounded(command.reasonCode, 1, 100);
      const applicantExplanation = bounded(command.applicantExplanation, 1, 2000);
      const privateNote = command.privateNote === undefined ? null : bounded(command.privateNote, 1, 1000);
      policy(reasonCode && reasonCodes.has(reasonCode) && applicantExplanation && (command.privateNote === undefined || privateNote), "invalid_decision");
      const fingerprint = reviewFingerprint(input, { idempotencyKey: command.idempotencyKey, applicationId: command.applicationId, revisionId: command.revisionId, expectedVersion: command.expectedVersion, action: command.action, reasonCode, applicantExplanation, privateNote });
      return input.db.transaction(async (tx) => {
        const started = await beginIdempotentCommand(tx, { actorUserId: command.ownerUserId, commandScope: `creator.application.${command.action}`, ...fingerprint, now: at, expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS) });
        if (started.kind === "replay") {
          const prior = parseResultReference(started.resultReference);
          policy(prior && prior.applicationId === command.applicationId, "idempotency_invalid");
          return { state: prior.state };
        }
        policy(started.kind === "acquired", "idempotency_conflict");
        const [application] = await tx.select().from(creatorApplications).where(eq(creatorApplications.id, command.applicationId)).limit(1).for("update");
        policy(application && application.version === command.expectedVersion && application.currentRevisionId === command.revisionId, "stale_version");
        const expectedState = command.action === "reopen" ? "rejected" : "under_review";
        policy(application.state === expectedState, "invalid_state");
        if (command.action !== "reopen") policy(application.reviewerUserId === command.ownerUserId && application.reviewClaimExpiresAt && application.reviewClaimExpiresAt > at, "claim_expired");
        await requireStepUp(input, tx, { proofId: command.stepUpProofId, sessionId: command.ownerSessionId, userId: command.ownerUserId, actionClass: `owner.creator_application_${command.action}`, now: at });
        if (command.action === "approve") await revalidateApproval(tx, application, at);
        const action = decisionAction(command.action);
        const nextState = command.action === "request_changes" || command.action === "reopen" ? "changes_requested" : action;
        const [updated] = await tx.update(creatorApplications).set({ state: nextState, reviewerUserId: null, reviewClaimedAt: null, reviewClaimExpiresAt: null, rejectedAt: command.action === "reject" ? at : null, cooldownUntil: command.action === "reject" ? rejectionCooldownUntil(at) : null, version: application.version + 1, updatedAt: at }).where(and(eq(creatorApplications.id, application.id), eq(creatorApplications.version, application.version))).returning();
        policy(updated, "stale_version");
        await tx.insert(creatorApplicationDecisions).values({ id: id(), applicationId: application.id, revisionId: command.revisionId, action, reasonCode, applicantExplanation, privateNote, actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, stepUpProofId: command.stepUpProofId, expectedVersion: command.expectedVersion, requestId: command.requestId, createdAt: at });
        if (command.action === "approve") {
          const [created] = await tx.insert(identityCreatorCapabilities).values({ id: id(), userId: application.userId, state: "active", version: 1, approvedApplicationId: application.id, approvedRevisionId: command.revisionId, suspendedAt: null, createdAt: at, updatedAt: at }).onConflictDoNothing().returning({ id: identityCreatorCapabilities.id });
          policy(created, "creator_capability_exists");
          await tx.insert(identityCreatorCapabilityEvents).values({ id: id(), capabilityId: created.id, action: "granted", state: "active", version: 1, actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, stepUpProofId: command.stepUpProofId, reasonCode, requestId: command.requestId, createdAt: at });
          await tx.update(identityUsers).set({ authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`, updatedAt: at }).where(eq(identityUsers.id, application.userId));
          await tx.update(identitySessions).set({ revokedAt: at, revocationReason: "creator_capability_changed", updatedAt: at }).where(and(eq(identitySessions.userId, application.userId), isNull(identitySessions.revokedAt)));
        }
        await appendAdminAuditEvent(tx, { actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, subjectType: "creator_application", subjectId: application.id, action: `creator.application.${command.action}`, outcome: "succeeded", reasonCode, beforeState: { state: application.state, version: application.version }, afterState: { state: nextState, version: updated.version }, assurance: { method: "totp", actionClass: `owner.creator_application_${command.action}` }, applicationRevision: command.revisionId, requestId: command.requestId, occurredAt: at });
        for (const eventType of [`creator.application_${action}.v1`, "creator.application_outcome_email.v1"]) await insertOutboxEvent(tx, { eventType, eventVersion: 1, aggregateType: "creator_application", aggregateId: application.id, payload: { applicationId: application.id, applicantUserId: application.userId, revisionId: command.revisionId, state: nextState, correlationId: command.requestId }, occurredAt: at });
        policy(await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: resultReference(application.id, nextState), completedAt: at }), "idempotency_failed");
        return { state: nextState };
      });
    },

    async setCreatorCapability(command: { ownerUserId: string; ownerSessionId: string; stepUpProofId: string; userId: string; action: "suspend" | "reinstate"; reasonCode: string; applicantExplanation: string; privateNote?: string; idempotencyKey: string; requestId: string }) {
      const at = now();
      const reasonCode = bounded(command.reasonCode, 1, 100);
      const applicantExplanation = bounded(command.applicantExplanation, 1, 2000);
      const privateNote = command.privateNote === undefined ? null : bounded(command.privateNote, 1, 1000);
      policy(reasonCode && reasonCodes.has(reasonCode) && applicantExplanation && (command.privateNote === undefined || privateNote), "invalid_decision");
      const fingerprint = reviewFingerprint(input, { idempotencyKey: command.idempotencyKey, userId: command.userId, action: command.action, reasonCode, applicantExplanation, privateNote });
      return input.db.transaction(async (tx) => {
        const started = await beginIdempotentCommand(tx, { actorUserId: command.ownerUserId, commandScope: `creator.capability.${command.action}`, ...fingerprint, now: at, expiresAt: new Date(at.getTime() + IDEMPOTENCY_LIFETIME_MS) });
        if (started.kind === "replay") {
          const match = /^creator-capability-v1:(active|suspended)$/u.exec(started.resultReference);
          policy(match, "idempotency_invalid");
          return { state: match[1]! };
        }
        policy(started.kind === "acquired", "idempotency_conflict");
        const [capability] = await tx.select().from(identityCreatorCapabilities).where(eq(identityCreatorCapabilities.userId, command.userId)).limit(1).for("update");
        policy(capability, "creator_capability_missing");
        const expectedState = command.action === "suspend" ? "active" : "suspended";
        policy(capability.state === expectedState, "invalid_capability_state");
        await requireStepUp(input, tx, { proofId: command.stepUpProofId, sessionId: command.ownerSessionId, userId: command.ownerUserId, actionClass: `owner.creator_capability_${command.action}`, now: at });
        if (command.action === "reinstate") {
          const [user] = await tx.select({ accessStatus: identityUsers.accessStatus, emailVerified: identityUsers.emailVerified }).from(identityUsers).where(eq(identityUsers.id, command.userId)).limit(1);
          policy(user?.accessStatus === "active" && user.emailVerified, "account_ineligible");
        }
        const nextState = command.action === "suspend" ? "suspended" : "active";
        const [updated] = await tx.update(identityCreatorCapabilities).set({ state: nextState, version: capability.version + 1, suspendedAt: command.action === "suspend" ? at : null, updatedAt: at }).where(and(eq(identityCreatorCapabilities.id, capability.id), eq(identityCreatorCapabilities.version, capability.version))).returning();
        policy(updated, "stale_version");
        await tx.insert(identityCreatorCapabilityEvents).values({ id: id(), capabilityId: capability.id, action: command.action === "suspend" ? "suspended" : "reinstated", state: nextState, version: updated.version, actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, stepUpProofId: command.stepUpProofId, reasonCode, requestId: command.requestId, createdAt: at });
        await tx.update(identityUsers).set({ authorizationVersion: sql`${identityUsers.authorizationVersion} + 1`, updatedAt: at }).where(eq(identityUsers.id, command.userId));
        await tx.update(identitySessions).set({ revokedAt: at, revocationReason: "creator_capability_changed", updatedAt: at }).where(and(eq(identitySessions.userId, command.userId), isNull(identitySessions.revokedAt)));
        await appendAdminAuditEvent(tx, { actorUserId: command.ownerUserId, actorSessionId: command.ownerSessionId, subjectType: "creator_capability", subjectId: capability.id, action: `creator.capability.${command.action}`, outcome: "succeeded", reasonCode, beforeState: { state: capability.state, version: capability.version }, afterState: { state: nextState, version: updated.version }, assurance: { method: "totp", actionClass: `owner.creator_capability_${command.action}` }, applicationRevision: capability.approvedRevisionId, requestId: command.requestId, occurredAt: at });
        await insertOutboxEvent(tx, { eventType: command.action === "suspend" ? "creator.capability_suspended.v1" : "creator.capability_reinstated.v1", eventVersion: 1, aggregateType: "creator_capability", aggregateId: capability.id, payload: { userId: command.userId, capabilityId: capability.id, state: nextState, correlationId: command.requestId }, occurredAt: at });
        await insertOutboxEvent(tx, { eventType: "creator.capability_outcome_email.v1", eventVersion: 1, aggregateType: "creator_capability", aggregateId: capability.id, payload: { userId: command.userId, capabilityId: capability.id, state: nextState, correlationId: command.requestId }, occurredAt: at });
        policy(await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: `creator-capability-v1:${nextState}`, completedAt: at }), "idempotency_failed");
        return { state: nextState };
      });
    },
  };
}
