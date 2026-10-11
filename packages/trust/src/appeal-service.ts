import { createHash, randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, trustAppeals, trustCases,
  trustContentHides, trustPenalties, trustPolicyCurrent, trustPolicyRevisions, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, decryptSensitiveField, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { caseActor, caseIdentifier, createTrustCasePort, TrustCaseError, type TrustCaseActor } from "./case-port.js";
import { effectiveEnforcementDeadline } from "./enforcement-deadlines.js";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY as policy, TRUST_RESTRICTIONS, TRUST_PENALTY_TARGETS,
  TrustEnforcementError, trustFail, type TrustEnforcementMode, type TrustRestriction, type TrustPenaltyTarget } from "./enforcement-policy.js";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";
import type { PenaltyService } from "./penalty-service.js";
import type { ContentHideService } from "./content-hide-service.js";
import type { HelpLinkService } from "./help-link-service.js";

type Appellant = { kind: "session"; actor: TrustCaseActor } | { kind: "help_session"; sessionToken: string };
export type AppealTarget = { penaltyId: string } | { hideId: string };
export type SubmitAppealCommand = { appellant: Appellant; target: AppealTarget; statement: string; idempotencyKey: string; requestId: string };
export type AppealReplacement = { kind: "restriction" | "suspension"; restriction?: TrustRestriction; target?: TrustPenaltyTarget; endsAt: string | null };
export type DecideAppealCommand = { owner: TrustCaseActor; stepUpProofId: string; idempotencyKey: string; requestId: string; caseId: string;
  expectedCaseVersion: number; decision: "upheld" | "reduced" | "reversed"; reasoning: string; replacement?: AppealReplacement };
type PenaltyInput = Parameters<typeof import("./penalty-service.js").createPenaltyService>[0];
type Input = { db: PawketDatabase; mode: TrustEnforcementMode; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; applicationRevision: string;
  consumeStepUpProof: PenaltyInput["consumeStepUpProof"]; penalties: Pick<PenaltyService, "end" | "recomputeStanding" | "applyReplacement">;
  hides: Pick<ContentHideService, "releaseForAppeal">; helpLinks: Pick<HelpLinkService, "readSession">;
  fence: PenaltyInput["fence"]; identity: Pick<PenaltyInput["identity"], "lockSubject">; now?(): Date; idFactory?(): string };
