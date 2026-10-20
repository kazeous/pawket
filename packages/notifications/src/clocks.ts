import { and, desc, eq, getTableName, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  commissionDisputeStatements, commissionDisputes, commissionEvents, commissionLatePaymentClaims, commissionOrders, commissionProposals,
  commissionRefundEvents, commissionRefundObligations, commissionRefundSends, notificationReminders, trustAppeals, trustContentHides, trustPenalties,
  type PawketTransaction,
} from "@pawket/database";
import type { PgColumn, PgSelect, PgTable } from "drizzle-orm/pg-core";
import type { NotificationCategory, NotificationClock, NotificationSubjectType } from "./catalog.js";
import { NOTIFICATION_CLOCKS, NOTIFICATION_POLICY, NotificationError } from "./policy.js";
import type { NotificationDeadlinePort } from "./ports.js";

export type ClockRole = "buyer" | "creator" | "subject";
export type ClockRecipient = Readonly<{ userId: string; role: ClockRole }>;
/**
 * One pending deadline (spec section 9). `recipients` lists the acting party first; a scan-made `missed` notice goes
 * to every listed party. `orderId` builds the order-page links (null for appeal-window subjects without an order).
 */
export type OpenClock = Readonly<{
  clock: NotificationClock; subjectType: NotificationSubjectType; subjectId: string; orderId: string | null;
  recipients: readonly ClockRecipient[]; startedAt: Date; effectiveDeadline: Date; missedBy: "scan" | "domain" | "none";
}>;
export type ReminderStage = "due_24h" | "missed";

/** Mirrors the trust enforcement policy's `appealWindowMs` (14 days); this package does not depend on @pawket/trust. */
export const APPEAL_WINDOW_MS = 1_209_600_000;

export const CLOCK_CATEGORIES: Readonly<Record<NotificationClock, NotificationCategory>> = Object.freeze({
  request_response: "orders", quote_acceptance: "orders", payment: "orders", delivery_due: "orders", review_window: "orders",
  proposal_response: "disputes_refunds", dispute_response: "disputes_refunds", late_claim_response: "disputes_refunds",
  refund_send: "disputes_refunds", refund_confirm: "disputes_refunds", appeal_window: "moderation",
});
const MISSED_BY: Readonly<Record<NotificationClock, OpenClock["missedBy"]>> = Object.freeze({
  request_response: "domain", quote_acceptance: "domain", payment: "domain", delivery_due: "scan", review_window: "domain",
  proposal_response: "domain", dispute_response: "scan", late_claim_response: "domain", refund_send: "domain", refund_confirm: "domain",
  appeal_window: "none",
});

/** Pure: which reminder, if any, a clock owes at `now`. A null deadline (an open pause) owes nothing. */
export function reminderStage(input: { now: Date; startedAt: Date; effectiveDeadline: Date | null; missedBy: OpenClock["missedBy"] }): ReminderStage | null {
  if (input.effectiveDeadline === null) return null;
  const now = input.now.getTime(); const deadline = input.effectiveDeadline.getTime();
  if (now >= deadline) return input.missedBy === "scan" ? "missed" : null;
  if (now >= deadline - NOTIFICATION_POLICY.reminderLeadMs && deadline - input.startedAt.getTime() >= NOTIFICATION_POLICY.reminderMinimumNoticeMs) return "due_24h";
  return null;
}

type Candidate = Readonly<{ subjectType: NotificationSubjectType; subjectId: string; orderId: string | null; startedAt: Date | null;
  rawDeadline: Date; recipients: readonly ClockRecipient[];
  /** Reads the effective deadline through its owning module; null when the stored deadline is already effective. */
  effective: ((tx: PawketTransaction) => Promise<Date | null>) | null }>;
type Query = Readonly<{ now: Date; horizon: Date; limit: number; subjectId: string | null; subjectType: NotificationSubjectType | null; lock: boolean;
  deadlines: NotificationDeadlinePort }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const invalid = (): never => { throw new NotificationError("invalid_request"); };
const as = (value: Date) => new Date(value);
const subjectFilter = (column: PgColumn, query: Query, type: NotificationSubjectType): SQL | undefined =>
  query.subjectType === null ? undefined : query.subjectType === type ? eq(column, query.subjectId) : sql`false`;
