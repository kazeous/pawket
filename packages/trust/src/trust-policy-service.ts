import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, trustPolicyCurrent, trustPolicyRevisions,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY, TRUST_POLICY_KINDS, TrustEnforcementError, trustFail, type TrustPolicyKind } from "./enforcement-policy.js";

export type TrustPolicySnapshot = Readonly<{ revisionId: string; kind: TrustPolicyKind; revisionNumber: number; document: string; checksum: string; effectiveAt: string }>;
export type TrustPolicyPublishCommand = Readonly<{ owner: { userId: string; sessionId: string }; stepUpProofId: string;
  idempotencyKey: string; requestId: string; kind: TrustPolicyKind; expectedRevisionNumber: number; document: string }>;
type Input = Readonly<{ db: PawketDatabase; applicationRevision: string;
  consumeStepUpProof(tx: PawketTransaction, input: Readonly<{ proofId: string; sessionId: string; userId: string; actionClass: string; now: Date }>): Promise<boolean>;
  now?(): Date; idFactory?(): string }>;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const policyKind = (value: unknown): value is TrustPolicyKind => typeof value === "string" && (TRUST_POLICY_KINDS as readonly string[]).includes(value);
const digest = (value: string) => `sha256:v1:${createHash("sha256").update(value, "utf8").digest("base64url")}`;
async function available<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { if (error instanceof TrustEnforcementError) throw error; return trustFail("dependency_unavailable"); }
}

