import { and, asc, eq, gt, inArray, isNull, lt, lte, max, ne } from "drizzle-orm";
import { identityUsers, notificationPreferences, notificationReminders, notifications, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { isNotificationLinkPath } from "./catalog.js";
import { NOTIFICATION_POLICY, NotificationError, type NotificationsMode } from "./policy.js";
import type { NotificationDeadlinePort, NotificationEmailPort } from "./ports.js";

export type NotificationMaintenanceResult = { digestsQueued: number; digestsDeferred: number; remindersCreated: number; deleted: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function invalid(): never { throw new NotificationError("invalid_request"); }

type PendingItem = Readonly<{ id: string; recipientUserId: string; collapseKey: string | null; linkPath: string }>;
type DigestOutcome = "queued" | "deferred" | "suppressed";

/**
 * The worker's notification scan (spec sections 8 and 13): message digest emails and retention. Reminders arrive in a
 * later task; `deadlines` and `idFactory` are accepted now so the worker wiring does not change shape.
 */
export function createNotificationMaintenance(input: {
  db: PawketDatabase; mode: NotificationsMode; email: NotificationEmailPort; deadlines: NotificationDeadlinePort;
  now?: () => Date; idFactory?: () => string; batch?: number;
}) {
  const batch = input.batch ?? NOTIFICATION_POLICY.scanBatch;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 500 || !["disabled", "enabled"].includes(input.mode)
    || typeof input.email?.queue !== "function" || !input.deadlines) invalid();
  const clock = input.now ?? (() => new Date());

  /** One pending item, under the row lock its batch took. Returns what happened to its email. */
  async function digestOne(tx: PawketTransaction, item: PendingItem, at: Date): Promise<DigestOutcome> {
    if (item.collapseKey === null || !isNotificationLinkPath(item.linkPath)) throw new NotificationError("dependency_unavailable");
    const [recipient] = await tx.select({ accessStatus: identityUsers.accessStatus }).from(identityUsers).where(eq(identityUsers.id, item.recipientUserId)).limit(1);
    const [optedOut] = await tx.select({ userId: notificationPreferences.userId }).from(notificationPreferences).where(and(
      eq(notificationPreferences.userId, item.recipientUserId), eq(notificationPreferences.category, "messages"), eq(notificationPreferences.channel, "email"))).limit(1);
    // A closed account gets nothing; an opt-out made after the item opened still applies before the email leaves.
    if (!recipient || recipient.accessStatus === "closed" || optedOut) {
      await tx.update(notifications).set({ emailState: "suppressed", emailDueAt: null }).where(eq(notifications.id, item.id));
      return "suppressed";
    }
    // At most one message email per order and recipient per spacing window: wait until the window after the last one closes.
    const [last] = await tx.select({ queuedAt: max(notifications.emailQueuedAt) }).from(notifications).where(and(
      eq(notifications.recipientUserId, item.recipientUserId), eq(notifications.collapseKey, item.collapseKey), eq(notifications.category, "messages"),
      ne(notifications.id, item.id), gt(notifications.emailQueuedAt, new Date(at.getTime() - NOTIFICATION_POLICY.digestSpacingMs))));
    if (last?.queuedAt) {
      await tx.update(notifications).set({ emailDueAt: new Date(last.queuedAt.getTime() + NOTIFICATION_POLICY.digestSpacingMs) }).where(eq(notifications.id, item.id));
      return "deferred";
    }
    const handoff = await input.email.queue(tx, { notificationId: item.id, userId: item.recipientUserId, kind: "order_messages", variant: null,
      category: "messages", linkPath: item.linkPath, at });
    if (!handoff || !UUID_PATTERN.test(handoff.handoffId) || (handoff.outcome !== "queued" && handoff.outcome !== "attention_required")) invalid();
    // P7: the handoff and the item's email state commit together, so a second run never queues twice.
    await tx.update(notifications).set({ emailState: handoff.outcome, emailHandoffId: handoff.handoffId, emailQueuedAt: at, emailDueAt: null })
      .where(eq(notifications.id, item.id));
    return "queued";
  }

  async function digest(at: Date): Promise<{ queued: number; deferred: number }> {
    return input.db.transaction(async (tx) => {
      // SKIP LOCKED: a concurrent run leaves these rows to this one instead of waiting for or repeating them.
      const due = await tx.select({ id: notifications.id, recipientUserId: notifications.recipientUserId, collapseKey: notifications.collapseKey,
        linkPath: notifications.linkPath }).from(notifications)
        .where(and(eq(notifications.emailState, "pending"), lte(notifications.emailDueAt, at), isNull(notifications.readAt)))
        .orderBy(asc(notifications.emailDueAt), asc(notifications.id)).limit(batch).for("update", { skipLocked: true });
      let queued = 0; let deferred = 0;
      for (const item of due) {
        const outcome = await digestOne(tx, item, at);
        if (outcome === "queued") queued += 1; else if (outcome === "deferred") deferred += 1;
      }
      return { queued, deferred };
    });
  }

  /** Items 90 days after creation and ledger rows 90 days after their deadline; at most `batch` of each per run. */
  async function retention(at: Date): Promise<number> {
    const cutoff = new Date(at.getTime() - NOTIFICATION_POLICY.retentionMs);
    const items = await input.db.delete(notifications).where(and(lt(notifications.createdAt, cutoff), inArray(notifications.id,
      input.db.select({ id: notifications.id }).from(notifications).where(lt(notifications.createdAt, cutoff))
        .orderBy(asc(notifications.createdAt), asc(notifications.id)).limit(batch).for("update", { skipLocked: true })))).returning({ id: notifications.id });
    const reminders = await input.db.delete(notificationReminders).where(and(lt(notificationReminders.effectiveDeadline, cutoff), inArray(notificationReminders.id,
      input.db.select({ id: notificationReminders.id }).from(notificationReminders).where(lt(notificationReminders.effectiveDeadline, cutoff))
        .orderBy(asc(notificationReminders.effectiveDeadline), asc(notificationReminders.id)).limit(batch).for("update", { skipLocked: true }))))
      .returning({ id: notificationReminders.id });
    return items.length + reminders.length;
  }

  return {
    async runOnce(): Promise<NotificationMaintenanceResult> {
      if (input.mode !== "enabled") return { digestsQueued: 0, digestsDeferred: 0, remindersCreated: 0, deleted: 0 };
      const value = clock(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
      const at = new Date(value);
      // Retention still runs when the digest step fails; the failure is then reported to the caller.
      const digested = await digest(at).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
      const deleted = await retention(at);
      if (!digested.ok) throw digested.error;
      return { digestsQueued: digested.value.queued, digestsDeferred: digested.value.deferred, remindersCreated: 0, deleted };
    },
  };
}
