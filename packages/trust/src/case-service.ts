import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { appendAdminAuditEvent, trustCases, trustCaseEvents, trustCaseAccessLog, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";
import { caseActor, caseFail, caseIdentifier, caseKind, caseNewId, caseTime, TrustCaseError, type TrustCaseActor, type TrustCaseKind } from "./case-port.js";

export type TrustCaseEvidencePort = Readonly<{
  orderSummary(tx: PawketTransaction, orderId: string): Promise<unknown>;
  threadPage(tx: PawketTransaction, orderId: string, beforeSequence?: number): Promise<unknown>;
  resolutionRecords(tx: PawketTransaction, orderId: string): Promise<unknown>;
  refundDestination(tx: PawketTransaction, obligationId: string): Promise<unknown>;
  fileGrant(tx: PawketTransaction, input: Readonly<{ orderId: string; fileId: string; disposition: "attachment" | "inline" }>): Promise<{ url: string }>;
}>;
type Case = typeof trustCases.$inferSelect;
type EvidenceSection = "order_summary" | "thread_page" | "resolution_records" | "refund_destination";
type EvidenceCommand = Readonly<{ owner: TrustCaseActor; stepUpProofId: string; caseId: string; section: EvidenceSection; cursor?: number; requestId: string }>;
type FileCommand = Readonly<{ owner: TrustCaseActor; stepUpProofId: string; caseId: string; fileId: string; disposition: "attachment" | "inline"; requestId: string }>;
type FactoryInput = Readonly<{
  db: PawketDatabase; applicationRevision: string;
  consumeStepUpProof(tx: PawketTransaction, input: Readonly<{ proofId: string; sessionId: string; userId: string; actionClass: string; now: Date }>): Promise<boolean>;
  evidence: TrustCaseEvidencePort; now?(): Date; idFactory?(): string;
}>;
function summary(row: Case) {
  return { caseId: row.id, kind: row.kind as TrustCaseKind, orderId: row.orderId, sourceType: row.sourceType, sourceId: row.sourceId,
    state: row.state as "open" | "resolved", resolutionKind: row.resolutionKind, policyRevisionId: row.policyRevisionId,
    openedAt: row.openedAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null, version: row.version };
}
async function available<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { if (error instanceof TrustCaseError) throw error; caseFail("dependency_unavailable"); }
}

