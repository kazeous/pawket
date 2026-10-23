import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { notifications, type PawketDatabase } from "@pawket/database";
import { NOTIFICATION_POLICY, NotificationError, type NotificationsMode } from "./policy.js";
import { isNotificationKind, type NotificationKind } from "./catalog.js";
import { renderNotice } from "./copy.js";

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

/** One inbox entry. Copy comes from `renderNotice`; nothing else about the subject is stored or returned. */
export type InboxItem = Readonly<{
  id: string; kind: NotificationKind; variant: string | null; title: string; body: string; actionLabel: string;
  actionRequired: boolean; linkPath: string; count: number; createdAt: string; read: boolean;
}>;
export type NotificationInbox = Readonly<{
  mode: NotificationsMode;
  list(userId: string, cursor: string | null): Promise<{ items: readonly InboxItem[]; nextCursor: string | null }>;
  summary(userId: string): Promise<{ unread: number }>;
  markRead(userId: string, target: MarkReadTarget): Promise<number>;
}>;

// The cursor carries the last row's updated_at at full microsecond precision (a JavaScript Date would drop the
// microseconds and skip rows that share the millisecond) and its id, as opaque base64url.
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6})\|([0-9a-f-]{36})$/u;
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
function decodeCursor(cursor: string): { at: string; id: string } {
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalid();
  const match = CURSOR_PATTERN.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match || encodeCursor(match[1]!, match[2]!) !== cursor || !UUID_PATTERN.test(match[2]!)) invalid();
  const at = match[1]!; const parsed = new Date(`${at}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 23) !== at.slice(0, 23)) invalid();
  return { at, id: match[2]! };
}
function validUser(userId: string) { if (typeof userId !== "string" || userId.length === 0 || userId.length > 200) invalid(); }

/** The viewer's own inbox (spec section 10). Reading never changes domain state. */
export function createNotificationInbox(input: { db: PawketDatabase; mode: NotificationsMode; now?: () => Date }): NotificationInbox {
  if (!input?.db || !["disabled", "enabled"].includes(input.mode)) invalid();
  const clock = input.now ?? (() => new Date());
  const available = () => { if (input.mode !== "enabled") throw new NotificationError("not_available"); };
  return {
    mode: input.mode,
    async list(userId, cursor) {
      available(); validUser(userId);
      const after = cursor === null ? null : decodeCursor(cursor);
      const size = NOTIFICATION_POLICY.inboxPageSize;
      const rows = await input.db.select({
        id: notifications.id, kind: notifications.kind, variant: notifications.variant, actionRequired: notifications.actionRequired,
        linkPath: notifications.linkPath, count: notifications.collapsedCount, createdAt: notifications.createdAt, readAt: notifications.readAt,
        cursorAt: sql<string>`to_char(${notifications.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      }).from(notifications).where(and(eq(notifications.recipientUserId, userId), after === null ? undefined
        : sql`(${notifications.updatedAt}, ${notifications.id}) < ((${after.at}::timestamp at time zone 'UTC'), ${after.id}::uuid)`))
        .orderBy(desc(notifications.updatedAt), desc(notifications.id)).limit(size + 1);
      const page = rows.slice(0, size); const last = page.at(-1);
      return {
        items: page.map((row) => {
          if (!isNotificationKind(row.kind)) throw new NotificationError("dependency_unavailable");
          const copy = renderNotice(row.kind, row.variant);
          return { id: row.id, kind: row.kind, variant: row.variant, title: copy.title, body: copy.body, actionLabel: copy.actionLabel,
            actionRequired: row.actionRequired, linkPath: row.linkPath, count: row.count, createdAt: row.createdAt.toISOString(), read: row.readAt !== null };
        }),
        nextCursor: rows.length > size && last ? encodeCursor(last.cursorAt, last.id) : null,
      };
    },
    async summary(userId) {
      available(); validUser(userId);
      // Count at most the cap, so a very large backlog costs no more than the badge can show.
      const capped = input.db.select({ id: notifications.id }).from(notifications)
        .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt))).limit(NOTIFICATION_POLICY.unreadCap).as("capped");
      const [row] = await input.db.select({ unread: sql<number>`count(*)::int` }).from(capped);
      return { unread: Math.min(Number(row?.unread ?? 0), NOTIFICATION_POLICY.unreadCap) };
    },
    async markRead(userId, target) {
      available();
      return markNotificationsRead(input.db, { userId, target, at: clock() });
    },
  };
}
