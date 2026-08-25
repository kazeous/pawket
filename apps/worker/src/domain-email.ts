import { randomUUID } from "node:crypto";

import {
  findEmailHandoffBySourceEvent,
  findOperationalEmailUser,
  findRefundEmailContext,
  type PawketDatabase,
} from "@pawket/database";
import {
  queueSecurityEmailHandoff,
  recordSecurityEmailAttentionRequired,
} from "@pawket/identity/security-email-handoff";
import type { SecurityEmailPurpose } from "@pawket/identity/security-email";
import type { SystemOutboxJob } from "@pawket/queue";
import type { EncryptionKeyring } from "@pawket/security";

export const DOMAIN_EMAIL_EVENTS = new Set([
  "creator.application_outcome_email.v1",
  "creator.capability_outcome_email.v1",
  "payments.receiving_account_control_verified.v1",
  "payments.verification_deposit_refund_due_soon.v1",
  "payments.verification_deposit_refund_due_today.v1",
  "payments.verification_deposit_refund_overdue.v1",
  "payments.verification_deposit_refund_sent.v1",
  "payments.verification_deposit_refund_attention_required.v1",
]);

type DomainEmailSpec = {
  userId: string;
  purpose: SecurityEmailPurpose;
  templateData: Record<string, string>;
};

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("Invalid domain email event");
  }
  return value;
}

function optionalDate(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("Invalid domain email event");
  }
  return value;
}

async function refundSpec(
  db: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
  event: SystemOutboxJob,
): Promise<DomainEmailSpec> {
  const obligation = await findRefundEmailContext(db, event.aggregateId);
  if (!obligation) throw new Error("Domain email subject is unavailable");

  const stateByEvent: Record<string, string> = {
    "payments.receiving_account_control_verified.v1": "pending_window",
    "payments.verification_deposit_refund_due_soon.v1": "ready",
    "payments.verification_deposit_refund_due_today.v1": "due_today",
    "payments.verification_deposit_refund_overdue.v1": "overdue",
    "payments.verification_deposit_refund_sent.v1": "sent",
    "payments.verification_deposit_refund_attention_required.v1": "attention_required",
  };
  const state = stateByEvent[event.eventType];
  if (!state) throw new Error("Unsupported domain email event");

  const payloadNotBefore = optionalDate(event.payload, "refundNotBefore");
  const payloadDue = optionalDate(event.payload, "refundDue");
  return {
    userId: obligation.applicantUserId,
    purpose: "refund_status",
    templateData: {
      state,
      returnPath: "/creator/apply",
      refundNotBefore: payloadNotBefore ?? obligation.refundNotBefore,
      refundDue: payloadDue ?? obligation.refundDue,
    },
  };
}

async function specFor(
  db: Parameters<Parameters<PawketDatabase["transaction"]>[0]>[0],
  event: SystemOutboxJob,
): Promise<DomainEmailSpec> {
  if (event.eventVersion !== 1 || !DOMAIN_EMAIL_EVENTS.has(event.eventType)) {
    throw new Error("Unsupported domain email event");
  }
  if (event.eventType === "creator.application_outcome_email.v1") {
    const state = requiredString(event.payload, "state");
    if (!["changes_requested", "approved", "rejected"].includes(state)) {
      throw new Error("Invalid domain email event");
    }
    return {
      userId: requiredString(event.payload, "applicantUserId"),
      purpose: "application_outcome",
      templateData: { state, returnPath: "/creator/apply" },
    };
  }
  if (event.eventType === "creator.capability_outcome_email.v1") {
    const state = requiredString(event.payload, "state");
    if (!["active", "suspended"].includes(state)) {
      throw new Error("Invalid domain email event");
    }
    return {
      userId: requiredString(event.payload, "userId"),
      purpose: "creator_status",
      templateData: { state, returnPath: "/creator" },
    };
  }
  return refundSpec(db, event);
}

export async function materializeDomainEmailHandoff(input: {
  db: PawketDatabase;
  event: SystemOutboxJob;
  keyring: EncryptionKeyring;
  now: Date;
  id?: () => string;
}): Promise<"created" | "attention_required" | "already_materialized"> {
  return input.db.transaction(async (tx) => {
    const existing = await findEmailHandoffBySourceEvent(
      tx,
      input.event.outboxEventId,
    );
    if (existing) return "already_materialized";

    const spec = await specFor(tx, input.event);
    const user = await findOperationalEmailUser(tx, spec.userId);
    if (!user) throw new Error("Domain email subject is unavailable");

    const id = (input.id ?? randomUUID)();
    if (!user.emailVerified) {
      await recordSecurityEmailAttentionRequired(tx, {
        id,
        userId: spec.userId,
        purpose: spec.purpose,
        sourceOutboxEventId: input.event.outboxEventId,
        failureCode: "no_verified_destination",
        templateData: spec.templateData,
        now: input.now,
      });
      return "attention_required";
    }

    await queueSecurityEmailHandoff(tx, {
      id,
      userId: spec.userId,
      purpose: spec.purpose,
      destination: user.email,
      templateData: spec.templateData,
      keyring: input.keyring,
      now: input.now,
      sourceOutboxEventId: input.event.outboxEventId,
    });
    return "created";
  });
}
