import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, commissionOrders, commissionPackages, creatorPages,
  creatorPublicationRevisions, identityCreatorCapabilityEvents, insertOutboxEvent, publicContentReports, trustCases, trustPenalties, trustPenaltyEvents, trustReports,
  type PawketDatabase, type PawketTransaction,
} from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { createTrustCasePort, TrustCaseError, caseIdentifier } from "./case-port.js";
import { activePenalties } from "./penalty-port.js";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY, TRUST_PENALTY_KINDS, TRUST_PENALTY_REASONS, TRUST_PENALTY_TARGETS, TRUST_RESTRICTIONS,
  TrustEnforcementError, trustFail, type TrustEnforcementMode, type TrustPenaltyKind, type TrustPenaltyReason, type TrustPenaltyTarget, type TrustRestriction } from "./enforcement-policy.js";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";
import type { EnforcementNoticePort } from "./enforcement-notice-port.js";
import type { HelpLinkService } from "./help-link-service.js";

type Actor = Readonly<{ userId: string; sessionId: string }>;
type EnforcementActor = Actor & { stepUpProofId: string };
type CapabilityState = "active" | "suspended" | "removed";
type AccessStatus = "active" | "access_suspended" | "closed";
type Subject = { userId: string; accessStatus: AccessStatus; isOwner: boolean; capability: { id: string; state: CapabilityState; version: number } | null };
type StandingCommand = { actor: EnforcementActor | null; requestId: string; at: Date; penaltyId: string };
type OwnerCommand = Readonly<{ owner: Actor; stepUpProofId: string; idempotencyKey: string; requestId: string }>;
export type ApplyPenaltyCommand = OwnerCommand & Readonly<{ subjectUserId: string; source: { caseId: string } | { publicReportId: string }; kind: TrustPenaltyKind;
  restriction?: TrustRestriction; target?: TrustPenaltyTarget; endsAt?: string | null; reasonCategory: TrustPenaltyReason; explanation: string; internalNote?: string; freezeFulfilment?: boolean }>;
export type EndPenaltyCommand = Readonly<{ penaltyId: string; state: "expired" | "lifted" | "reversed" | "reduced"; actor: EnforcementActor | null; requestId: string; at: Date; reason: string | null }>;
type Input = Readonly<{ db: PawketDatabase; mode: TrustEnforcementMode; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; applicationRevision: string;
  consumeStepUpProof(tx: PawketTransaction, proof: { proofId: string; userId: string; sessionId: string; actionClass: string; now: Date }): Promise<boolean>;
  fence: { lockCreatorFence(tx: PawketTransaction, userId: string): Promise<void> };
  identity: { lockSubject(tx: PawketTransaction, userId: string): Promise<Subject | null>;
    setCreatorCapability(tx: PawketTransaction, c: StandingCommand & { userId: string; state: CapabilityState }): Promise<{ changed: boolean }>;
    setAccountAccess(tx: PawketTransaction, c: StandingCommand & { userId: string; status: AccessStatus }): Promise<{ changed: boolean }> };
  freeze: { freezeForRemoval(tx: PawketTransaction, c: { creatorUserId: string; actor: Actor; requestId: string; at: Date }): Promise<{ closedOrders: number }> };
  policies: { readCurrentIds(tx: PawketTransaction): Promise<{ enforcementRevisionId: string | null }> };
  helpLinks: Pick<HelpLinkService, "issue">; notices: EnforcementNoticePort; now?(): Date; idFactory?(): string }>;