/** Owner authorization and the 60-minute proof window are enforced by the injected identity proof port. */
export function createTrustPolicyService(input: Input) {
  if (!identifier(input.applicationRevision) || typeof input.consumeStepUpProof !== "function") trustFail("invalid_request");
  const clock = input.now ?? (() => new Date()); const idFactory = input.idFactory ?? randomUUID;
  const now = () => {
    const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request");
    return new Date(at);
  };
  const currentRows = (db: PawketDatabase | PawketTransaction, at: Date, kind?: TrustPolicyKind) => db.select({ revisionId: trustPolicyRevisions.id,
    kind: trustPolicyRevisions.kind, revisionNumber: trustPolicyRevisions.revisionNumber, document: trustPolicyRevisions.document,
    checksum: trustPolicyRevisions.checksum, effectiveAt: trustPolicyRevisions.effectiveAt }).from(trustPolicyCurrent)
    .innerJoin(trustPolicyRevisions, eq(trustPolicyCurrent.revisionId, trustPolicyRevisions.id))
    .where(and(kind === undefined ? undefined : eq(trustPolicyCurrent.kind, kind), lte(trustPolicyRevisions.effectiveAt, at), lte(trustPolicyRevisions.createdAt, at)));
  return {
    async readCurrent(kind: TrustPolicyKind): Promise<TrustPolicySnapshot | null> {
      if (!policyKind(kind)) trustFail("invalid_request");
      return available(async () => {
        const [row] = await currentRows(input.db, now(), kind);
        return row ? { ...row, effectiveAt: row.effectiveAt.toISOString() } : null;
      });
    },
    async readRevision(revisionId: string): Promise<TrustPolicySnapshot | null> {
      if (!validUuid(revisionId)) return null;
      return available(async () => {
        const at = now();
        const [row] = await input.db.select({ revisionId: trustPolicyRevisions.id, kind: trustPolicyRevisions.kind,
          revisionNumber: trustPolicyRevisions.revisionNumber, document: trustPolicyRevisions.document,
          checksum: trustPolicyRevisions.checksum, effectiveAt: trustPolicyRevisions.effectiveAt }).from(trustPolicyRevisions)
          .where(and(eq(trustPolicyRevisions.id, revisionId), lte(trustPolicyRevisions.effectiveAt, at), lte(trustPolicyRevisions.createdAt, at))).limit(1);
        return row ? { ...row, effectiveAt: row.effectiveAt.toISOString() } : null;
      });
    },
    async readCurrentIds(tx: PawketTransaction): Promise<{ communityRulesRevisionId: string | null; enforcementRevisionId: string | null }> {
      return available(async () => {
        const rows = await currentRows(tx, now());
        return { communityRulesRevisionId: rows.find((row) => row.kind === "community_rules")?.revisionId ?? null,
          enforcementRevisionId: rows.find((row) => row.kind === "enforcement_appeals")?.revisionId ?? null };
      });
    },
    async publish(command: TrustPolicyPublishCommand): Promise<{ revisionId: string; revisionNumber: number }> {
      const record = readExactOwnDataRecord(command, [["owner", "stepUpProofId", "idempotencyKey", "requestId", "kind", "expectedRevisionNumber", "document"]]);
      if (!record) trustFail("invalid_request");
      const actor = readExactOwnDataRecord(record.owner, [["userId", "sessionId"]]);
      if (!actor || !identifier(actor.userId) || !identifier(actor.sessionId)) trustFail("not_authorized");
      const owner = { userId: actor.userId, sessionId: actor.sessionId };
      if (!identifier(record.stepUpProofId) || !identifier(record.idempotencyKey) || !identifier(record.requestId) || !policyKind(record.kind)
        || typeof record.expectedRevisionNumber !== "number" || !Number.isSafeInteger(record.expectedRevisionNumber)
        || record.expectedRevisionNumber < 0 || record.expectedRevisionNumber >= 2_147_483_647) trustFail("invalid_request");
      const { kind, expectedRevisionNumber, stepUpProofId, requestId, idempotencyKey } = record;
      const document = normalizeTrustText(record.document, 1, TRUST_ENFORCEMENT_POLICY.policyDocumentMax, { multiline: true });
      return available(() => input.db.transaction(async (tx) => {
        const startedAt = now();
        const started = await beginIdempotentCommand(tx, { actorUserId: owner.userId, commandScope: "trust.policy_publish",
          keyHash: digest(JSON.stringify(["trust-policy-key", idempotencyKey])),
          requestFingerprint: digest(JSON.stringify(["trust-policy-publish", kind, expectedRevisionNumber, document])),
          now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
        if (started.kind === "replay") {
          const [row] = await tx.select({ revisionId: trustPolicyRevisions.id, revisionNumber: trustPolicyRevisions.revisionNumber })
            .from(trustPolicyRevisions).where(eq(trustPolicyRevisions.id, started.resultReference)).limit(1);
          if (!row) trustFail("dependency_unavailable");
          return row;
        }
        if (started.kind !== "acquired") trustFail("idempotency_conflict");
        // Serialize the first publication as well as updates to an existing kind.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trust:policy:${kind}`}, 0))`);
        const [head] = await tx.select({ revisionId: trustPolicyCurrent.revisionId }).from(trustPolicyCurrent)
          .where(eq(trustPolicyCurrent.kind, kind)).limit(1).for("update");
        const [previous] = head ? await tx.select({ revisionNumber: trustPolicyRevisions.revisionNumber })
          .from(trustPolicyRevisions).where(eq(trustPolicyRevisions.id, head.revisionId)).limit(1) : [];
        if (head && !previous) trustFail("dependency_unavailable");
        if ((previous?.revisionNumber ?? 0) !== expectedRevisionNumber) trustFail("version_conflict");
        const at = now(); let accepted = false;
        try { accepted = await input.consumeStepUpProof(tx, { proofId: stepUpProofId, ...owner, actionClass: "owner.trust_policy_publish", now: at }); }
        catch { trustFail("owner_step_up_required"); }
        if (!accepted) trustFail("owner_step_up_required");
        const revisionId = idFactory(); if (!validUuid(revisionId)) trustFail("dependency_unavailable");
        const revisionNumber = expectedRevisionNumber + 1;
        await tx.insert(trustPolicyRevisions).values({ id: revisionId, kind, revisionNumber, document, approvalKind: "owner_reviewed",
          actorUserId: owner.userId, actorSessionId: owner.sessionId, checksum: `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`,
          source: input.applicationRevision, effectiveAt: at, createdAt: at });
        await tx.insert(trustPolicyCurrent).values({ kind, revisionId, updatedAt: at })
          .onConflictDoUpdate({ target: trustPolicyCurrent.kind, set: { revisionId, updatedAt: at } });
        await appendAdminAuditEvent(tx, { actorUserId: owner.userId, actorSessionId: owner.sessionId, subjectType: "trust_policy", subjectId: revisionId,
          action: "owner.trust_policy_publish", outcome: "succeeded", beforeState: { kind, revisionNumber: expectedRevisionNumber },
          afterState: { kind, revisionId, revisionNumber }, assurance: { method: "mfa", actionClass: "owner.trust_policy_publish" },
          applicationRevision: input.applicationRevision, requestId, occurredAt: at });
        const completedAt = now(); if (completedAt < at || at < startedAt) trustFail("dependency_unavailable");
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: revisionId, completedAt })) trustFail("idempotency_conflict");
        return { revisionId, revisionNumber };
      }));
    },
  };
}
export type TrustPolicyService = ReturnType<typeof createTrustPolicyService>;