/** A table-qualified column: select-list subqueries otherwise render outer columns bare, which would bind to the inner table. */
const q = (column: PgColumn) => sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
/** `not exists (subquery)` for a raw correlated subquery. */
const absent = (subquery: SQL) => sql`not exists (${subquery})`;
/** Scan clocks whose missed notice is already recorded for this (or a later) deadline cannot owe anything else. */
const notMissed = (type: NotificationSubjectType, id: PgColumn, clock: NotificationClock, deadline: PgColumn) => absent(sql`select 1 from ${notificationReminders}
  where ${q(notificationReminders.subjectType)} = ${type} and ${q(notificationReminders.subjectId)} = ${q(id)}::text and ${q(notificationReminders.clock)} = ${clock}
  and ${q(notificationReminders.stage)} = 'missed' and ${q(notificationReminders.effectiveDeadline)} >= ${q(deadline)}`);
const orderParty = (role: "buyer" | "creator", order: { buyer: string; creator: string }): ClockRecipient =>
  ({ userId: role === "buyer" ? order.buyer : order.creator, role });
const other = (role: string): "buyer" | "creator" => role === "buyer" ? "creator" : "buyer";

/** Discovery reads without locks; re-checking one candidate locks its subject row FOR SHARE so a concurrent action waits or wins first. */
function finish<T extends PgSelect>(builder: T, query: Query, of: PgTable): T {
  const limited = builder.limit(query.limit);
  return query.lock ? limited.for("share", { of }) : limited;
}

async function orderClock(tx: PawketTransaction, clock: "request_response" | "quote_acceptance" | "payment", query: Query): Promise<Candidate[]> {
  const state = clock === "request_response" ? "requested" : clock === "quote_acceptance" ? "quoted" : "awaiting_payment";
  const o = commissionOrders;
  // The start is the transition into the current state: the event row of the order's current version.
  const startedAt = sql`(select max(${q(commissionEvents.occurredAt)}) from ${commissionEvents} where ${q(commissionEvents.orderId)} = ${q(o.id)}
    and ${q(commissionEvents.orderVersion)} = ${q(o.version)})`.mapWith(commissionEvents.occurredAt);
  const found = await finish(tx.select({ id: o.id, buyer: o.buyerUserId,
    creator: o.creatorUserId, startedAt, deadline: o.expiresAt }).from(o).$dynamic()
    .where(and(eq(o.state, state), isNotNull(o.expiresAt), lte(o.expiresAt, query.horizon), subjectFilter(o.id, query, "commission_order")))
    .orderBy(desc(o.expiresAt), desc(o.id)), query, o);
  return found.map((row) => ({ subjectType: "commission_order", subjectId: row.id, orderId: row.id, startedAt: row.startedAt, rawDeadline: row.deadline!,
    recipients: [orderParty(clock === "request_response" ? "creator" : "buyer", row)], effective: null }));
}

async function deliveryClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const o = commissionOrders;
  const found = await finish(tx.select({ id: o.id, buyer: o.buyerUserId,
    creator: o.creatorUserId, startedAt: o.confirmedAt, deadline: o.dueAt }).from(o).$dynamic()
    .where(and(eq(o.state, "in_progress"), isNotNull(o.dueAt), lte(o.dueAt, query.horizon), notMissed("commission_order", o.id, "delivery_due", o.dueAt),
      subjectFilter(o.id, query, "commission_order")))
    .orderBy(desc(o.dueAt), desc(o.id)), query, o);
  return found.map((row) => ({ subjectType: "commission_order", subjectId: row.id, orderId: row.id, startedAt: row.startedAt, rawDeadline: row.deadline!,
    recipients: [orderParty("creator", row), orderParty("buyer", row)], effective: null }));
}

async function reviewClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const o = commissionOrders;
  // The module's completion deadline is the later of the review end and the completion floor, moved only later by pauses.
  const base = sql`greatest(${o.reviewEndsAt}, coalesce(${o.completionFloorAt}, ${o.reviewEndsAt}))`;
  const found = await finish(tx.select({ id: o.id,
    buyer: o.buyerUserId, creator: o.creatorUserId, startedAt: o.deliveredAt, reviewEndsAt: o.reviewEndsAt, floor: o.completionFloorAt }).from(o).$dynamic()
    .where(and(eq(o.state, "delivered"), isNotNull(o.reviewEndsAt), sql`${base} <= ${query.horizon.toISOString()}::timestamptz`, subjectFilter(o.id, query, "commission_order")))
    .orderBy(desc(base), desc(o.id)), query, o);
  return found.map((row) => {
    const reviewEndsAt = row.reviewEndsAt!;
    const rawDeadline = row.floor && row.floor > reviewEndsAt ? row.floor : reviewEndsAt;
    return { subjectType: "commission_order", subjectId: row.id, orderId: row.id, startedAt: row.startedAt, rawDeadline, recipients: [orderParty("buyer", row)],
      effective: (port: PawketTransaction) => query.deadlines.completion(port, { reviewEndsAt: as(reviewEndsAt), completionFloorAt: row.floor ? as(row.floor) : null }) };
  });
}

