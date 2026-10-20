import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { identityUsers, notificationPreferences, notifications, systemOutbox, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { NOTIFICATION_VARIANT_PATTERN, isNotificationCategory, isNotificationKind, isNotificationLinkPath, type NoticeDraft } from "./catalog.js";
import { NotificationError, OPTIONAL_EMAIL_CATEGORIES, type NotificationsMode, type NotificationSourceEvent } from "./policy.js";
import type { NotificationEmailPort } from "./ports.js";
import { resolveNotices } from "./recipients.js";

/** Committed events that produce notices in this stage. `commission.message_sent.v1` (Task 5) and refund events (Task 4) are not here yet.
 * `commission.in_progress.v1` is deliberately absent (Ruling R7): it only reopens an order after a change request. */
export const NOTIFICATION_SOURCE_EVENTS: ReadonlySet<string> = new Set([
  "commission.requested.v1", "commission.quoted.v1", "commission.awaiting_payment.v1", "commission.transfer_claimed.v1", "commission.confirmed.v1",
  "commission.delivered.v1", "commission.completed.v1", "commission.closed.v1",
  "commission.submission_sent.v1", "commission.submission_responded.v1",
  "resolution.proposal_made.v1", "resolution.proposal_ended.v1", "resolution.dispute_opened.v1", "resolution.dispute_statement_added.v1",
  "resolution.dispute_closed.v1", "resolution.ruling_recorded.v1", "resolution.ruling_corrected.v1", "resolution.late_claim_filed.v1",
  "resolution.late_claim_ended.v1", "resolution.fulfillment_frozen.v1",
  "trust.case_opened.v1", "trust.report_received.v1", "trust.report_case_closed.v1", "trust.content_hidden.v1", "trust.content_restored.v1",
  "trust.penalty_applied.v1", "trust.penalty_ended.v1", "trust.appeal_submitted.v1", "trust.appeal_decided.v1",
  "tip.notification_available.v1", "tip.transfer_claimed.v1",
  "creator.application_outcome_email.v1", "creator.capability_outcome_email.v1",
  "payments.receiving_account_control_verified.v1", "payments.verification_deposit_refund_due_soon.v1", "payments.verification_deposit_refund_due_today.v1",
  "payments.verification_deposit_refund_overdue.v1", "payments.verification_deposit_refund_sent.v1", "payments.verification_deposit_refund_attention_required.v1",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function invalid(): never { throw new NotificationError("invalid_request"); }

/** Every draft is checked against the closed lists before it reaches a row, an email or a metric. */
function checkDraft(notice: NoticeDraft): void {
  if (!isNotificationKind(notice.kind) || !isNotificationCategory(notice.category) || !isNotificationLinkPath(notice.linkPath)
    || (notice.variant !== null && !NOTIFICATION_VARIANT_PATTERN.test(notice.variant)) || typeof notice.actionRequired !== "boolean"
    || typeof notice.recipientUserId !== "string" || notice.recipientUserId.length === 0 || notice.collapseKey !== undefined
    || !["now", "never"].includes(notice.email) || (notice.category === "account" && notice.email !== "never")) invalid();
}

async function emailOptedOut(tx: PawketTransaction, notice: NoticeDraft): Promise<boolean> {
  // Action-required notices always email; tips and account have no switch (spec section 11).
  if (notice.actionRequired || !(OPTIONAL_EMAIL_CATEGORIES as readonly string[]).includes(notice.category)) return false;
  const [row] = await tx.select({ userId: notificationPreferences.userId }).from(notificationPreferences).where(and(eq(notificationPreferences.userId, notice.recipientUserId),
    eq(notificationPreferences.category, notice.category), eq(notificationPreferences.channel, "email"))).limit(1);
  return row !== undefined;
}

export function createNotificationMaterializer(input: {
  db: PawketDatabase; mode: NotificationsMode; email: NotificationEmailPort; now?: () => Date; idFactory?: () => string;
}) {
  const now = input.now ?? (() => new Date()); const id = input.idFactory ?? randomUUID;
  return {
    /** Runs after the event's own worker branch; one transaction per event, idempotent on (source_key, recipient). */
    async materialize(event: NotificationSourceEvent): Promise<{ created: number; emailed: number }> {
      if (input.mode !== "enabled" || !NOTIFICATION_SOURCE_EVENTS.has(event.eventType)) return { created: 0, emailed: 0 };
      if (typeof event.outboxEventId !== "string" || !UUID_PATTERN.test(event.outboxEventId) || event.eventVersion !== 1) invalid();
      const at = now(); if (!(at instanceof Date) || !Number.isFinite(at.getTime())) invalid();
      return input.db.transaction(async (tx) => {
        const [source] = await tx.select().from(systemOutbox).where(eq(systemOutbox.id, event.outboxEventId)).limit(1);
        // Same binding rule as resolveTipNotificationContext: the queue payload grants no authority.
        if (!source || source.eventType !== event.eventType || source.eventVersion !== event.eventVersion
          || source.aggregateType !== event.aggregateType || source.aggregateId !== event.aggregateId) invalid();
        const drafts = await resolveNotices(tx, source);
        let created = 0; let emailed = 0;
        for (const notice of drafts) {
          checkDraft(notice);
          const [user] = await tx.select({ accessStatus: identityUsers.accessStatus }).from(identityUsers).where(eq(identityUsers.id, notice.recipientUserId)).limit(1);
          if (!user) throw new NotificationError("dependency_unavailable");
          if (user.accessStatus === "closed") continue;
          const suppressed = notice.email === "now" && await emailOptedOut(tx, notice);
          const [row] = await tx.insert(notifications).values({ id: id(), recipientUserId: notice.recipientUserId, kind: notice.kind, variant: notice.variant,
            category: notice.category, actionRequired: notice.actionRequired, subjectType: notice.subjectType, subjectId: notice.subjectId, linkPath: notice.linkPath,
            sourceKey: source.id, emailState: suppressed ? "suppressed" : "none", createdAt: at, updatedAt: at })
            .onConflictDoNothing({ target: [notifications.sourceKey, notifications.recipientUserId] }).returning({ id: notifications.id });
          if (!row) continue; // Already materialized by an earlier delivery of this event.
          created += 1;
          if (notice.email !== "now" || suppressed) continue;
          // P7: the handoff and the item's email state commit together, so a replay never queues twice.
          const handoff = await input.email.queue(tx, { notificationId: row.id, userId: notice.recipientUserId, kind: notice.kind, variant: notice.variant,
            category: notice.category, linkPath: notice.linkPath, at });
          if (!handoff || !UUID_PATTERN.test(handoff.handoffId) || (handoff.outcome !== "queued" && handoff.outcome !== "attention_required")) invalid();
          await tx.update(notifications).set({ emailState: handoff.outcome, emailHandoffId: handoff.handoffId, emailQueuedAt: handoff.outcome === "queued" ? at : null })
            .where(eq(notifications.id, row.id));
          emailed += 1;
        }
        return { created, emailed };
      });
    },
  };
}
