import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { insertOutboxEvent, TRUST_CASE_KINDS, trustCases, trustCaseEvents, type PawketTransaction } from "@pawket/database";
import { readExactOwnDataRecord, validUuid } from "./report-policy.js";

export type TrustCaseKind = typeof TRUST_CASE_KINDS[number];
export type TrustCaseActor = Readonly<{ userId: string; sessionId: string }>;
export type TrustCaseSourceType = "commission_dispute" | "commission_refund_obligation" | "commission_late_payment_claim";
type Case = typeof trustCases.$inferSelect;
type Command = Readonly<{ caseId: string; actor: TrustCaseActor | null; reason: string | null; requestId: string; at: Date }>;
export class TrustCaseError extends Error {
  constructor(readonly code: "not_available" | "invalid_request" | "owner_step_up_required" | "version_conflict" | "dependency_unavailable") {
    super(code); this.name = "TrustCaseError";
  }
}
export function caseFail(code: TrustCaseError["code"]): never { throw new TrustCaseError(code); }
export const caseIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
export const caseKind = (value: unknown): value is TrustCaseKind => typeof value === "string" && (TRUST_CASE_KINDS as readonly string[]).includes(value);
export function caseActor(value: unknown): TrustCaseActor {
  const actor = readExactOwnDataRecord(value, [["userId", "sessionId"]]);
  if (!actor || !caseIdentifier(actor.userId) || !caseIdentifier(actor.sessionId)) caseFail("invalid_request");
  return { userId: actor.userId, sessionId: actor.sessionId };
}
export function caseTime(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) caseFail("invalid_request");
  return new Date(value.getTime());
}
export function caseNewId(factory: () => string): string {
  const id = factory(); if (!validUuid(id)) caseFail("dependency_unavailable"); return id;
}
function reason(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || [...value].length > 2_000 || /[\p{Cc}\p{Cs}]/u.test(value)) caseFail("invalid_request");
  return value.normalize("NFC");
}
const resolutions: Readonly<Record<TrustCaseKind, readonly string[]>> = {
  dispute: ["ruled", "settled", "withdrawn", "superseded"],
  refund_not_received: ["receipt_accepted", "resend_required", "waived"],
  refund_overdue: ["send_recorded", "extended", "waived"],
  late_payment: ["refund_owed", "rejected"],
};
function sourceType(kind: TrustCaseKind): TrustCaseSourceType {
  return kind === "dispute" ? "commission_dispute" : kind === "late_payment" ? "commission_late_payment_claim" : "commission_refund_obligation";
}

