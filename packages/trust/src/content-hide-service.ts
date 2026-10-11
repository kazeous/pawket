import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { appendAdminAuditEvent, beginIdempotentCommand, completeIdempotentCommand, insertOutboxEvent, trustCases, trustReports, trustContentHides, trustPenalties,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createLookupHmac, encryptSensitiveField, type EncryptionKeyring } from "@pawket/security";
import { createTrustCasePort, TrustCaseError } from "./case-port.js";
import { normalizeTrustText, TRUST_ENFORCEMENT_POLICY, TrustEnforcementError, trustFail, type TrustEnforcementMode } from "./enforcement-policy.js";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";

export type OwnerCase = Readonly<{ owner: { userId: string; sessionId: string }; stepUpProofId: string; idempotencyKey: string; requestId: string; caseId: string; expectedCaseVersion: number }>;
type Input = Readonly<{ db: PawketDatabase; mode: TrustEnforcementMode; keyring: EncryptionKeyring; lookupHmacKey: Uint8Array; applicationRevision: string;
  consumeStepUpProof(tx: PawketTransaction, proof: Readonly<{ proofId: string; sessionId: string; userId: string; actionClass: string; now: Date }>): Promise<boolean>;
  fence: { lockCreatorFence(tx: PawketTransaction, userId: string): Promise<void> }; now?(): Date; idFactory?(): string }>;
type Action = "hide" | "restore" | "report_close";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
const fields = ["owner", "stepUpProofId", "idempotencyKey", "requestId", "caseId", "expectedCaseVersion", "reason"];
function normalize(command: unknown, action: Action): OwnerCase & { reason: string; hideId?: string; resolution?: "dismissed" | "actioned" } {
  const row = readExactOwnDataRecord(command, [[...fields, ...(action === "restore" ? ["hideId"] : action === "report_close" ? ["resolution"] : [])]]);
  if (!row) trustFail("invalid_request");
  const owner = readExactOwnDataRecord(row.owner, [["userId", "sessionId"]]);
  if (!owner || !identifier(owner.userId) || !identifier(owner.sessionId)) trustFail("not_authorized");
  if (!identifier(row.stepUpProofId) || !identifier(row.idempotencyKey) || !identifier(row.requestId) || !validUuid(row.caseId)
    || typeof row.expectedCaseVersion !== "number" || !Number.isSafeInteger(row.expectedCaseVersion) || row.expectedCaseVersion < 1 || row.expectedCaseVersion >= 2_147_483_647
    || (action === "restore" && !validUuid(row.hideId)) || (action === "report_close" && row.resolution !== "dismissed" && row.resolution !== "actioned")) trustFail("invalid_request");
  return { ...row, owner: { userId: owner.userId, sessionId: owner.sessionId }, reason: normalizeTrustText(row.reason, 1, TRUST_ENFORCEMENT_POLICY.actionReasonMax) } as ReturnType<typeof normalize>;
}

