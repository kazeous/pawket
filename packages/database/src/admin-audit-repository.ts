import { canonicalizeSafeStructuredData } from "@pawket/security/structured-data";

import type { PawketTransaction } from "./client.js";
import { adminAuditEvents } from "./schema.js";

export type NewAdminAuditEvent = {
  actorUserId: string;
  actorSessionId?: string | null;
  subjectType: string;
  subjectId: string;
  action: string;
  outcome: "succeeded" | "denied" | "failed";
  reasonCode?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  assurance: Record<string, unknown>;
  applicationRevision: string;
  requestId: string;
  occurredAt?: Date;
};

const auditIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function assertAuditIdentifier(value: string | null | undefined): void {
  if (value !== null && value !== undefined && !auditIdentifierPattern.test(value)) {
    throw new Error("Invalid admin audit event");
  }
}

function safeOptionalState(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : canonicalizeSafeStructuredData(value, "audit");
}

export async function appendAdminAuditEvent(
  tx: PawketTransaction,
  event: NewAdminAuditEvent,
): Promise<string> {
  for (const identifier of [
    event.actorUserId,
    event.actorSessionId,
    event.subjectType,
    event.subjectId,
    event.action,
    event.reasonCode,
    event.applicationRevision,
    event.requestId,
  ]) {
    assertAuditIdentifier(identifier);
  }
  if (event.occurredAt && Number.isNaN(event.occurredAt.getTime())) {
    throw new Error("Invalid admin audit event");
  }
  const [inserted] = await tx
    .insert(adminAuditEvents)
    .values({
      actorUserId: event.actorUserId,
      actorSessionId: event.actorSessionId ?? null,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      action: event.action,
      outcome: event.outcome,
      reasonCode: event.reasonCode ?? null,
      beforeState: safeOptionalState(event.beforeState),
      afterState: safeOptionalState(event.afterState),
      assurance: canonicalizeSafeStructuredData(event.assurance, "audit"),
      applicationRevision: event.applicationRevision,
      requestId: event.requestId,
      occurredAt: event.occurredAt ?? new Date(),
    })
    .returning({ id: adminAuditEvents.id });

  if (!inserted) throw new Error("Failed to append admin audit event");
  return inserted.id;
}