export function createTrustCaseService(input: FactoryInput) {
  const { db, applicationRevision, consumeStepUpProof } = input;
  const evidence = { ...input.evidence }; const now = input.now ?? (() => new Date()); const idFactory = input.idFactory ?? randomUUID; const id = () => caseNewId(idFactory);
  if (!caseIdentifier(applicationRevision) || typeof consumeStepUpProof !== "function") caseFail("invalid_request");

  async function access<T>(command: Readonly<{ owner: TrustCaseActor; stepUpProofId: string; caseId: string; requestId: string }>,
    actionClass: "owner.case_evidence" | "owner.case_file", itemType: EvidenceSection | "file", fileId: string | null, read: (tx: PawketTransaction, row: Case) => Promise<T>): Promise<T> {
    const owner = caseActor(command.owner);
    if (!validUuid(command.caseId) || !caseIdentifier(command.stepUpProofId) || !caseIdentifier(command.requestId)) caseFail("invalid_request");
    const at = caseTime(now());
    return available(() => db.transaction(async (tx) => {
      // Keep the case open until the evidence read and both audit writes commit.
      const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, command.caseId)).limit(1).for("share");
      if (!row || row.state !== "open") caseFail("not_available");
      if (itemType === "refund_destination" && row.kind !== "refund_not_received" && row.kind !== "refund_overdue") caseFail("not_available");
      let accepted = false;
      try { accepted = await consumeStepUpProof(tx, { proofId: command.stepUpProofId, ...owner, actionClass, now: at }); }
      catch { caseFail("owner_step_up_required"); }
      if (!accepted) caseFail("owner_step_up_required");
      const result = await read(tx, row);
      const itemId = fileId ?? (itemType === "refund_destination" ? row.sourceId : row.orderId);
      await tx.insert(trustCaseAccessLog).values({ id: id(), caseId: row.id, itemType, itemId, ownerUserId: owner.userId,
        ownerSessionId: owner.sessionId, requestId: command.requestId, accessedAt: at });
      await appendAdminAuditEvent(tx, { actorUserId: owner.userId, actorSessionId: owner.sessionId, subjectType: "trust_case", subjectId: row.id,
        action: actionClass, outcome: "succeeded", afterState: { caseId: row.id, itemType, itemId }, assurance: { method: "mfa", actionClass },
        applicationRevision, requestId: command.requestId, occurredAt: at });
      return result;
    }));
  }
  return {
    async listQueue(command: Readonly<{ state?: "open" | "resolved"; kind?: TrustCaseKind; before?: { openedAt: string; id: string }; limit?: number }> = {}) {
      const keys = ["state", "kind", "before", "limit"];
      const shapes = Array.from({ length: 16 }, (_, mask) => keys.filter((_, i) => mask & (1 << i)));
      const record = readExactOwnDataRecord(command, shapes); if (!record) caseFail("invalid_request");
      const state = record.state ?? "open"; const limit = record.limit ?? 50;
      if ((state !== "open" && state !== "resolved") || (record.kind !== undefined && !caseKind(record.kind))
        || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) caseFail("invalid_request");
      let before: { openedAt: Date; id: string } | null = null;
      if (record.before !== undefined) {
        const cursor = readExactOwnDataRecord(record.before, [["openedAt", "id"]]);
        if (!cursor || !validUuid(cursor.id) || typeof cursor.openedAt !== "string") caseFail("invalid_request");
        const openedAt = new Date(cursor.openedAt);
        if (!Number.isFinite(openedAt.getTime()) || openedAt.toISOString() !== cursor.openedAt) caseFail("invalid_request");
        before = { openedAt, id: cursor.id };
      }
      const kind = record.kind as TrustCaseKind | undefined;
      return available(async () => {
        const rows = await db.select().from(trustCases).where(and(eq(trustCases.state, state), kind === undefined ? undefined : eq(trustCases.kind, kind),
          before === null ? undefined : or(lt(trustCases.openedAt, before.openedAt), and(eq(trustCases.openedAt, before.openedAt), lt(trustCases.id, before.id)))))
          .orderBy(desc(trustCases.openedAt), desc(trustCases.id)).limit(limit);
        return rows.map(summary);
      });
    },
    async getCase(caseId: string) {
      if (!validUuid(caseId)) caseFail("invalid_request");
      return available(() => db.transaction(async (tx) => {
        const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, caseId)).limit(1).for("share");
        if (!row) caseFail("not_available");
        const events = await tx.select().from(trustCaseEvents).where(eq(trustCaseEvents.caseId, caseId)).orderBy(asc(trustCaseEvents.resultingVersion));
        const accessLog = await tx.select().from(trustCaseAccessLog).where(eq(trustCaseAccessLog.caseId, caseId)).orderBy(desc(trustCaseAccessLog.accessedAt), desc(trustCaseAccessLog.id)).limit(100);
        return { ...summary(row), events: events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
          accessLog: accessLog.map((entry) => ({ ...entry, accessedAt: entry.accessedAt.toISOString() })) };
      }));
    },
    async readEvidence(command: EvidenceCommand): Promise<unknown> {
      const fields = ["owner", "stepUpProofId", "caseId", "section", "requestId"];
      const record = readExactOwnDataRecord(command, [fields, [...fields, "cursor"]]);
      if (!record || !["order_summary", "thread_page", "resolution_records", "refund_destination"].includes(record.section as string)
        || (record.cursor !== undefined && (record.section !== "thread_page" || typeof record.cursor !== "number" || !Number.isSafeInteger(record.cursor) || record.cursor < 1))) caseFail("invalid_request");
      const section = record.section as EvidenceSection;
      const normalized = { owner: caseActor(record.owner), stepUpProofId: record.stepUpProofId as string, caseId: record.caseId as string, requestId: record.requestId as string };
      return access(normalized, "owner.case_evidence", section, null, (tx, row) => {
        if (section === "order_summary") return evidence.orderSummary(tx, row.orderId);
        if (section === "thread_page") return evidence.threadPage(tx, row.orderId, record.cursor as number | undefined);
        if (section === "resolution_records") return evidence.resolutionRecords(tx, row.orderId);
        return evidence.refundDestination(tx, row.sourceId);
      });
    },
    async fileGrant(command: FileCommand): Promise<{ url: string }> {
      const record = readExactOwnDataRecord(command, [["owner", "stepUpProofId", "caseId", "fileId", "disposition", "requestId"]]);
      if (!record || !validUuid(record.fileId) || (record.disposition !== "attachment" && record.disposition !== "inline")) caseFail("invalid_request");
      const fileId = record.fileId; const disposition = record.disposition;
      const normalized = { owner: caseActor(record.owner), stepUpProofId: record.stepUpProofId as string, caseId: record.caseId as string, requestId: record.requestId as string };
      return access(normalized, "owner.case_file", "file", fileId, async (tx, row) => {
        const result = readExactOwnDataRecord(await evidence.fileGrant(tx, { orderId: row.orderId, fileId, disposition }), [["url"]]);
        if (!result || typeof result.url !== "string" || !result.url) caseFail("dependency_unavailable");
        return { url: result.url };
      });
    },
  };
}
export type TrustCaseService = ReturnType<typeof createTrustCaseService>;