export function createContentHideService(input: Input) {
  if (!["disabled", "enabled"].includes(input.mode) || input.lookupHmacKey.length < 32 || !identifier(input.applicationRevision)
    || typeof input.consumeStepUpProof !== "function" || typeof input.fence?.lockCreatorFence !== "function") trustFail("invalid_request");
  const key = new Uint8Array(input.lookupHmacKey); const clock = input.now ?? (() => new Date()); const idFactory = input.idFactory ?? randomUUID;
  const now = () => { const at = clock(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) trustFail("invalid_request"); return new Date(at); };
  const id = () => { const value = idFactory(); if (!validUuid(value)) trustFail("dependency_unavailable"); return value; };
  const cases = createTrustCasePort({ newId: id });
  const hash = (context: string, value: string) => createLookupHmac({ key, context, value });
  async function execute(action: Action, command: unknown): Promise<string> {
    if (input.mode !== "enabled") trustFail("enforcement_disabled");
    const c = normalize(command, action); const actionClass = `owner.trust_${action}`;
    try {
      return await input.db.transaction(async (tx) => {
        const startedAt = now();
        const started = await beginIdempotentCommand(tx, { actorUserId: c.owner.userId, commandScope: `trust.content_${action}`,
          keyHash: hash("trust-content-command-key", c.idempotencyKey),
          requestFingerprint: hash("trust-content-command", JSON.stringify([action, c.caseId, c.expectedCaseVersion, c.reason, c.hideId ?? null, c.resolution ?? null])),
          now: startedAt, expiresAt: new Date(startedAt.getTime() + 86_400_000) });
        if (started.kind === "replay") return started.resultReference;
        if (started.kind !== "acquired") trustFail("idempotency_conflict");
        // Read immutable routing metadata first. Never acquire a creator fence after a case/user row lock.
        const candidate = await cases.readCase(tx, c.caseId);
        if (!candidate || candidate.kind !== "report") trustFail("not_available");
        if (action !== "report_close" && candidate.sourceType === "commission_brief") trustFail("invalid_request");
        const [report] = await tx.select({ contentOwnerUserId: trustReports.contentOwnerUserId }).from(trustReports)
          .where(eq(trustReports.caseId, c.caseId)).orderBy(asc(trustReports.createdAt), asc(trustReports.id)).limit(1);
        if (!report) trustFail("not_available");
        await input.fence.lockCreatorFence(tx, report.contentOwnerUserId);
        const at = now(); let accepted = false;
        try { accepted = await input.consumeStepUpProof(tx, { proofId: c.stepUpProofId, ...c.owner, actionClass, now: at }); }
        catch { trustFail("owner_step_up_required"); }
        if (!accepted) trustFail("owner_step_up_required");
        const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, c.caseId)).limit(1).for("update");
        if (!row || row.state !== "open") trustFail("not_available");
        if (row.version !== c.expectedCaseVersion) trustFail("version_conflict");
        if (at < row.openedAt || at < startedAt) trustFail("dependency_unavailable");
        let result = c.caseId;
        const event = { caseId: c.caseId, actor: c.owner, reason: c.reason, requestId: c.requestId, at };
        if (action === "hide") {
          if (!["commission_message", "commission_file", "commission_package"].includes(row.sourceType)) trustFail("invalid_request");
          const targetKind = row.sourceType as typeof trustContentHides.$inferInsert.targetKind;
          // The fence serializes package checkout. This item lock also serializes hides across reopened cases.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`trust:content-hide:${targetKind}:${row.sourceId}`}, 0))`);
          const [active] = await tx.select({ id: trustContentHides.id }).from(trustContentHides)
            .where(and(eq(trustContentHides.targetKind, targetKind), eq(trustContentHides.targetId, row.sourceId), isNull(trustContentHides.releasedAt))).limit(1);
          if (active) trustFail("invalid_transition");
          result = id();
          await tx.insert(trustContentHides).values({ id: result, caseId: row.id, targetKind, targetId: row.sourceId, orderId: row.orderId,
            contentOwnerUserId: report.contentOwnerUserId, hiddenAt: at, hiddenByUserId: c.owner.userId, hiddenBySessionId: c.owner.sessionId,
            reasonEnvelope: encryptSensitiveField({ keyring: input.keyring, plaintext: c.reason, binding: { recordType: "trust_content_hides", recordId: result, fieldName: "reason" } }), requestId: c.requestId });
          await cases.recordCaseEvent(tx, { ...event, reason: null, action: "content_hidden" });
          await insertOutboxEvent(tx, { eventType: "trust.content_hidden.v1", eventVersion: 1, aggregateType: "trust_content_hide", aggregateId: result,
            payload: { hideId: result, caseId: row.id, targetKind }, occurredAt: at });
        } else if (action === "restore") {
          const [hide] = await tx.select().from(trustContentHides).where(and(eq(trustContentHides.id, c.hideId!), eq(trustContentHides.caseId, row.id))).limit(1).for("update");
          if (!hide || hide.targetKind !== row.sourceType || hide.targetId !== row.sourceId) trustFail("not_available");
          if (hide.releasedAt !== null || at < hide.hiddenAt) trustFail("invalid_transition");
          result = hide.id;
          await tx.update(trustContentHides).set({ releasedAt: at, releasedByUserId: c.owner.userId, releaseKind: "owner_restore", releaseRequestId: c.requestId }).where(eq(trustContentHides.id, hide.id));
          await cases.recordCaseEvent(tx, { ...event, action: "content_restored" });
          await insertOutboxEvent(tx, { eventType: "trust.content_restored.v1", eventVersion: 1, aggregateType: "trust_content_hide", aggregateId: result,
            payload: { hideId: result, caseId: row.id, targetKind: hide.targetKind }, occurredAt: at });
        } else {
          const [hide] = await tx.select({ id: trustContentHides.id }).from(trustContentHides).where(eq(trustContentHides.caseId, row.id)).limit(1);
          const [penalty] = await tx.select({ id: trustPenalties.id }).from(trustPenalties).where(eq(trustPenalties.sourceCaseId, row.id)).limit(1);
          if ((c.resolution === "actioned") !== Boolean(hide || penalty)) trustFail("invalid_transition");
          await cases.resolveCase(tx, { ...event, resolutionKind: c.resolution! });
          await tx.update(trustReports).set({ state: "closed", closedAt: at }).where(and(eq(trustReports.caseId, row.id), eq(trustReports.state, "open")));
          await insertOutboxEvent(tx, { eventType: "trust.report_case_closed.v1", eventVersion: 1, aggregateType: "trust_case", aggregateId: row.id,
            payload: { caseId: row.id, resolution: c.resolution! }, occurredAt: at });
        }
        await appendAdminAuditEvent(tx, { actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId,
          subjectType: action === "report_close" ? "trust_case" : "trust_content_hide", subjectId: result, action: actionClass, outcome: "succeeded",
          beforeState: { caseId: row.id, caseVersion: row.version, state: "open" },
          afterState: { caseId: row.id, caseVersion: row.version + 1, state: action === "report_close" ? "resolved" : "open", reference: result },
          assurance: { method: "mfa", actionClass }, applicationRevision: input.applicationRevision, requestId: c.requestId, occurredAt: at });
        const completedAt = now(); if (completedAt < at) trustFail("dependency_unavailable");
        if (!await completeIdempotentCommand(tx, { recordId: started.recordId, resultReference: result, completedAt })) trustFail("idempotency_conflict");
        return result;
      });
    } catch (error) {
      if (error instanceof TrustEnforcementError) throw error;
      if (error instanceof TrustCaseError) trustFail(error.code);
      return trustFail("dependency_unavailable");
    }
  }
  return {
    async hide(command: OwnerCase & { reason: string }): Promise<{ hideId: string }> { return { hideId: await execute("hide", command) }; },
    async restore(command: OwnerCase & { hideId: string; reason: string }): Promise<void> { await execute("restore", command); },
    async closeReportCase(command: OwnerCase & { resolution: "dismissed" | "actioned"; reason: string }): Promise<void> { await execute("report_close", command); },
  };
}
export type ContentHideService = ReturnType<typeof createContentHideService>;