async function proposalClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const p = commissionProposals; const o = commissionOrders;
  const found = await finish(tx.select({ id: p.id,
    orderId: p.orderId, role: p.proposerRole, buyer: o.buyerUserId, creator: o.creatorUserId, startedAt: p.createdAt, deadline: p.respondBy }).from(p).$dynamic()
    .innerJoin(o, eq(o.id, p.orderId))
    .where(and(isNull(p.endedAt), eq(p.state, "pending"), lte(p.respondBy, query.horizon), subjectFilter(p.id, query, "commission_proposal")))
    .orderBy(desc(p.respondBy), desc(p.id)), query, p);
  return found.map((row) => ({ subjectType: "commission_proposal", subjectId: row.id, orderId: row.orderId, startedAt: row.startedAt, rawDeadline: row.deadline,
    recipients: [orderParty(other(row.role), row)], effective: (port: PawketTransaction) => query.deadlines.resolution(port, as(row.deadline)) }));
}

async function disputeClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const d = commissionDisputes; const o = commissionOrders; const s = commissionDisputeStatements;
  // Pending until the respondent (the party that did not open the dispute) files a response statement.
  const answered = sql`select 1 from ${s} where ${q(s.disputeId)} = ${q(d.id)} and ${q(s.kind)} = 'response'
    and ${q(s.authorRole)} = case when ${q(d.openerRole)} = 'buyer' then 'creator' else 'buyer' end`;
  const found = await finish(tx.select({ id: d.id,
    orderId: d.orderId, role: d.openerRole, buyer: o.buyerUserId, creator: o.creatorUserId, startedAt: d.openedAt, deadline: d.respondBy }).from(d).$dynamic()
    .innerJoin(o, eq(o.id, d.orderId))
    .where(and(isNull(d.closedAt), eq(d.state, "open"), lte(d.respondBy, query.horizon), absent(answered),
      notMissed("commission_dispute", d.id, "dispute_response", d.respondBy), subjectFilter(d.id, query, "commission_dispute")))
    .orderBy(desc(d.respondBy), desc(d.id)), query, d);
  return found.map((row) => ({ subjectType: "commission_dispute", subjectId: row.id, orderId: row.orderId, startedAt: row.startedAt, rawDeadline: row.deadline,
    // Respondent first (the 24-hour reminder); the opener also gets the missed notice.
    recipients: [orderParty(other(row.role), row), orderParty(row.role === "buyer" ? "buyer" : "creator", row)],
    effective: (port: PawketTransaction) => query.deadlines.resolution(port, as(row.deadline)) }));
}

async function lateClaimClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const c = commissionLatePaymentClaims; const o = commissionOrders;
  const found = await finish(tx.select({ id: c.id, orderId: c.orderId,
    buyer: o.buyerUserId, creator: o.creatorUserId, startedAt: c.filedAt, deadline: c.creatorRespondBy }).from(c).$dynamic()
    .innerJoin(o, eq(o.id, c.orderId))
    .where(and(isNull(c.endedAt), ne(c.state, "escalated"), lte(c.creatorRespondBy, query.horizon), subjectFilter(c.id, query, "commission_late_payment_claim")))
    .orderBy(desc(c.creatorRespondBy), desc(c.id)), query, c);
  return found.map((row) => ({ subjectType: "commission_late_payment_claim", subjectId: row.id, orderId: row.orderId, startedAt: row.startedAt, rawDeadline: row.deadline,
    recipients: [orderParty("creator", row)], effective: (port: PawketTransaction) => query.deadlines.resolution(port, as(row.deadline)) }));
}

