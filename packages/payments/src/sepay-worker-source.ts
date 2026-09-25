import {
  paymentsSepayConnections, paymentsSepayInbox, paymentsSepayProcessing,
  systemOutbox, type PawketDatabase,
} from "@pawket/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { SEPAY_EVENT_RECEIVED } from "./sepay-inbox-service.js";
import { sepayUuid } from "./sepay-service-support.js";

export type SePayOutboxSource = Readonly<{
  outboxEventId: string; eventType: string; eventVersion: number;
  aggregateType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string;
}>;

/** The queue is a delivery hint; only an exact persisted accepted inbox may run. */
export async function resolveSePayWorkerSource(db: PawketDatabase, event: SePayOutboxSource, environment: "test" | "live"): Promise<string> {
  const invalid = () => { throw new Error("Invalid SePay worker source"); };
  if (!sepayUuid(event.outboxEventId) || !sepayUuid(event.aggregateId) || event.eventType !== SEPAY_EVENT_RECEIVED ||
    event.eventVersion !== 1 || event.aggregateType !== "sepay_inbox" || !event.payload ||
    Object.keys(event.payload).join() !== "inboxId" || event.payload.inboxId !== event.aggregateId) invalid();
  const [row] = await db.select({ event: systemOutbox, inbox: paymentsSepayInbox, environment: paymentsSepayConnections.providerEnvironment })
    .from(systemOutbox).innerJoin(paymentsSepayInbox, eq(systemOutbox.aggregateId, sql`${paymentsSepayInbox.id}::text`))
    .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
    .where(eq(systemOutbox.id, event.outboxEventId)).limit(1);
  if (!row || row.environment !== environment || row.inbox.disposition !== "accepted" ||
    row.event.eventType !== SEPAY_EVENT_RECEIVED || row.event.eventVersion !== 1 || row.event.aggregateType !== "sepay_inbox" ||
    row.event.aggregateId !== event.aggregateId || row.event.occurredAt.toISOString() !== event.occurredAt ||
    Object.keys(row.event.payload).join() !== "inboxId" || row.event.payload.inboxId !== row.inbox.id ||
    row.inbox.receivedAt.getTime() !== row.event.occurredAt.getTime()) invalid();
  return row!.inbox.id;
}

/** Aggregates only: account identifiers, amounts and bank contents never leave Payments. */
export async function readSePayBacklog(db: PawketDatabase, environment: "test" | "live", now: Date) {
  const [row] = await db.select({
    pending: sql<number>`count(*) filter (where ${paymentsSepayProcessing.status} in ('pending', 'processing'))::integer`,
    reviewRequired: sql<number>`count(*) filter (where ${paymentsSepayProcessing.status} = 'review_required')::integer`,
    oldestAgeSeconds: sql<number>`coalesce(greatest(0, extract(epoch from (${now.toISOString()}::timestamptz - min(${paymentsSepayInbox.receivedAt}) filter (where ${paymentsSepayProcessing.status} in ('pending', 'processing'))))), 0)::double precision`,
  }).from(paymentsSepayProcessing).innerJoin(paymentsSepayInbox, eq(paymentsSepayInbox.id, paymentsSepayProcessing.inboxId))
    .innerJoin(paymentsSepayConnections, eq(paymentsSepayConnections.id, paymentsSepayInbox.connectionId))
    .where(and(eq(paymentsSepayConnections.providerEnvironment, environment), inArray(paymentsSepayProcessing.status, ["pending", "processing", "review_required"])));
  return row ?? { pending: 0, reviewRequired: 0, oldestAgeSeconds: 0 };
}
