import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { notifications, type PawketDatabase } from "@pawket/database";
import { NOTIFICATION_POLICY, NotificationError } from "./policy.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type MarkReadTarget = { ids: readonly string[] } | { all: true } | { orderId: string };

function invalid(): never { throw new NotificationError("invalid_request"); }

function targetFilter(target: MarkReadTarget): SQL {
  if (!target || typeof target !== "object") invalid();
  if ("ids" in target) {
    const ids = target.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > NOTIFICATION_POLICY.readBatchMax
      || !ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) invalid();
    return inArray(notifications.id, [...new Set(ids)]);
  }
  if ("orderId" in target) {
    // Opening an order clears that order's open message item for the viewer (spec section 8, P6).
    if (typeof target.orderId !== "string" || !UUID_PATTERN.test(target.orderId)) invalid();
    return eq(notifications.collapseKey, `messages:${target.orderId}`);
  }
  if ("all" in target && target.all === true) return sql`true`;
  return invalid();
}

/** Marks the viewer's own unread items read. A pending digest email on a read item is suppressed. Returns the number of items marked. */
export async function markNotificationsRead(db: PawketDatabase, input: { userId: string; target: MarkReadTarget; at: Date }): Promise<number> {
  if (typeof input.userId !== "string" || input.userId.length === 0 || input.userId.length > 200) invalid();
  if (!(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) invalid();
  const filter = targetFilter(input.target);
  const rows = await db.update(notifications).set({
    // read_at may not precede created_at (notifications_read_at_check), even with a skewed clock.
    readAt: sql`greatest(${input.at.toISOString()}::timestamptz, ${notifications.createdAt})`,
    emailState: sql`case when ${notifications.emailState} = 'pending' then 'suppressed' else ${notifications.emailState} end`,
    emailDueAt: null,
  }).where(and(eq(notifications.recipientUserId, input.userId), isNull(notifications.readAt), filter)).returning({ id: notifications.id });
  return rows.length;
}