async function refundClock(tx: PawketTransaction, clock: "refund_send" | "refund_confirm", query: Query): Promise<Candidate[]> {
  const r = commissionRefundObligations; const e = commissionRefundEvents; const s = commissionRefundSends;
  const send = clock === "refund_send";
  // Refund send restarts at the latest destination entry or owner-required resend; confirmation starts at the current send.
  const startedAt = send
    ? sql`coalesce((select max(${q(e.occurredAt)}) from ${e} where ${q(e.obligationId)} = ${q(r.id)} and ${q(e.action)} in ('destination_entered','resend_required')),
        ${q(r.destinationEnteredAt)})`.mapWith(e.occurredAt)
    : sql`(select ${q(s.recordedAt)} from ${s} where ${q(s.id)} = ${q(r.currentSendId)} and ${q(s.obligationId)} = ${q(r.id)})`.mapWith(s.recordedAt);
  const deadline = send ? r.dueAt : r.confirmBy;
  const found = await finish(tx.select({ id: r.id,
    orderId: r.orderId, buyer: r.buyerUserId, creator: r.creatorUserId, startedAt, deadline }).from(r).$dynamic()
    .where(and(eq(r.state, send ? "awaiting_send" : "sent"), isNotNull(deadline), lte(deadline, query.horizon), subjectFilter(r.id, query, "commission_refund_obligation")))
    .orderBy(desc(deadline), desc(r.id)), query, r);
  return found.map((row) => ({ subjectType: "commission_refund_obligation", subjectId: row.id, orderId: row.orderId, startedAt: row.startedAt, rawDeadline: row.deadline!,
    recipients: [orderParty(send ? "creator" : "buyer", row)], effective: (port: PawketTransaction) => query.deadlines.resolution(port, as(row.deadline!)) }));
}

/** P5: content hides and restrictions only, while the action is in force and unappealed (the appeal service's duplicate lookup). */
async function appealClock(tx: PawketTransaction, query: Query): Promise<Candidate[]> {
  const h = trustContentHides; const p = trustPenalties; const a = trustAppeals;
  const startHorizon = new Date(query.horizon.getTime() - APPEAL_WINDOW_MS);
  const hides = await finish(tx.select({ id: h.id, orderId: h.orderId, owner: h.contentOwnerUserId,
    startedAt: h.hiddenAt }).from(h).$dynamic()
    .where(and(isNull(h.releasedAt), lte(h.hiddenAt, startHorizon), absent(sql`select 1 from ${a} where ${q(a.hideId)} = ${q(h.id)}`),
      subjectFilter(h.id, query, "trust_content_hide")))
    .orderBy(desc(h.hiddenAt), desc(h.id)), query, h);
  const penalties = await finish(tx.select({ id: p.id, subject: p.subjectUserId, startedAt: p.startsAt }).from(p).$dynamic()
    .where(and(eq(p.kind, "restriction"), eq(p.state, "active"), isNull(p.replacesPenaltyId), or(isNull(p.endsAt), gt(p.endsAt, query.now)),
      lte(p.startsAt, startHorizon), absent(sql`select 1 from ${a} where ${q(a.penaltyId)} = ${q(p.id)}`),
      subjectFilter(p.id, query, "trust_penalty")))
    .orderBy(desc(p.startsAt), desc(p.id)), query, p);
  const candidate = (subjectType: "trust_content_hide" | "trust_penalty", id: string, orderId: string | null, userId: string, startedAt: Date): Candidate => {
    const rawDeadline = new Date(startedAt.getTime() + APPEAL_WINDOW_MS);
    return { subjectType, subjectId: id, orderId, startedAt, rawDeadline, recipients: [{ userId, role: "subject" }],
      effective: (port: PawketTransaction) => query.deadlines.enforcement(port, as(rawDeadline)) };
  };
  return [...hides.map((row) => candidate("trust_content_hide", row.id, row.orderId, row.owner, row.startedAt)),
    ...penalties.map((row) => candidate("trust_penalty", row.id, null, row.subject, row.startedAt))]
    .sort((left, right) => right.rawDeadline.getTime() - left.rawDeadline.getTime() || (left.subjectId < right.subjectId ? 1 : -1)).slice(0, query.limit);
}

function candidates(tx: PawketTransaction, clock: NotificationClock, query: Query): Promise<Candidate[]> {
  switch (clock) {
    case "request_response": case "quote_acceptance": case "payment": return orderClock(tx, clock, query);
    case "delivery_due": return deliveryClock(tx, query);
    case "review_window": return reviewClock(tx, query);
    case "proposal_response": return proposalClock(tx, query);
    case "dispute_response": return disputeClock(tx, query);
    case "late_claim_response": return lateClaimClock(tx, query);
    case "refund_send": case "refund_confirm": return refundClock(tx, clock, query);
    case "appeal_window": return appealClock(tx, query);
  }
}