/** Callers own authorization and the surrounding domain transaction. */
export function createTrustCasePort(input: { newId?(): string } = {}) {
  const idFactory = input.newId ?? randomUUID; const id = () => caseNewId(idFactory);
  async function findOpenCase(tx: PawketTransaction, command: { kind: TrustCaseKind; sourceId: string }): Promise<{ caseId: string; version: number } | null> {
    if (!caseKind(command.kind) || !validUuid(command.sourceId)) caseFail("invalid_request");
    const [row] = await tx.select({ caseId: trustCases.id, version: trustCases.version }).from(trustCases)
      .where(and(eq(trustCases.kind, command.kind), eq(trustCases.sourceId, command.sourceId), eq(trustCases.state, "open"))).limit(1);
    return row ?? null;
  }
  async function lockCase(tx: PawketTransaction, command: Command): Promise<Case> {
    if (!validUuid(command.caseId) || !caseIdentifier(command.requestId)) caseFail("invalid_request");
    caseTime(command.at); if (command.actor !== null) caseActor(command.actor); reason(command.reason);
    const [row] = await tx.select().from(trustCases).where(eq(trustCases.id, command.caseId)).limit(1).for("update");
    if (!row || row.state !== "open") caseFail("not_available");
    if (command.at.getTime() < row.openedAt.getTime()) caseFail("invalid_request");
    return row;
  }
  async function record(tx: PawketTransaction, row: Case, command: Command, action: "resolved" | "question_posted" | "deadline_extended", resolutionKind: string | null) {
    const [updated] = await tx.update(trustCases).set({ version: row.version + 1,
      ...(action === "resolved" ? { state: "resolved", resolutionKind, resolvedAt: command.at } : {}),
    }).where(and(eq(trustCases.id, row.id), eq(trustCases.version, row.version), eq(trustCases.state, "open"))).returning();
    if (!updated) caseFail("version_conflict");
    await tx.insert(trustCaseEvents).values({ id: id(), caseId: row.id, action, actorUserId: command.actor?.userId ?? null,
      actorSessionId: command.actor?.sessionId ?? null, reason: reason(command.reason), requestId: command.requestId,
      expectedVersion: row.version, resultingVersion: updated.version, beforeState: "open", afterState: updated.state, resolutionKind, occurredAt: command.at });
  }
  return {
    findOpenCase,
    async openCase(tx: PawketTransaction, command: Readonly<{ kind: TrustCaseKind; orderId: string; sourceType: TrustCaseSourceType; sourceId: string; policyRevisionId: string | null; requestId: string; at: Date }>): Promise<{ caseId: string; created: boolean }> {
      if (!caseKind(command.kind) || command.sourceType !== sourceType(command.kind) || !validUuid(command.orderId) || !validUuid(command.sourceId)
        || (command.policyRevisionId !== null && !validUuid(command.policyRevisionId)) || !caseIdentifier(command.requestId)) caseFail("invalid_request");
      const at = caseTime(command.at);
      const [row] = await tx.insert(trustCases).values({ id: id(), kind: command.kind, orderId: command.orderId, sourceType: command.sourceType,
        sourceId: command.sourceId, policyRevisionId: command.policyRevisionId, openedAt: at })
        .onConflictDoNothing({ target: [trustCases.kind, trustCases.sourceId], where: sql`${trustCases.state} = 'open'` }).returning();
      if (!row) {
        const [existing] = await tx.select().from(trustCases).where(and(eq(trustCases.kind, command.kind), eq(trustCases.sourceId, command.sourceId), eq(trustCases.state, "open"))).limit(1).for("update");
        if (!existing) caseFail("version_conflict");
        if (existing.orderId !== command.orderId || existing.sourceType !== command.sourceType || existing.policyRevisionId !== command.policyRevisionId) caseFail("invalid_request");
        return { caseId: existing.id, created: false };
      }
      await tx.insert(trustCaseEvents).values({ id: id(), caseId: row.id, action: "opened", requestId: command.requestId,
        expectedVersion: 0, resultingVersion: 1, beforeState: null, afterState: "open", occurredAt: at });
      await insertOutboxEvent(tx, { eventType: "trust.case_opened.v1", eventVersion: 1, aggregateType: "trust_case", aggregateId: row.id,
        payload: { caseId: row.id, orderId: row.orderId, sourceId: row.sourceId, policyRevisionId: row.policyRevisionId, correlationId: command.requestId }, occurredAt: at });
      return { caseId: row.id, created: true };
    },
    async resolveCase(tx: PawketTransaction, command: Command & Readonly<{ resolutionKind: string }>): Promise<void> {
      const row = await lockCase(tx, command);
      if (!caseKind(row.kind) || !resolutions[row.kind].includes(command.resolutionKind)) caseFail("invalid_request");
      await record(tx, row, command, "resolved", command.resolutionKind);
    },
    async recordCaseEvent(tx: PawketTransaction, command: Command & Readonly<{ action: "question_posted" | "deadline_extended" }>): Promise<void> {
      if (command.action !== "question_posted" && command.action !== "deadline_extended") caseFail("invalid_request");
      const row = await lockCase(tx, command); await record(tx, row, command, command.action, null);
    },
  };
}
export type TrustCasePort = ReturnType<typeof createTrustCasePort>;