type Penalty = typeof trustPenalties.$inferSelect;
const penaltyEndInstant = z.iso.datetime({ offset: true });

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== "object" || isProxy(value)) trustFail("invalid_request");
  const keys = Object.getOwnPropertyNames(value);
  const row = readExactOwnDataRecord(value, [[...required, ...optional.filter((key) => keys.includes(key))]]);
  if (!row) trustFail("invalid_request"); return row;
}
function actor(value: unknown): Actor {
  const row = exact(value, ["userId", "sessionId"]);
  if (!caseIdentifier(row.userId) || !caseIdentifier(row.sessionId)) trustFail("not_authorized");
  return { userId: row.userId, sessionId: row.sessionId };
}
function ownerCommand(row: Record<string, unknown>): OwnerCommand {
  if (!validUuid(row.stepUpProofId) || !caseIdentifier(row.idempotencyKey) || !caseIdentifier(row.requestId)) trustFail("invalid_request");
  return { owner: actor(row.owner), stepUpProofId: row.stepUpProofId, idempotencyKey: row.idempotencyKey, requestId: row.requestId };
}
function time(at: Date) { if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request"); return new Date(at); }
function normalizeApply(command: unknown, explanationMax: number = TRUST_ENFORCEMENT_POLICY.explanationMax) {
  const row = exact(command, ["owner", "stepUpProofId", "idempotencyKey", "requestId", "subjectUserId", "source", "kind", "reasonCategory", "explanation"], ["restriction", "target", "endsAt", "internalNote", "freezeFulfilment"]);
  const base = ownerCommand(row);
  if (!caseIdentifier(row.subjectUserId) || !(TRUST_PENALTY_KINDS as readonly unknown[]).includes(row.kind) || !(TRUST_PENALTY_REASONS as readonly unknown[]).includes(row.reasonCategory)) trustFail("invalid_request");
  const source = readExactOwnDataRecord(row.source, [["caseId"], ["publicReportId"]]);
  if (!source || !(validUuid(source.caseId) || validUuid(source.publicReportId))) trustFail("invalid_request");
  const kind = row.kind as TrustPenaltyKind;
  const restriction = row.restriction ?? null; const target = row.target ?? null;
  if (kind === "warning" && (restriction !== null || target !== null || row.endsAt != null)
    || kind === "restriction" && (!(TRUST_RESTRICTIONS as readonly unknown[]).includes(restriction) || target !== null)
    || (kind === "suspension" || kind === "removal") && (!(TRUST_PENALTY_TARGETS as readonly unknown[]).includes(target) || restriction !== null)
    || kind === "removal" && row.endsAt != null
    || row.freezeFulfilment !== undefined && (typeof row.freezeFulfilment !== "boolean" || kind !== "suspension" || target !== "creator_capability")) trustFail("invalid_request");
  let endsAt: Date | null = null;
  if (row.endsAt != null) {
    if (typeof row.endsAt !== "string" || !penaltyEndInstant.safeParse(row.endsAt).success) trustFail("invalid_request");
    endsAt = time(new Date(row.endsAt));
  }
  return { ...base, subjectUserId: row.subjectUserId, sourceCaseId: (source.caseId ?? null) as string | null, sourcePublicReportId: (source.publicReportId ?? null) as string | null,
    kind, restriction: restriction as TrustRestriction | null, target: target as TrustPenaltyTarget | null, endsAt, reasonCategory: row.reasonCategory as TrustPenaltyReason,
    explanation: normalizeTrustText(row.explanation, 1, explanationMax, { multiline: true }),
    internalNote: row.internalNote === undefined ? null : normalizeTrustText(row.internalNote, 1, TRUST_ENFORCEMENT_POLICY.internalNoteMax, { multiline: true }), freezeFulfilment: row.freezeFulfilment === true };
}

export function createPenaltyService(input: Input) {
  if (!["disabled", "enabled"].includes(input.mode) || input.lookupHmacKey.length < 32 || !caseIdentifier(input.applicationRevision)
    || typeof input.consumeStepUpProof !== "function" || typeof input.fence?.lockCreatorFence !== "function" || typeof input.identity?.lockSubject !== "function"
    || typeof input.freeze?.freezeForRemoval !== "function" || typeof input.policies?.readCurrentIds !== "function"
    || typeof input.helpLinks?.issue !== "function" || typeof input.notices?.queue !== "function") trustFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date()); const factory = input.idFactory ?? randomUUID;
  const now = () => time(clock()); const id = () => { const value = factory(); if (!validUuid(value)) trustFail("dependency_unavailable"); return value; };
  const cases = createTrustCasePort({ newId: id });
  const hash = (context: string, value: string) => createLookupHmac({ key, context, value });
  const encrypt = (recordType: string, recordId: string, fieldName: string, plaintext: string) => encryptSensitiveField({ keyring: input.keyring, plaintext, binding: { recordType, recordId, fieldName } });
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof TrustEnforcementError) throw error;
      if (error instanceof TrustCaseError) trustFail(error.code);
      if (error instanceof Error && "code" in error && ["ResolutionError", "CommissionError", "CommissionRefundError"].includes(error.name)
        && ["resolution_disabled", "version_conflict", "not_available"].includes(String(error.code))) trustFail(error.code as "resolution_disabled" | "version_conflict" | "not_available");
      return trustFail("dependency_unavailable");
    }
  }
  async function lockSubject(tx: PawketTransaction, userId: string) {
    await input.fence.lockCreatorFence(tx, userId);
    const subject = await input.identity.lockSubject(tx, userId); if (!subject) trustFail("not_available"); return subject;
  }
  async function proof(tx: PawketTransaction, c: OwnerCommand, actionClass: string, at: Date) {
    let accepted = false;
    try { accepted = await input.consumeStepUpProof(tx, { proofId: c.stepUpProofId, ...c.owner, actionClass, now: at }); } catch { trustFail("owner_step_up_required"); }
    if (!accepted) trustFail("owner_step_up_required");
  }
  async function begin(tx: PawketTransaction, userId: string, scope: string, keyValue: string, payload: unknown) {
    const digest = createHash("sha256").update(JSON.stringify([scope, payload])).digest("hex");
    const at = now(); const result = await beginIdempotentCommand(tx, { actorUserId: userId, commandScope: `trust.penalty_${scope}`,
      keyHash: hash("trust-penalty-command-key", keyValue), requestFingerprint: hash("trust-penalty-command", digest), now: at, expiresAt: new Date(at.getTime() + 86_400_000) });
    if (result.kind !== "acquired" && result.kind !== "replay") trustFail("idempotency_conflict"); return { result, at };
  }
  async function complete(tx: PawketTransaction, recordId: string, reference: string, at: Date) {
    const completedAt = now(); if (completedAt < at) trustFail("dependency_unavailable");
    if (!await completeIdempotentCommand(tx, { recordId, resultReference: reference, completedAt })) trustFail("idempotency_conflict");
  }
  async function record(tx: PawketTransaction, penalty: Penalty, action: typeof trustPenaltyEvents.$inferInsert.action, c: { actor: Actor | null; reason: string | null; requestId: string; at: Date }, expectedVersion: number) {
    const eventId = id(); await tx.insert(trustPenaltyEvents).values({ id: eventId, penaltyId: penalty.id, action, actorUserId: c.actor?.userId ?? null, actorSessionId: c.actor?.sessionId ?? null,
      reasonEnvelope: c.reason === null ? null : encrypt("trust_penalty_events", eventId, "reason", c.reason), requestId: c.requestId, expectedVersion, resultingVersion: expectedVersion + 1, occurredAt: c.at });
  }
  async function sourceCase(tx: PawketTransaction, caseId: string, userId: string) {
    const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, caseId)).limit(1).for("update"); if (!row) trustFail("not_available");
    let party = false;
    if (row.orderId !== null) {
      const [order] = await tx.select({ buyer: commissionOrders.buyerUserId, creator: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, row.orderId)).limit(1);
      party = order?.buyer === userId || order?.creator === userId;
    }
    const [report] = await tx.select({ owner: trustReports.contentOwnerUserId }).from(trustReports).where(and(eq(trustReports.caseId, caseId), eq(trustReports.contentOwnerUserId, userId))).limit(1);
    if (row.kind === "report" && row.sourceType === "commission_package") {
      const [pkg] = await tx.select({ creator: commissionPackages.creatorUserId }).from(commissionPackages).where(eq(commissionPackages.id, row.sourceId)).limit(1); party ||= pkg?.creator === userId;
    }
    if (!party && !report) trustFail("not_available"); return row;
  }
  async function sourcePublicReport(tx: PawketTransaction, reportId: string, userId: string) {
    const [row] = await tx.select({ id: publicContentReports.id }).from(publicContentReports)
      .innerJoin(creatorPublicationRevisions, eq(creatorPublicationRevisions.id, publicContentReports.publicationRevisionId))
      .innerJoin(creatorPages, eq(creatorPages.id, creatorPublicationRevisions.pageId))
      .where(and(eq(publicContentReports.id, reportId), eq(creatorPages.userId, userId))).limit(1);
    if (!row) trustFail("not_available");
  }
  async function audit(tx: PawketTransaction, c: OwnerCommand, penalty: Penalty, action: string, beforeState: Record<string, unknown> | null, at: Date) {
    await appendAdminAuditEvent(tx, { actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId, subjectType: "trust_penalty", subjectId: penalty.id, action, outcome: "succeeded", beforeState,
      afterState: { penaltyId: penalty.id, subjectUserId: penalty.subjectUserId, kind: penalty.kind, target: penalty.target, restriction: penalty.restriction, state: penalty.state,
        sourceCaseId: penalty.sourceCaseId, sourcePublicReportId: penalty.sourcePublicReportId, startsAt: penalty.startsAt.toISOString(), endsAt: penalty.endsAt?.toISOString() ?? null, endedAt: penalty.endedAt?.toISOString() ?? null },
      assurance: { method: "mfa", actionClass: action }, applicationRevision: input.applicationRevision, requestId: c.requestId, occurredAt: at });
  }
  async function recomputeStanding(tx: PawketTransaction, subjectUserId: string, c: StandingCommand): Promise<void> {
    if (!caseIdentifier(subjectUserId) || !validUuid(c.penaltyId) || !caseIdentifier(c.requestId)) trustFail("invalid_request"); time(c.at);
    const subject = await lockSubject(tx, subjectUserId); const active = await activePenalties(tx, subjectUserId, c.at);
    const capabilityPenalties = active.filter((p) => p.target === "creator_capability" || p.target === "account" && p.kind === "removal");
    const requiredCapabilityState: CapabilityState = capabilityPenalties.some((p) => p.kind === "removal") ? "removed" : capabilityPenalties.some((p) => p.kind === "suspension") ? "suspended" : "active";
    const accountPenalties = active.filter((p) => p.target === "account");
    const status: AccessStatus = accountPenalties.some((p) => p.kind === "removal") ? "closed" : accountPenalties.some((p) => p.kind === "suspension") ? "access_suspended" : "active";
    if (subject.capability) {
      const [legacy] = await tx.select({ state: identityCreatorCapabilityEvents.state }).from(identityCreatorCapabilityEvents)
        .where(and(eq(identityCreatorCapabilityEvents.capabilityId, subject.capability.id), isNull(identityCreatorCapabilityEvents.penaltyId)))
        .orderBy(desc(identityCreatorCapabilityEvents.version)).limit(1);
      // Penalties can strengthen, but never erase, the latest legacy capability baseline.
      const baseline = legacy?.state ?? "active";
      const capabilityState: CapabilityState = requiredCapabilityState === "removed" || baseline === "removed" ? "removed"
        : requiredCapabilityState === "suspended" || baseline === "suspended" ? "suspended" : "active";
      if (subject.capability.state !== capabilityState) await input.identity.setCreatorCapability(tx, { ...c, userId: subjectUserId, state: capabilityState });
    }
    const [ending] = await tx.select({ target: trustPenalties.target }).from(trustPenalties).where(eq(trustPenalties.id, c.penaltyId)).limit(1);
    if (subject.accessStatus !== status && (accountPenalties.length > 0 || ending?.target === "account")) await input.identity.setAccountAccess(tx, { ...c, userId: subjectUserId, status });
  }
  async function end(tx: PawketTransaction, c: EndPenaltyCommand, options: { skipLocked?: boolean } = {}): Promise<boolean> {
    if (!validUuid(c.penaltyId) || !["expired", "lifted", "reversed", "reduced"].includes(c.state) || !caseIdentifier(c.requestId)) trustFail("invalid_request"); const at = time(c.at);
    // Only actorless maintenance may skip a contended or already-ended penalty.
    if (options.skipLocked && (c.state !== "expired" || c.actor !== null)) trustFail("invalid_request");
    if (c.actor !== null) { actor({ userId: c.actor.userId, sessionId: c.actor.sessionId }); if (!validUuid(c.actor.stepUpProofId)) trustFail("invalid_request"); }
    const reason = c.reason === null ? null : normalizeTrustText(c.reason, 1, c.state === "reversed" || c.state === "reduced" ? TRUST_ENFORCEMENT_POLICY.decisionReasoningMax : TRUST_ENFORCEMENT_POLICY.actionReasonMax, { multiline: c.state === "reversed" || c.state === "reduced" });
    const [candidate] = await tx.select({ userId: trustPenalties.subjectUserId }).from(trustPenalties).where(eq(trustPenalties.id, c.penaltyId)).limit(1);
    if (!candidate) { if (options.skipLocked) return false; trustFail("not_available"); }
    await lockSubject(tx, candidate.userId);
    const [row] = await tx.select().from(trustPenalties).where(and(eq(trustPenalties.id, c.penaltyId),
      options.skipLocked ? and(eq(trustPenalties.state, "active"), lte(trustPenalties.endsAt, at)) : undefined)).limit(1).for("update", options.skipLocked ? { skipLocked: true } : {});
    if (!row) { if (options.skipLocked) return false; trustFail("not_available"); }
    if (row.state !== "active") trustFail("invalid_transition"); if (at < row.startsAt || row.version >= 2_147_483_647) trustFail("invalid_request");
    if (c.state === "expired" && (row.endsAt === null || row.endsAt > at)) trustFail("invalid_transition");
    const [ended] = await tx.update(trustPenalties).set({ state: c.state, endedAt: at, endReason: c.state, version: row.version + 1 }).where(and(eq(trustPenalties.id, row.id), eq(trustPenalties.version, row.version))).returning();
    if (!ended) trustFail("version_conflict");
    await record(tx, row, c.state, { ...c, reason, at }, row.version);
    await recomputeStanding(tx, row.subjectUserId, { ...c, at });
    await insertOutboxEvent(tx, { eventType: "trust.penalty_ended.v1", eventVersion: 1, aggregateType: "trust_penalty", aggregateId: row.id,
      payload: { penaltyId: row.id, subjectUserId: row.subjectUserId, state: c.state }, occurredAt: at });
    return true;
  }
  async function applyInternal(tx: PawketTransaction, c: ReturnType<typeof normalizeApply>, at: Date, replacesPenaltyId: string | null = null): Promise<{ penaltyId: string }> {
    const subject = await lockSubject(tx, c.subjectUserId); if (subject.isOwner) trustFail("not_authorized");
    if (c.target === "creator_capability" && !subject.capability) trustFail("not_available");
    const source = c.sourceCaseId === null ? null : await sourceCase(tx, c.sourceCaseId, c.subjectUserId);
    if (c.sourcePublicReportId !== null) await sourcePublicReport(tx, c.sourcePublicReportId, c.subjectUserId);

    if (c.endsAt !== null && (c.endsAt <= at || c.endsAt.getTime() - at.getTime() > 3_650 * 86_400_000)) trustFail("invalid_request");
    if (c.kind !== "warning") {
      const [duplicate] = await tx.select({ id: trustPenalties.id }).from(trustPenalties).where(and(eq(trustPenalties.subjectUserId, c.subjectUserId), eq(trustPenalties.state, "active"),
        lte(trustPenalties.startsAt, at), or(isNull(trustPenalties.endsAt), gt(trustPenalties.endsAt, at)),
        c.kind === "restriction" ? and(eq(trustPenalties.kind, "restriction"), eq(trustPenalties.restriction, c.restriction!)) : and(eq(trustPenalties.kind, c.kind), eq(trustPenalties.target, c.target!)))).limit(1);
      if (duplicate) trustFail("duplicate");
    }

    if (c.kind !== "warning") {
      // The active-row unique indexes also include penalties awaiting expiry maintenance.
      // End elapsed matches atomically before inserting their replacement, using the normal expiry path.
      const elapsed = await tx.select({ id: trustPenalties.id }).from(trustPenalties).where(and(
        eq(trustPenalties.subjectUserId, c.subjectUserId), eq(trustPenalties.state, "active"), lte(trustPenalties.startsAt, at), lte(trustPenalties.endsAt, at),
        c.kind === "restriction" ? and(eq(trustPenalties.kind, "restriction"), eq(trustPenalties.restriction, c.restriction!)) : and(eq(trustPenalties.kind, c.kind), eq(trustPenalties.target, c.target!)),
      )).for("update");
      for (const penalty of elapsed) await end(tx, { penaltyId: penalty.id, state: "expired", actor: null, requestId: c.requestId, at, reason: null });
    }
    const penaltyId = id(); const policy = await input.policies.readCurrentIds(tx);
    const [row] = await tx.insert(trustPenalties).values({ id: penaltyId, subjectUserId: c.subjectUserId, kind: c.kind, restriction: c.restriction, target: c.target, reasonCategory: c.reasonCategory,
      explanationEnvelope: encrypt("trust_penalties", penaltyId, "explanation", c.explanation), internalNoteEnvelope: c.internalNote === null ? null : encrypt("trust_penalties", penaltyId, "internal_note", c.internalNote),
      sourceCaseId: c.sourceCaseId, sourcePublicReportId: c.sourcePublicReportId, enforcementPolicyRevisionId: policy.enforcementRevisionId, replacesPenaltyId,
      startsAt: at, endsAt: c.endsAt, ownerUserId: c.owner.userId, ownerSessionId: c.owner.sessionId, stepUpProofId: c.stepUpProofId, requestId: c.requestId, createdAt: at }).returning();
    if (!row) trustFail("dependency_unavailable");
    await record(tx, row, "applied", { actor: c.owner, reason: null, requestId: c.requestId, at }, 0);
    if (source?.state === "open") await cases.recordCaseEvent(tx, { caseId: source.id, action: "penalty_applied", actor: c.owner, reason: null, requestId: c.requestId, at });
    const effect = { actor: { ...c.owner, stepUpProofId: c.stepUpProofId }, requestId: c.requestId, at, penaltyId, userId: c.subjectUserId };
    // Recompute prevents a new suspension from weakening a pre-existing removal.
    if (c.kind === "suspension" || c.kind === "removal") await recomputeStanding(tx, c.subjectUserId, effect);
    if (c.target === "account" && (c.kind === "suspension" || c.kind === "removal")) {
      const { token } = await input.helpLinks.issue(tx, { userId: c.subjectUserId, penaltyId, at }, { subjectLocked: true });
      await input.notices.queue(tx, { userId: c.subjectUserId, penaltyId, token, kind: c.kind, endsAt: c.endsAt, at });
    }
    if (c.kind === "removal" && (c.target === "creator_capability" || subject.capability) || c.freezeFulfilment) {
      await input.freeze.freezeForRemoval(tx, { creatorUserId: c.subjectUserId, actor: c.owner, requestId: c.requestId, at });
    }
    await audit(tx, c, row, replacesPenaltyId === null ? "owner.trust_penalty_apply" : "owner.trust_appeal_decide", null, at);
    await insertOutboxEvent(tx, { eventType: "trust.penalty_applied.v1", eventVersion: 1, aggregateType: "trust_penalty", aggregateId: penaltyId, payload: { penaltyId, subjectUserId: c.subjectUserId, kind: c.kind }, occurredAt: at });
    return { penaltyId };
  }
  /** Internal appeal path: caller owns the subject fence, user lock and decision proof in this transaction. */
  async function applyReplacement(tx: PawketTransaction, command: ApplyPenaltyCommand & { replacesPenaltyId: string }, at: Date) {
    if (input.mode !== "enabled") trustFail("enforcement_disabled");
    const { replacesPenaltyId, ...application } = command;
    if (!validUuid(replacesPenaltyId)) trustFail("invalid_request");
    return applyInternal(tx, normalizeApply(application, TRUST_ENFORCEMENT_POLICY.decisionReasoningMax), time(at), replacesPenaltyId);
  }
  function projection(row: Penalty) {
    return { penaltyId: row.id, subjectUserId: row.subjectUserId, kind: row.kind, restriction: row.restriction, target: row.target, state: row.state, reasonCategory: row.reasonCategory,
      explanation: decryptSensitiveField({ keyring: input.keyring, envelope: row.explanationEnvelope, binding: { recordType: "trust_penalties", recordId: row.id, fieldName: "explanation" } }),
      sourceCaseId: row.sourceCaseId, sourcePublicReportId: row.sourcePublicReportId, enforcementPolicyRevisionId: row.enforcementPolicyRevisionId,
      startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null, endedAt: row.endedAt?.toISOString() ?? null, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, version: row.version };
  }
  return {
    end, recomputeStanding, applyReplacement,
    async apply(command: ApplyPenaltyCommand): Promise<{ penaltyId: string }> {
      if (input.mode !== "enabled") trustFail("enforcement_disabled"); const c = normalizeApply(command);
      return boundary(() => input.db.transaction(async (tx) => {
        const { result: started, at: startedAt } = await begin(tx, c.owner.userId, "apply", c.idempotencyKey, [c.subjectUserId, c.sourceCaseId, c.sourcePublicReportId, c.kind, c.restriction, c.target, c.endsAt, c.reasonCategory, c.explanation, c.internalNote, c.freezeFulfilment]);
        if (started.kind === "replay") return { penaltyId: started.resultReference };
        // Lock before consuming the proof; internal application reuses this same fence and subject.
        await lockSubject(tx, c.subjectUserId);
        const at = now(); if (at < startedAt) trustFail("dependency_unavailable");
        await proof(tx, c, "owner.trust_penalty_apply", at);
        const { penaltyId } = await applyInternal(tx, c, at);
        await complete(tx, started.recordId, penaltyId, at); return { penaltyId };
      }));
    },
    async lift(command: OwnerCommand & { penaltyId: string; reason: string }): Promise<void> {
      if (input.mode !== "enabled") trustFail("enforcement_disabled"); const row = exact(command, ["owner", "stepUpProofId", "idempotencyKey", "requestId", "penaltyId", "reason"]); const c = ownerCommand(row);
      if (!validUuid(row.penaltyId)) trustFail("invalid_request"); const penaltyId = row.penaltyId; const reason = normalizeTrustText(row.reason, 1, TRUST_ENFORCEMENT_POLICY.actionReasonMax);
      await boundary(() => input.db.transaction(async (tx) => {
        const { result: started } = await begin(tx, c.owner.userId, "lift", c.idempotencyKey, [penaltyId, reason]); if (started.kind === "replay") return;
        const [candidate] = await tx.select().from(trustPenalties).where(eq(trustPenalties.id, penaltyId)).limit(1); if (!candidate) trustFail("not_available");
        await lockSubject(tx, candidate.subjectUserId); const at = now(); await proof(tx, c, "owner.trust_penalty_lift", at);
        await end(tx, { penaltyId, state: "lifted", actor: { ...c.owner, stepUpProofId: c.stepUpProofId }, requestId: c.requestId, at, reason });
        const [ended] = await tx.select().from(trustPenalties).where(eq(trustPenalties.id, penaltyId)).limit(1); if (!ended) trustFail("dependency_unavailable");
        await audit(tx, c, ended, "owner.trust_penalty_lift", { penaltyId, state: candidate.state }, at); await complete(tx, started.recordId, penaltyId, at);
      }));
    },
    async acknowledgeWarning(command: { actor: Actor; penaltyId: string; idempotencyKey: string; requestId: string }): Promise<void> {
      if (input.mode !== "enabled") trustFail("enforcement_disabled"); const row = exact(command, ["actor", "penaltyId", "idempotencyKey", "requestId"]); const party = actor(row.actor);
      if (!validUuid(row.penaltyId) || !caseIdentifier(row.idempotencyKey) || !caseIdentifier(row.requestId)) trustFail("invalid_request");
      const penaltyId = row.penaltyId; const requestId = row.requestId; const keyValue = row.idempotencyKey;
      await boundary(() => input.db.transaction(async (tx) => {
        const { result: started } = await begin(tx, party.userId, "acknowledge", keyValue, [penaltyId]); if (started.kind === "replay") return;
        await lockSubject(tx, party.userId);
        const [penalty] = await tx.select().from(trustPenalties).where(and(eq(trustPenalties.id, penaltyId), eq(trustPenalties.subjectUserId, party.userId))).limit(1).for("update");
        if (!penalty || penalty.kind !== "warning") trustFail("not_available"); const at = now(); if (at < penalty.startsAt) trustFail("invalid_request");
        if (penalty.acknowledgedAt === null) {
          if (penalty.version >= 2_147_483_647) trustFail("invalid_transition");
          await tx.update(trustPenalties).set({ acknowledgedAt: at, version: penalty.version + 1 }).where(eq(trustPenalties.id, penaltyId));
          await record(tx, penalty, "acknowledged", { actor: party, reason: null, requestId, at }, penalty.version);
        }
        await complete(tx, started.recordId, penaltyId, at);
      }));
    },
    async listForSubject(userId: string) {
      if (!caseIdentifier(userId)) trustFail("invalid_request");
      return boundary(async () => (await input.db.select().from(trustPenalties).where(eq(trustPenalties.subjectUserId, userId)).orderBy(desc(trustPenalties.createdAt), desc(trustPenalties.id))).map(projection));
    },
    async listActive(filter: { subjectUserId?: string; kind?: TrustPenaltyKind; limit?: number } = {}) {
      const f = exact(filter, [], ["subjectUserId", "kind", "limit"]);
      if (f.subjectUserId !== undefined && !caseIdentifier(f.subjectUserId) || f.kind !== undefined && !(TRUST_PENALTY_KINDS as readonly unknown[]).includes(f.kind)
        || f.limit !== undefined && (typeof f.limit !== "number" || !Number.isSafeInteger(f.limit) || f.limit < 1 || f.limit > 100)) trustFail("invalid_request");
      const at = now(); return boundary(async () => (await input.db.select().from(trustPenalties).where(and(eq(trustPenalties.state, "active"), lte(trustPenalties.startsAt, at), or(isNull(trustPenalties.endsAt), gt(trustPenalties.endsAt, at)),
        f.subjectUserId === undefined ? undefined : eq(trustPenalties.subjectUserId, f.subjectUserId as string), f.kind === undefined ? undefined : eq(trustPenalties.kind, f.kind as TrustPenaltyKind)))
        .orderBy(asc(trustPenalties.startsAt), asc(trustPenalties.id)).limit((f.limit as number | undefined) ?? 50)).map(projection));
    },
  };
}
export type PenaltyService = ReturnType<typeof createPenaltyService>;