function checkInput(input: { clock: NotificationClock; now: Date; deadlines: NotificationDeadlinePort }) {
  if (!(NOTIFICATION_CLOCKS as readonly string[]).includes(input.clock) || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())
    || typeof input.deadlines?.resolution !== "function" || typeof input.deadlines.completion !== "function" || typeof input.deadlines.enforcement !== "function") invalid();
}
function open(clock: NotificationClock, candidate: Candidate, effectiveDeadline: Date | null): OpenClock | null {
  if (candidate.startedAt === null || effectiveDeadline === null) return null; // No start fact, or paused: nothing is owed.
  if (!(effectiveDeadline instanceof Date) || !Number.isFinite(effectiveDeadline.getTime())) throw new NotificationError("dependency_unavailable");
  return Object.freeze({ clock, subjectType: candidate.subjectType, subjectId: candidate.subjectId, orderId: candidate.orderId,
    recipients: Object.freeze(candidate.recipients.map((recipient) => Object.freeze({ ...recipient }))), startedAt: as(candidate.startedAt),
    effectiveDeadline: as(effectiveDeadline), missedBy: MISSED_BY[clock] });
}

/**
 * Pending clocks whose stored deadline is within the reminder lead of `now`, newest deadline first. Effective deadlines
 * only move later than the stored one (pauses), so the stored deadline bounds the read. Each effective deadline is read
 * in its own savepoint; a candidate whose deadline read fails is reported to `onCandidateError` and left out (without
 * the callback the error is thrown). Paused clocks (null effective deadline) are left out.
 */
export async function readOpenClocks(tx: PawketTransaction, input: { clock: NotificationClock; now: Date; limit: number; deadlines: NotificationDeadlinePort;
  onCandidateError?: (subjectId: string) => void }): Promise<readonly OpenClock[]> {
  checkInput(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) invalid();
  const now = as(input.now);
  const found = await candidates(tx, input.clock, { now, horizon: new Date(now.getTime() + NOTIFICATION_POLICY.reminderLeadMs), limit: input.limit,
    subjectId: null, subjectType: null, lock: false, deadlines: input.deadlines });
  const result: OpenClock[] = [];
  for (const candidate of found) {
    try {
      const effective = candidate.effective;
      const clock = open(input.clock, candidate, effective ? await tx.transaction((savepoint) => effective(savepoint)) : candidate.rawDeadline);
      if (clock) result.push(clock);
    } catch (error) {
      if (!input.onCandidateError) throw error;
      input.onCandidateError(candidate.subjectId);
    }
  }
  return Object.freeze(result);
}

/** Re-reads one clock under FOR SHARE locks on its subject row and re-checks that it is still pending. */
export async function readOpenClock(tx: PawketTransaction, input: { clock: NotificationClock; subjectType: NotificationSubjectType; subjectId: string; now: Date;
  deadlines: NotificationDeadlinePort }): Promise<OpenClock | null> {
  checkInput(input);
  if (typeof input.subjectId !== "string" || !UUID_PATTERN.test(input.subjectId)) invalid();
  const now = as(input.now);
  const [candidate] = await candidates(tx, input.clock, { now, horizon: new Date(now.getTime() + NOTIFICATION_POLICY.reminderLeadMs), limit: 1,
    subjectId: input.subjectId, subjectType: input.subjectType, lock: true, deadlines: input.deadlines });
  if (!candidate) return null;
  return open(input.clock, candidate, candidate.effective ? await candidate.effective(tx) : candidate.rawDeadline);
}

/** Ledger rows already written for these subjects of one clock, as `type:id:stage:deadline` keys. */
export async function readReminderKeys(tx: PawketTransaction, clock: NotificationClock, subjectIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (subjectIds.length === 0) return new Set();
  const found = await tx.select({ subjectType: notificationReminders.subjectType, subjectId: notificationReminders.subjectId, stage: notificationReminders.stage,
    effectiveDeadline: notificationReminders.effectiveDeadline }).from(notificationReminders)
    .where(and(eq(notificationReminders.clock, clock), inArray(notificationReminders.subjectId, [...subjectIds])));
  return new Set(found.map((row) => reminderKey(row.subjectType, row.subjectId, row.stage, row.effectiveDeadline)));
}
export const reminderKey = (subjectType: string, subjectId: string, stage: string, deadline: Date) => `${subjectType}:${subjectId}:${stage}:${deadline.getTime()}`;