type Appeal = typeof trustAppeals.$inferSelect;

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (value === null || typeof value !== "object" || isProxy(value)) trustFail("invalid_request");
  const names = Object.getOwnPropertyNames(value);
  const row = readExactOwnDataRecord(value, [[...required, ...optional.filter((key) => names.includes(key))]]);
  if (!row) trustFail("invalid_request"); return row;
}
function instant(at: Date) { if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request"); return new Date(at); }
function common(row: Record<string, unknown>) {
  if (!caseIdentifier(row.idempotencyKey) || !caseIdentifier(row.requestId)) trustFail("invalid_request");
  return { idempotencyKey: row.idempotencyKey, requestId: row.requestId };
}
function normalizeSubmit(command: unknown): SubmitAppealCommand {
  const row = exact(command, ["appellant", "target", "statement", "idempotencyKey", "requestId"]);
  const appellant = readExactOwnDataRecord(row.appellant, [["kind", "actor"], ["kind", "sessionToken"]]);
  let normalized: Appellant;
  if (appellant?.kind === "session" && "actor" in appellant) normalized = { kind: "session", actor: caseActor(appellant.actor) };
  else if (appellant?.kind === "help_session" && typeof appellant.sessionToken === "string") normalized = { kind: "help_session", sessionToken: appellant.sessionToken };
  else trustFail("invalid_request");
  const target = readExactOwnDataRecord(row.target, [["penaltyId"], ["hideId"]]);
  if (!target || !(validUuid(target.penaltyId) || validUuid(target.hideId))) trustFail("invalid_request");
  return { ...common(row), appellant: normalized, target: target as AppealTarget, statement: normalizeTrustText(row.statement, 1, policy.appealStatementMax, { multiline: true }) };
}
function normalizeDecision(command: unknown): DecideAppealCommand {
  const row = exact(command, ["owner", "stepUpProofId", "idempotencyKey", "requestId", "caseId", "expectedCaseVersion", "decision", "reasoning"], ["replacement"]);
  if (!validUuid(row.stepUpProofId) || !validUuid(row.caseId) || typeof row.expectedCaseVersion !== "number" || !Number.isSafeInteger(row.expectedCaseVersion)
    || row.expectedCaseVersion < 1 || row.expectedCaseVersion >= 2_147_483_647 || !["upheld", "reduced", "reversed"].includes(row.decision as string)) trustFail("invalid_request");
  let replacement: AppealReplacement | undefined;
  if (row.decision === "reduced") {
    const r = exact(row.replacement, ["kind", "endsAt"], ["restriction", "target"]);
    if (r.kind !== "restriction" && r.kind !== "suspension" || r.endsAt !== null && (typeof r.endsAt !== "string" || !z.iso.datetime({ offset: true }).safeParse(r.endsAt).success)
      || r.kind === "restriction" && (!(TRUST_RESTRICTIONS as readonly unknown[]).includes(r.restriction) || r.target !== undefined)
      || r.kind === "suspension" && (!(TRUST_PENALTY_TARGETS as readonly unknown[]).includes(r.target) || r.restriction !== undefined)) trustFail("invalid_request");
    replacement = r as AppealReplacement;
  } else if (row.replacement !== undefined) trustFail("invalid_request");
  return { ...common(row), owner: caseActor(row.owner), stepUpProofId: row.stepUpProofId, caseId: row.caseId, expectedCaseVersion: row.expectedCaseVersion,
    decision: row.decision as DecideAppealCommand["decision"], reasoning: normalizeTrustText(row.reasoning, 1, policy.decisionReasoningMax, { multiline: true }),
    ...(replacement === undefined ? {} : { replacement }) };
}
function milder(original: typeof trustPenalties.$inferSelect, replacement: AppealReplacement, at: Date) {
  const endsAt = replacement.endsAt === null ? null : instant(new Date(replacement.endsAt));
  const ranks = { warning: 0, restriction: 1, suspension: 2, removal: 3 };
  if (endsAt !== null && endsAt <= at || ranks[replacement.kind] > ranks[original.kind]
    || replacement.kind === original.kind && (endsAt === null || original.endsAt !== null && endsAt >= original.endsAt)) trustFail("invalid_request");
}

export function createAppealService(input: Input) {
  if (!["enabled", "disabled"].includes(input.mode) || input.lookupHmacKey.length < 32 || !caseIdentifier(input.applicationRevision)
    || typeof input.consumeStepUpProof !== "function" || typeof input.penalties?.applyReplacement !== "function" || typeof input.penalties?.end !== "function"
    || typeof input.hides?.releaseForAppeal !== "function" || typeof input.helpLinks?.readSession !== "function"
    || typeof input.fence?.lockCreatorFence !== "function" || typeof input.identity?.lockSubject !== "function") trustFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date()); const factory = input.idFactory ?? randomUUID;
  const now = () => instant(clock()); const id = () => { const value = factory(); if (!validUuid(value)) trustFail("dependency_unavailable"); return value; };
  const cases = createTrustCasePort({ newId: id });
  const hash = (context: string, value: string) => createLookupHmac({ key, context, value });
  const encrypt = (appealId: string, fieldName: string, plaintext: string) => encryptSensitiveField({ keyring: input.keyring, plaintext, binding: { recordType: "trust_appeals", recordId: appealId, fieldName } });
  async function boundary<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof TrustEnforcementError) throw error;
      if (error instanceof TrustCaseError) trustFail(error.code);
      return trustFail("dependency_unavailable");
    }
  }
  async function begin(tx: PawketTransaction, userId: string, scope: string, keyValue: string, payload: unknown) {
    const at = now(); const result = await beginIdempotentCommand(tx, { actorUserId: userId, commandScope: `trust.appeal_${scope}`,
      keyHash: hash("trust-appeal-command-key", keyValue),
      // The HMAC helper bounds inputs at 8192 bytes; 4000 Unicode code points can exceed that bound.
      requestFingerprint: hash("trust-appeal-command", createHash("sha256").update(JSON.stringify([scope, payload]), "utf8").digest("hex")), now: at,
      expiresAt: new Date(at.getTime() + 86_400_000) });
    if (result.kind !== "acquired" && result.kind !== "replay") trustFail("idempotency_conflict"); return result;
  }
  async function complete(tx: PawketTransaction, recordId: string, caseId: string, at: Date) {
    const completedAt = now(); if (completedAt < at) trustFail("dependency_unavailable");
    if (!await completeIdempotentCommand(tx, { recordId, resultReference: caseId, completedAt })) trustFail("idempotency_conflict");
  }
  async function subject(tx: PawketTransaction, userId: string) {
    await input.fence.lockCreatorFence(tx, userId);
    if (!await input.identity.lockSubject(tx, userId)) trustFail("not_available");
  }
  function projection(row: Appeal) {
    const decrypt = (fieldName: string, envelope: NonNullable<Appeal["reasoningEnvelope"]>) => decryptSensitiveField({ keyring: input.keyring, envelope, binding: { recordType: "trust_appeals", recordId: row.id, fieldName } });
    return { appealId: row.id, caseId: row.caseId, penaltyId: row.penaltyId, hideId: row.hideId, statement: decrypt("statement", row.statementEnvelope),
      state: row.state, submittedVia: row.submittedVia, reasoning: row.reasoningEnvelope === null ? null : decrypt("reasoning", row.reasoningEnvelope),
      decidedAt: row.decidedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), version: row.version };
  }
  return {
    async submit(command: SubmitAppealCommand): Promise<{ appealId: string; caseId: string }> {
      if (input.mode !== "enabled") trustFail("enforcement_disabled");
      return boundary(async () => {
        const c = normalizeSubmit(command);
        let help = c.appellant.kind === "help_session" ? await input.helpLinks.readSession(c.appellant.sessionToken) : null;
        if (c.appellant.kind === "help_session" && (!help || !("penaltyId" in c.target) || help.penaltyId !== c.target.penaltyId)) trustFail("not_available");
        const userId = c.appellant.kind === "session" ? c.appellant.actor.userId : help!.userId;
        return input.db.transaction(async (tx) => {
          const started = await begin(tx, userId, "submit", c.idempotencyKey, [c.target, c.statement, c.appellant.kind]);
          if (started.kind === "replay") {
            const [row] = await tx.select().from(trustAppeals).where(and(eq(trustAppeals.caseId, started.resultReference), eq(trustAppeals.appellantUserId, userId))).limit(1);
            if (!row) trustFail("dependency_unavailable"); return { appealId: row.id, caseId: row.caseId };
          }
          await subject(tx, userId);
          // Recheck under the user's lock: a link resend or penalty transition may have won the fence meanwhile.
          if (c.appellant.kind === "help_session") {
            const current = await input.helpLinks.readSession(c.appellant.sessionToken, tx);
            if (!current || current.userId !== userId || !("penaltyId" in c.target) || current.penaltyId !== c.target.penaltyId) trustFail("not_available");
            help = current;
          }
          const penalty = "penaltyId" in c.target ? (await tx.select().from(trustPenalties).where(and(eq(trustPenalties.id, c.target.penaltyId), eq(trustPenalties.subjectUserId, userId))).limit(1).for("update"))[0] : null;
          const hide = "hideId" in c.target ? (await tx.select().from(trustContentHides).where(and(eq(trustContentHides.id, c.target.hideId), eq(trustContentHides.contentOwnerUserId, userId))).limit(1).for("update"))[0] : null;
          if (!penalty && !hide) trustFail("not_available");
          if (penalty?.kind === "warning") trustFail("invalid_request");
          const [duplicate] = await tx.select({ id: trustAppeals.id }).from(trustAppeals).where(penalty ? eq(trustAppeals.penaltyId, penalty.id) : eq(trustAppeals.hideId, hide!.id)).limit(1);
          if (duplicate) trustFail("duplicate");
          const at = now(); const actionAt = penalty?.startsAt ?? hide!.hiddenAt;
          if (at < actionAt) trustFail("invalid_request");
          const deadline = await effectiveEnforcementDeadline(tx, new Date(actionAt.getTime() + policy.appealWindowMs));
          if (deadline === null) trustFail("enforcement_disabled");
          if (at >= deadline) trustFail("window_closed");
          if (help && !help.canAppeal) trustFail("not_available");
          const originalCaseId = penalty?.sourceCaseId ?? hide?.caseId ?? null;
          const original = originalCaseId === null ? null : await cases.readCase(tx, originalCaseId);
          const policies = await tx.select({ kind: trustPolicyRevisions.kind, id: trustPolicyRevisions.id }).from(trustPolicyCurrent)
            .innerJoin(trustPolicyRevisions, eq(trustPolicyRevisions.id, trustPolicyCurrent.revisionId))
            .where(and(lte(trustPolicyRevisions.effectiveAt, at), lte(trustPolicyRevisions.createdAt, at)));
          const appealId = id(); const { caseId } = await cases.openCase(tx, { kind: "appeal", sourceType: "trust_appeal", sourceId: appealId,
            orderId: original?.orderId ?? null, policyRevisionId: original?.policyRevisionId ?? null,
            communityPolicyRevisionId: policies.find((p) => p.kind === "community_rules")?.id ?? null,
            enforcementPolicyRevisionId: policies.find((p) => p.kind === "enforcement_appeals")?.id ?? null, requestId: c.requestId, at });
          await tx.insert(trustAppeals).values({ id: appealId, appellantUserId: userId, penaltyId: penalty?.id ?? null, hideId: hide?.id ?? null,
            caseId, statementEnvelope: encrypt(appealId, "statement", c.statement), submittedVia: c.appellant.kind === "session" ? "session" : "help_link", createdAt: at });
          await insertOutboxEvent(tx, { eventType: "trust.appeal_submitted.v1", eventVersion: 1, aggregateType: "trust_appeal", aggregateId: appealId, payload: { appealId, caseId }, occurredAt: at });
          await complete(tx, started.recordId, caseId, at); return { appealId, caseId };
        });
      });
    },
    async decide(command: DecideAppealCommand): Promise<void> {
      if (input.mode !== "enabled") trustFail("enforcement_disabled");
      await boundary(async () => {
        const c = normalizeDecision(command);
        await input.db.transaction(async (tx) => {
          const started = await begin(tx, c.owner.userId, "decide", c.idempotencyKey, [c.caseId, c.expectedCaseVersion, c.decision, c.reasoning, c.replacement ?? null]);
          if (started.kind === "replay") return;
          // Immutable routing metadata only, before any case, appeal or action row lock.
          const [candidate] = await tx.select().from(trustAppeals).where(eq(trustAppeals.caseId, c.caseId)).limit(1);
          if (!candidate) trustFail("not_available");
          await subject(tx, candidate.appellantUserId);
          const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, c.caseId)).limit(1).for("update");
          if (!row || row.kind !== "appeal" || row.state !== "open" || row.sourceId !== candidate.id) trustFail("not_available");
          if (row.version !== c.expectedCaseVersion) trustFail("version_conflict");
          const [appeal] = await tx.select().from(trustAppeals).where(eq(trustAppeals.id, candidate.id)).limit(1).for("update");
          if (!appeal || appeal.state !== "open") trustFail("invalid_transition");
          const penalty = appeal.penaltyId === null ? null : (await tx.select().from(trustPenalties).where(eq(trustPenalties.id, appeal.penaltyId)).limit(1).for("update"))[0];
          const hide = appeal.hideId === null ? null : (await tx.select().from(trustContentHides).where(eq(trustContentHides.id, appeal.hideId)).limit(1).for("update"))[0];
          if (!penalty && !hide) trustFail("not_available");
          const at = now(); if (at < appeal.createdAt) trustFail("invalid_request");
          if (c.decision === "reduced") {
            if (!penalty) trustFail("invalid_request");
            if (penalty.state !== "active" || penalty.endsAt !== null && penalty.endsAt <= at) trustFail("invalid_transition");
            milder(penalty, c.replacement!, at);
          }
          let accepted = false;
          try { accepted = await input.consumeStepUpProof(tx, { proofId: c.stepUpProofId, ...c.owner, actionClass: "owner.trust_appeal_decide", now: at }); }
          catch { trustFail("owner_step_up_required"); }
          if (!accepted) trustFail("owner_step_up_required");
          const actor = { ...c.owner, stepUpProofId: c.stepUpProofId };
          if (c.decision !== "upheld") {
            if (penalty) {
              const effect = { actor, requestId: c.requestId, at, penaltyId: penalty.id };
              if (penalty.state === "active") await input.penalties.end(tx, { ...effect, state: c.decision, reason: c.reasoning });
              else await input.penalties.recomputeStanding(tx, penalty.subjectUserId, effect);
              if (c.decision === "reduced") await input.penalties.applyReplacement(tx, { owner: c.owner, stepUpProofId: c.stepUpProofId,
                idempotencyKey: c.idempotencyKey, requestId: c.requestId, subjectUserId: penalty.subjectUserId,
                source: penalty.sourceCaseId === null ? { publicReportId: penalty.sourcePublicReportId! } : { caseId: penalty.sourceCaseId },
                reasonCategory: penalty.reasonCategory, explanation: c.reasoning, ...c.replacement!, replacesPenaltyId: penalty.id }, at);
            } else await input.hides.releaseForAppeal(tx, { hideId: hide!.id, requestId: c.requestId, at });
          }
          await tx.update(trustAppeals).set({ state: c.decision, reasoningEnvelope: encrypt(appeal.id, "reasoning", c.reasoning), decidedAt: at, decidedByUserId: c.owner.userId, version: appeal.version + 1 }).where(eq(trustAppeals.id, appeal.id));
          await cases.resolveCase(tx, { caseId: c.caseId, resolutionKind: c.decision, actor: c.owner, reason: null, requestId: c.requestId, at });
          await appendAdminAuditEvent(tx, { actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId, subjectType: "trust_appeal", subjectId: appeal.id,
            action: "owner.trust_appeal_decide", outcome: "succeeded", beforeState: { appealId: appeal.id, caseId: row.id, state: "open", caseVersion: row.version },
            afterState: { appealId: appeal.id, caseId: row.id, state: c.decision, caseVersion: row.version + 1 }, assurance: { method: "mfa", actionClass: "owner.trust_appeal_decide" },
            applicationRevision: input.applicationRevision, requestId: c.requestId, occurredAt: at });
          await insertOutboxEvent(tx, { eventType: "trust.appeal_decided.v1", eventVersion: 1, aggregateType: "trust_appeal", aggregateId: appeal.id, payload: { appealId: appeal.id, caseId: row.id, decision: c.decision }, occurredAt: at });
          await complete(tx, started.recordId, row.id, at);
        });
      });
    },
    async listForUser(userId: string) {
      if (!caseIdentifier(userId)) trustFail("invalid_request");
      return boundary(async () => (await input.db.select().from(trustAppeals).where(eq(trustAppeals.appellantUserId, userId))
        .orderBy(desc(trustAppeals.createdAt), desc(trustAppeals.id))).map(projection));
    },
  };
}
export type AppealService = ReturnType<typeof createAppealService>;
