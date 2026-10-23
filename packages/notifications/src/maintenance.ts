import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, max, ne } from "drizzle-orm";
import { identityUsers, notificationPreferences, notificationReminders, notifications, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { isNotificationLinkPath, orderLink, type NoticeDraft, type NotificationClock } from "./catalog.js";
import { CLOCK_CATEGORIES, readOpenClock, readOpenClocks, readReminderKeys, reminderKey, reminderStage, type OpenClock, type ReminderStage } from "./clocks.js";
import { writeNotice } from "./materializer.js";
import { NOTIFICATION_CLOCKS, NOTIFICATION_POLICY, NotificationError, type NotificationsMode } from "./policy.js";
import type { NotificationDeadlinePort, NotificationEmailPort } from "./ports.js";

export type NotificationMaintenanceResult = {
  digestsQueued: number; digestsDeferred: number; digestsSuppressed: number; digestsFailed: number;
  remindersCreated: number; remindersFailed: number; deleted: number;
};
/** One isolated failure, identified only by row ids (never content). The rest of the batch continues. */
export type NotificationMaintenanceFailure =
  | Readonly<{ step: "digest"; notificationId: string }>
  | Readonly<{ step: "reminder"; clock: NotificationClock; subjectId: string | null }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function invalid(): never { throw new NotificationError("invalid_request"); }
const EMPTY: NotificationMaintenanceResult = Object.freeze({ digestsQueued: 0, digestsDeferred: 0, digestsSuppressed: 0, digestsFailed: 0,
  remindersCreated: 0, remindersFailed: 0, deleted: 0 });

type PendingItem = Readonly<{ id: string; recipientUserId: string; collapseKey: string | null; linkPath: string; emailDueAt: Date | null }>;
type DigestOutcome = "queued" | "deferred" | "suppressed" | "skipped";

/** Only collapsed thread-message items wait for the digest (spec section 8). */
const digestItem = (at: Date) => and(eq(notifications.emailState, "pending"), lte(notifications.emailDueAt, at), isNull(notifications.readAt),
  isNotNull(notifications.collapseKey), eq(notifications.category, "messages"));

/**
 * The worker's notification scan (spec sections 8, 9 and 13): message digest emails, deadline reminders and retention.
 * Each digest item and each reminder candidate runs in its own transaction; a failure is counted, reported to
 * `onFailure` by id, and does not stop the rest of the batch.
 */
export function createNotificationMaintenance(input: {
  db: PawketDatabase; mode: NotificationsMode; email: NotificationEmailPort; deadlines: NotificationDeadlinePort;
  now?: () => Date; idFactory?: () => string; batch?: number; onFailure?: (failure: NotificationMaintenanceFailure) => void;
}) {
  const batch = input.batch ?? NOTIFICATION_POLICY.scanBatch;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 500 || !["disabled", "enabled"].includes(input.mode)
    || typeof input.email?.queue !== "function" || !input.deadlines) invalid();
  const clock = input.now ?? (() => new Date()); const newId = input.idFactory ?? randomUUID;
  const report = (failure: NotificationMaintenanceFailure) => { try { input.onFailure?.(failure); } catch { /* reporting never changes the scan's outcome */ } };

  /** One pending item, under its own row lock. Returns what happened to its email. */
  async function digestOne(tx: PawketTransaction, item: PendingItem, at: Date): Promise<DigestOutcome> {
    if (item.collapseKey === null || !isNotificationLinkPath(item.linkPath)) throw new NotificationError("dependency_unavailable");
    // A digest more than one spacing window late (a long outage, or the switch turned back on) is dropped, not sent as a backlog.
    if (item.emailDueAt && item.emailDueAt.getTime() < at.getTime() - NOTIFICATION_POLICY.digestSpacingMs) {
      await tx.update(notifications).set({ emailState: "suppressed", emailDueAt: null }).where(eq(notifications.id, item.id));
      return "suppressed";
    }
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

  async function digest(at: Date) {
    const counts = { queued: 0, deferred: 0, suppressed: 0, failed: 0 };
    const due = await input.db.select({ id: notifications.id }).from(notifications).where(digestItem(at))
      .orderBy(asc(notifications.emailDueAt), asc(notifications.id)).limit(batch);
    for (const { id } of due) {
      try {
        const outcome = await input.db.transaction(async (tx): Promise<DigestOutcome> => {
          // SKIP LOCKED: a concurrent run leaves this row to the run holding it instead of waiting for or repeating it.
          const [item] = await tx.select({ id: notifications.id, recipientUserId: notifications.recipientUserId, collapseKey: notifications.collapseKey,
            linkPath: notifications.linkPath, emailDueAt: notifications.emailDueAt }).from(notifications)
            .where(and(eq(notifications.id, id), digestItem(at))).limit(1).for("update", { skipLocked: true });
          return item ? digestOne(tx, item, at) : "skipped";
        });
        if (outcome !== "skipped") counts[outcome] += 1;
      } catch {
        counts.failed += 1; report({ step: "digest", notificationId: id });
      }
    }
    return counts;
  }

  /** Re-checks one clock under a share lock on its subject, writes the ledger row, then the notices sourced from it. */
  async function remindOne(open: OpenClock, at: Date): Promise<boolean> {
    return input.db.transaction(async (tx) => {
      const current = await readOpenClock(tx, { clock: open.clock, subjectType: open.subjectType, subjectId: open.subjectId, now: at, deadlines: input.deadlines });
      if (!current) return false; // The action (or a pause) committed after discovery.
      const stage = reminderStage({ now: at, startedAt: current.startedAt, effectiveDeadline: current.effectiveDeadline, missedBy: current.missedBy });
      if (!stage) return false;
      const [ledger] = await tx.insert(notificationReminders).values({ id: newId(), subjectType: current.subjectType, subjectId: current.subjectId, clock: current.clock,
        stage, effectiveDeadline: current.effectiveDeadline, createdAt: at }).onConflictDoNothing().returning({ id: notificationReminders.id });
      if (!ledger) return false;
      // The 24-hour reminder goes to the acting party; a scan-made missed notice goes to both parties.
      for (const recipient of stage === "missed" ? current.recipients : current.recipients.slice(0, 1)) {
        await writeNotice(tx, { notice: reminderNotice(current, stage, recipient), sourceKey: ledger.id, at, id: newId, email: input.email });
      }
      return true;
    });
  }

  async function reminders(at: Date) {
    const counts = { created: 0, failed: 0 };
    for (const clockName of NOTIFICATION_CLOCKS) {
      let owed: { open: OpenClock; stage: ReminderStage }[];
      try {
        owed = await input.db.transaction(async (tx) => {
          const open = await readOpenClocks(tx, { clock: clockName, now: at, limit: batch, deadlines: input.deadlines, onCandidateError: (subjectId) => {
            counts.failed += 1; report({ step: "reminder", clock: clockName, subjectId });
          } });
          const due = open.flatMap((item) => {
            const stage = reminderStage({ now: at, startedAt: item.startedAt, effectiveDeadline: item.effectiveDeadline, missedBy: item.missedBy });
            return stage ? [{ open: item, stage }] : [];
          });
          // Clocks whose ledger row already exists need no transaction of their own.
          const written = await readReminderKeys(tx, clockName, due.map((item) => item.open.subjectId));
          return due.filter((item) => !written.has(reminderKey(item.open.subjectType, item.open.subjectId, item.stage, item.open.effectiveDeadline)));
        });
      } catch {
        counts.failed += 1; report({ step: "reminder", clock: clockName, subjectId: null }); continue;
      }
      for (const { open } of owed) {
        try { if (await remindOne(open, at)) counts.created += 1; }
        catch { counts.failed += 1; report({ step: "reminder", clock: clockName, subjectId: open.subjectId }); }
      }
    }
    return counts;
  }

  /** Items 90 days after creation and ledger rows 90 days after their deadline; at most `batch` of each per run. */
  async function retention(at: Date): Promise<number> {
    const cutoff = new Date(at.getTime() - NOTIFICATION_POLICY.retentionMs);
    const items = await input.db.delete(notifications).where(and(lt(notifications.createdAt, cutoff), inArray(notifications.id,
      input.db.select({ id: notifications.id }).from(notifications).where(lt(notifications.createdAt, cutoff))
        .orderBy(asc(notifications.createdAt), asc(notifications.id)).limit(batch).for("update", { skipLocked: true })))).returning({ id: notifications.id });
    const ledgerRows = await input.db.delete(notificationReminders).where(and(lt(notificationReminders.effectiveDeadline, cutoff), inArray(notificationReminders.id,
      input.db.select({ id: notificationReminders.id }).from(notificationReminders).where(lt(notificationReminders.effectiveDeadline, cutoff))
        .orderBy(asc(notificationReminders.effectiveDeadline), asc(notificationReminders.id)).limit(batch).for("update", { skipLocked: true }))))
      .returning({ id: notificationReminders.id });
    return items.length + ledgerRows.length;
  }

  const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return {
    async runOnce(): Promise<NotificationMaintenanceResult> {
      if (input.mode !== "enabled") return { ...EMPTY };
      const value = clock(); if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
      const at = new Date(value);
      // Each step runs even when an earlier one fails; a step-level failure is then reported to the caller.
      const digested = await settle(digest(at));
      const reminded = await settle(reminders(at));
      const deleted = await retention(at);
      if (!digested.ok) throw digested.error;
      if (!reminded.ok) throw reminded.error;
      return { digestsQueued: digested.value.queued, digestsDeferred: digested.value.deferred, digestsSuppressed: digested.value.suppressed,
        digestsFailed: digested.value.failed, remindersCreated: reminded.value.created, remindersFailed: reminded.value.failed, deleted };
    },
  };
}

/** Kind, clock variant and link only (P4). Appeal-window reminders are informational and link to the help page. */
function reminderNotice(open: OpenClock, stage: ReminderStage, recipient: OpenClock["recipients"][number]): NoticeDraft {
  const linkPath = recipient.role === "subject" ? "/help/cases"
    : open.orderId === null ? invalid() : orderLink(recipient.role, open.orderId);
  return { recipientUserId: recipient.userId, kind: stage === "missed" ? "deadline_missed" : "reminder_due", variant: open.clock,
    category: CLOCK_CATEGORIES[open.clock], actionRequired: open.clock !== "appeal_window", subjectType: open.subjectType, subjectId: open.subjectId,
    linkPath, email: "now" };
}
