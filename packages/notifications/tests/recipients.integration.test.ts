import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveNotices } from "../src/recipients.js";
import { createNotificationFixture, type CommittedRow, type FixtureOrder } from "./notification-fixture.js";

const f = createNotificationFixture("recipients");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);

type Expected = Readonly<{ to: string; kind: string; variant?: string | null; action: boolean; category: string; link: string; email: "now" | "never" }>;
async function notices(row: CommittedRow) { return f.db.transaction((tx) => resolveNotices(tx, row)); }
async function expectNotices(row: CommittedRow, expected: readonly Expected[]) {
  const actual = (await notices(row)).map((n) => ({ to: n.recipientUserId, kind: n.kind, variant: n.variant, action: n.actionRequired, category: n.category, link: n.linkPath, email: n.email }));
  const sorted = <T extends { to: string }>(list: readonly T[]) => [...list].sort((a, b) => a.to.localeCompare(b.to));
  expect(sorted(actual)).toEqual(sorted(expected.map((e) => ({ variant: null, ...e }))));
}
const buyerLink = (o: FixtureOrder) => `/commissions/${o.orderId}`;
const creatorLink = (o: FixtureOrder) => `/creator/commissions/${o.orderId}`;
const orderPayload = (o: FixtureOrder, state: string, reason: string | null = null) => ({ orderId: o.orderId, version: 2, state, reason, correlationId: randomUUID() });

describe("recipient matrix", () => {
  test("subjects identify the committed order, dispute, refund, owner case and tip rather than the transport aggregate", async () => {
    async function subject(source: CommittedRow, type: string, id: string) {
      const rows = await notices(source); expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => [row.subjectType, row.subjectId])).toEqual(rows.map(() => [type, id]));
    }
    const order = await f.paidOrder();
    await subject(await f.outbox("commission.confirmed.v1", "payment_intent", order.intentId,
      { paymentIntentId: order.intentId, orderId: order.orderId, creatorUserId: order.creator.userId, confirmationId: randomUUID(), correlationId: randomUUID() }), "commission_order", order.orderId);
    const disputeId = await f.dispute(order, "buyer");
    await subject(await f.outbox("resolution.dispute_opened.v1", "commission_dispute", disputeId, { disputeId, orderId: order.orderId }), "commission_dispute", disputeId);
    const obligationId = await f.refundObligation(order); const refundEventId = await f.refundEvent(obligationId, "created");
    await subject(await f.outbox("refund.event_recorded.v1", "commission_refund_obligation", obligationId,
      { obligationId, refundEventId, action: "created" }), "commission_refund_obligation", obligationId);
    await f.owner(); const caseId = await f.openCase({ kind: "dispute", sourceType: "commission_dispute", sourceId: disputeId, orderId: order.orderId });
    await subject(await f.outbox("trust.case_opened.v1", "trust_case", caseId, { caseId, kind: "dispute", sourceId: disputeId }), "trust_case", caseId);
    const creatorUserId = await f.person(); const tip = await f.tipIntent(creatorUserId);
    await subject(await f.outbox("tip.transfer_claimed.v1", "payment_intent", tip.intentId,
      { paymentIntentId: tip.intentId, tipId: tip.tipId, creatorUserId, claimId: randomUUID(), correlationId: randomUUID() }), "tip", tip.tipId);
  });

  test("order events reach the parties named in spec section 6", async () => {
    const o = await f.paidOrder(); const b = o.buyer.userId; const c = o.creator.userId;
    const order = (type: string, state: string, reason: string | null = null) => f.outbox(type, "commission_order", o.orderId, orderPayload(o, state, reason));
    await expectNotices(await order("commission.requested.v1", "requested"),
      [{ to: c, kind: "order_requested", action: true, category: "orders", link: creatorLink(o), email: "now" }]);
    await expectNotices(await order("commission.quoted.v1", "quoted"),
      [{ to: b, kind: "order_quoted", action: true, category: "orders", link: buyerLink(o), email: "now" }]);
    await expectNotices(await order("commission.awaiting_payment.v1", "awaiting_payment"),
      [{ to: b, kind: "order_payment_due", action: true, category: "orders", link: buyerLink(o), email: "now" }]);
    await expectNotices(await f.outbox("commission.transfer_claimed.v1", "commission_order", o.orderId, { orderId: o.orderId, claimId: randomUUID(), buyerUserId: b, correlationId: randomUUID() }),
      [{ to: c, kind: "order_transfer_claimed", action: true, category: "orders", link: creatorLink(o), email: "now" }]);
    // Ruling R7: payment confirmation is announced from commission.confirmed.v1; commission.in_progress.v1 is a reopen after a change request.
    await expectNotices(await order("commission.in_progress.v1", "in_progress", "draft_changes_requested"), []);
    await expectNotices(await order("commission.delivered.v1", "delivered"),
      [{ to: b, kind: "order_delivered", action: true, category: "orders", link: buyerLink(o), email: "now" }]);
    await expectNotices(await order("commission.completed.v1", "completed"), [
      { to: b, kind: "order_completed", action: false, category: "orders", link: buyerLink(o), email: "now" },
      { to: c, kind: "order_completed", action: false, category: "orders", link: creatorLink(o), email: "now" }]);
    await expectNotices(await order("commission.closed.v1", "closed", "creator_declined"), [
      { to: b, kind: "order_closed", variant: "creator_declined", action: false, category: "orders", link: buyerLink(o), email: "now" },
      { to: c, kind: "order_closed", variant: "creator_declined", action: false, category: "orders", link: creatorLink(o), email: "now" }]);
    await expectNotices(await f.outbox("commission.confirmed.v1", "payment_intent", o.intentId,
      { paymentIntentId: o.intentId, orderId: o.orderId, creatorUserId: c, confirmationId: randomUUID(), correlationId: randomUUID() }), [
      { to: b, kind: "order_in_progress", action: false, category: "orders", link: buyerLink(o), email: "now" },
      { to: c, kind: "order_in_progress", action: false, category: "orders", link: creatorLink(o), email: "now" }]);
  });

  test("a confirmation that names another order or a foreign intent is refused", async () => {
    const o = await f.paidOrder(); const other = await f.paidOrder();
    await expect(notices(await f.outbox("commission.confirmed.v1", "payment_intent", o.intentId,
      { paymentIntentId: o.intentId, orderId: other.orderId, creatorUserId: o.creator.userId, confirmationId: randomUUID(), correlationId: randomUUID() }))).rejects.toThrow();
    const tip = await f.tipIntent(await f.person());
    await expect(notices(await f.outbox("commission.confirmed.v1", "payment_intent", tip.intentId,
      { paymentIntentId: tip.intentId, orderId: o.orderId, creatorUserId: o.creator.userId, confirmationId: randomUUID(), correlationId: randomUUID() }))).rejects.toThrow();
  });

  test("a close reason outside the variant pattern gives a null variant", async () => {
    const o = await f.paidOrder();
    const rows = await notices(await f.outbox("commission.closed.v1", "commission_order", o.orderId, orderPayload(o, "closed", "Not-A-Variant")));
    expect(rows.map((row) => row.variant)).toEqual([null, null]);
  });

  test("draft submissions reach the buyer under deliveries, and a final one is announced by the delivery event", async () => {
    const o = await f.paidOrder();
    const sent = (kind: string) => f.outbox("commission.submission_sent.v1", "commission_order", o.orderId,
      { orderId: o.orderId, submissionId: randomUUID(), kind, sequence: 1, correlationId: randomUUID() });
    await expectNotices(await sent("draft"), [{ to: o.buyer.userId, kind: "draft_sent", action: false, category: "deliveries", link: buyerLink(o), email: "now" }]);
    await expectNotices(await sent("final"), []);
  });

  test("a response reaches the creator with the committed submission kind as its variant (R9)", async () => {
    const respond = (o: FixtureOrder, submissionId: string, response: string) => f.outbox("commission.submission_responded.v1", "commission_order", o.orderId,
      { orderId: o.orderId, submissionId, response, correlationId: randomUUID() });
    const draftOrder = await f.paidOrder(); const draftId = await f.submission(draftOrder, "draft");
    for (const response of ["approved", "changes_requested"]) {
      await expectNotices(await respond(draftOrder, draftId, response),
        [{ to: draftOrder.creator.userId, kind: "draft_responded", variant: "draft", action: false, category: "deliveries", link: creatorLink(draftOrder), email: "now" }]);
    }
    const finalOrder = await f.paidOrder(); const finalId = await f.submission(finalOrder, "final");
    for (const response of ["approved", "changes_requested"]) {
      await expectNotices(await respond(finalOrder, finalId, response),
        [{ to: finalOrder.creator.userId, kind: "draft_responded", variant: "final", action: false, category: "deliveries", link: creatorLink(finalOrder), email: "now" }]);
    }
    // The submission must exist and belong to the order the event names; the payload alone is never trusted.
    await expect(notices(await respond(draftOrder, randomUUID(), "approved"))).rejects.toThrow();
    await expect(notices(await respond(finalOrder, draftId, "approved"))).rejects.toThrow();
  });

  test("proposals go to the role opposite the proposer, and their end to both", async () => {
    const o = await f.paidOrder();
    const byBuyer = await f.proposal(o, "buyer");
    await expectNotices(await f.outbox("resolution.proposal_made.v1", "commission_proposal", byBuyer, { proposalId: byBuyer, orderId: o.orderId, kind: "cancel_with_refund" }),
      [{ to: o.creator.userId, kind: "proposal_received", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    await f.endProposal(byBuyer, "declined");
    await expectNotices(await f.outbox("resolution.proposal_ended.v1", "commission_proposal", byBuyer, { proposalId: byBuyer, orderId: o.orderId, state: "declined" }), [
      { to: o.buyer.userId, kind: "proposal_ended", variant: "declined", action: false, category: "disputes_refunds", link: buyerLink(o), email: "now" },
      { to: o.creator.userId, kind: "proposal_ended", variant: "declined", action: false, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    const byCreator = await f.proposal(o, "creator");
    await expectNotices(await f.outbox("resolution.proposal_made.v1", "commission_proposal", byCreator, { proposalId: byCreator, orderId: o.orderId, kind: "cancel_with_refund" }),
      [{ to: o.buyer.userId, kind: "proposal_received", action: true, category: "disputes_refunds", link: buyerLink(o), email: "now" }]);
  });

  test("disputes, statements, closure and rulings follow the opener and author roles", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const b = o.buyer.userId; const c = o.creator.userId;
    const disputeId = await f.dispute(o, "buyer");
    await expectNotices(await f.outbox("resolution.dispute_opened.v1", "commission_dispute", disputeId, { disputeId, orderId: o.orderId }),
      [{ to: c, kind: "dispute_opened", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    const fromCreator = await f.statement(disputeId, c, "creator");
    await expectNotices(await f.outbox("resolution.dispute_statement_added.v1", "commission_dispute", disputeId, { disputeId, statementId: fromCreator, authorRole: "creator" }),
      [{ to: b, kind: "dispute_statement", action: false, category: "disputes_refunds", link: buyerLink(o), email: "now" }]);
    const fromBuyer = await f.statement(disputeId, b, "buyer");
    await expectNotices(await f.outbox("resolution.dispute_statement_added.v1", "commission_dispute", disputeId, { disputeId, statementId: fromBuyer, authorRole: "buyer" }),
      [{ to: c, kind: "dispute_statement", action: false, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    const rulingId = await f.ruling(disputeId, owner);
    await expectNotices(await f.outbox("resolution.ruling_recorded.v1", "commission_ruling", rulingId, { rulingId, disputeId, orderId: o.orderId, outcome: "close" }), [
      { to: b, kind: "ruling_recorded", action: true, category: "disputes_refunds", link: buyerLink(o), email: "now" },
      { to: c, kind: "ruling_recorded", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    const correctionId = await f.correction(rulingId, owner);
    await expectNotices(await f.outbox("resolution.ruling_corrected.v1", "commission_ruling_correction", correctionId, { correctionId, rulingId, effect: "reduced" }), [
      { to: b, kind: "ruling_corrected", action: true, category: "disputes_refunds", link: buyerLink(o), email: "now" },
      { to: c, kind: "ruling_corrected", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    await f.closeDispute(disputeId);
    await expectNotices(await f.outbox("resolution.dispute_closed.v1", "commission_dispute", disputeId, { disputeId, orderId: o.orderId, state: "withdrawn" }), [
      { to: b, kind: "dispute_closed", variant: "withdrawn", action: false, category: "disputes_refunds", link: buyerLink(o), email: "now" },
      { to: c, kind: "dispute_closed", variant: "withdrawn", action: false, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    const byCreator = await f.paidOrder(); const creatorDispute = await f.dispute(byCreator, "creator");
    await expectNotices(await f.outbox("resolution.dispute_opened.v1", "commission_dispute", creatorDispute, { disputeId: creatorDispute, orderId: byCreator.orderId }),
      [{ to: byCreator.buyer.userId, kind: "dispute_opened", action: true, category: "disputes_refunds", link: buyerLink(byCreator), email: "now" }]);
  });

  test("an owner statement reaches both parties only", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const disputeId = await f.dispute(o, "buyer");
    const question = await f.statement(disputeId, owner, "owner");
    const rows = await notices(await f.outbox("resolution.dispute_statement_added.v1", "commission_dispute", disputeId, { disputeId, statementId: question, authorRole: "owner" }));
    expect(rows.map((row) => row.recipientUserId).sort()).toEqual([o.buyer.userId, o.creator.userId].sort());
    expect(rows.map((row) => row.recipientUserId)).not.toContain(owner);
    expect(rows.every((row) => row.kind === "dispute_statement" && !row.actionRequired)).toBe(true);
  });

  test("a statement whose committed author role differs from the event is refused", async () => {
    const o = await f.paidOrder(); const disputeId = await f.dispute(o, "buyer"); const statementId = await f.statement(disputeId, o.buyer.userId, "buyer");
    await expect(notices(await f.outbox("resolution.dispute_statement_added.v1", "commission_dispute", disputeId, { disputeId, statementId, authorRole: "creator" }))).rejects.toThrow();
  });

  test("late-payment claims go to the creator, and their end to both", async () => {
    const o = await f.expiredOrder(); const claimId = await f.lateClaim(o);
    await expectNotices(await f.outbox("resolution.late_claim_filed.v1", "commission_late_payment_claim", claimId, { claimId, orderId: o.orderId }),
      [{ to: o.creator.userId, kind: "late_claim_filed", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
    await expectNotices(await f.outbox("resolution.late_claim_ended.v1", "commission_late_payment_claim", claimId, { claimId, orderId: o.orderId, state: "escalated" }), [
      { to: o.buyer.userId, kind: "late_claim_ended", variant: "escalated", action: false, category: "disputes_refunds", link: buyerLink(o), email: "now" },
      { to: o.creator.userId, kind: "late_claim_ended", variant: "escalated", action: false, category: "disputes_refunds", link: creatorLink(o), email: "now" }]);
  });

  test("a fulfilment freeze has no notice of its own (P3)", async () => {
    const o = await f.paidOrder();
    await expectNotices(await f.outbox("resolution.fulfillment_frozen.v1", "creator", o.creator.userId, { creatorUserId: o.creator.userId, closedOrders: 1 }), []);
  });

  test("a freeze gives each affected buyer order_closed and refund_account_needed (P3)", async () => {
    const first = await f.paidOrder(); const second = await f.paidOrder(first.creator);
    await expectNotices(await f.outbox("resolution.fulfillment_frozen.v1", "creator", first.creator.userId, { creatorUserId: first.creator.userId, closedOrders: 2 }), []);
    for (const o of [first, second]) {
      const closed = await f.outbox("commission.closed.v1", "commission_order", o.orderId, orderPayload(o, "closed", "fulfillment_frozen"));
      const obligationId = await f.refundObligation(o, "fulfillment_freeze"); const refund = await f.refundEvent(obligationId, "created");
      const created = await f.outbox("refund.event_recorded.v1", "commission_refund_obligation", obligationId, { obligationId, refundEventId: refund, action: "created" });
      const buyerKinds = [...await notices(closed), ...await notices(created)].filter((row) => row.recipientUserId === o.buyer.userId).map((row) => [row.kind, row.variant, row.actionRequired]);
      expect(buyerKinds.sort()).toEqual([["order_closed", "fulfillment_frozen", false], ["refund_account_needed", null, true]]);
    }
  });

  test("a new case reaches the active owner with its kind and admin link", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const disputeId = await f.dispute(o, "buyer");
    const caseId = await f.openCase({ kind: "dispute", sourceType: "commission_dispute", sourceId: disputeId, orderId: o.orderId });
    await expectNotices(await f.outbox("trust.case_opened.v1", "trust_case", caseId, { caseId, orderId: o.orderId, sourceId: disputeId, policyRevisionId: null, correlationId: randomUUID() }),
      [{ to: owner, kind: "owner_case_opened", variant: "dispute", action: false, category: "owner_queue", link: `/admin/cases/${caseId}`, email: "now" }]);
  });

  test("every active owner gets the item and a revoked owner grant gets none (P8)", async () => {
    const o = await f.paidOrder(); const first = await f.owner(); const revoked = await f.ownerGrant("revoked");
    const disputeId = await f.dispute(o, "buyer");
    const caseId = await f.openCase({ kind: "dispute", sourceType: "commission_dispute", sourceId: disputeId, orderId: o.orderId });
    const opened = await f.outbox("trust.case_opened.v1", "trust_case", caseId, { caseId, orderId: o.orderId, sourceId: disputeId, policyRevisionId: null, correlationId: randomUUID() });
    const item = (to: string) => ({ to, kind: "owner_case_opened", variant: "dispute", action: false, category: "owner_queue", link: `/admin/cases/${caseId}`, email: "now" as const });
    await expectNotices(opened, [item(first)]);
    expect((await notices(opened)).map((row) => row.recipientUserId)).not.toContain(revoked);
    // The database allows one active owner at a time; the index is lifted here only to prove the resolver loops over every active grant.
    await f.withManyOwners(async () => {
      const second = await f.ownerGrant("active");
      await expectNotices(opened, [item(first), item(second)]);
    });
  });

  test("refund events reach the parties named in the design, with links to the order page", async () => {
    const o = await f.paidOrder(); const b = o.buyer.userId; const c = o.creator.userId; const obligationId = await f.refundObligation(o);
    const announce = async (action: string) => f.outbox("refund.event_recorded.v1", "commission_refund_obligation", obligationId,
      { obligationId, refundEventId: await f.refundEvent(obligationId, action), action });
    const refund = (to: string, kind: string, action: boolean, variant: string | null = null): Expected => ({ to, kind, variant, action, category: "disputes_refunds",
      link: to === b ? buyerLink(o) : creatorLink(o), email: "now" });
    await expectNotices(await announce("created"), [refund(b, "refund_account_needed", true), refund(c, "refund_owed", false)]);
    await expectNotices(await announce("destination_entered"), [refund(c, "refund_send_due", true)]);
    await expectNotices(await announce("sent_recorded"), [refund(b, "refund_sent", true)]);
    await expectNotices(await announce("receipt_denied"), [refund(c, "refund_not_received", true)]);
    // resend_required restarts the refund-send clock (asserted with the clock reader in Task 6); here the creator is told to send again.
    await expectNotices(await announce("resend_required"), [refund(c, "refund_resend_required", true)]);
    for (const action of ["receipt_confirmed", "presumed_received", "waived"]) {
      await expectNotices(await announce(action), [refund(b, "refund_settled", false, action), refund(c, "refund_settled", false, action)]);
    }
  });

  test("refund actions that never notify, and refund events that do not match the committed row, are refused", async () => {
    const o = await f.paidOrder(); const obligationId = await f.refundObligation(o); const other = await f.refundObligation(await f.paidOrder());
    const refundEventId = await f.refundEvent(obligationId, "created");
    const announce = (payload: Record<string, unknown>, aggregateId = obligationId) => f.outbox("refund.event_recorded.v1", "commission_refund_obligation", aggregateId, payload);
    for (const action of ["destination_revealed", "deadline_extended", "amount_adjusted", "amount_recorded", "destination_purged"]) {
      const silentId = await f.refundEvent(obligationId, action);
      await expect(notices(await announce({ obligationId, refundEventId: silentId, action }))).rejects.toThrow();
    }
    await expect(notices(await announce({ obligationId, refundEventId, action: "waived" }))).rejects.toThrow();
    await expect(notices(await announce({ obligationId, refundEventId: randomUUID(), action: "created" }))).rejects.toThrow();
    await expect(notices(await announce({ obligationId: other, refundEventId, action: "created" }, other))).rejects.toThrow();
    await expect(notices(await announce({ obligationId: other, refundEventId, action: "created" }))).rejects.toThrow();
    await expect(notices(await f.outbox("refund.event_recorded.v1", "commission_order", obligationId, { obligationId, refundEventId, action: "created" }))).rejects.toThrow();
  });

  test("an overdue refund case also reaches the creator as an action and the buyer as information (P2)", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const obligationId = await f.refundObligation(o);
    const caseId = await f.openCase({ kind: "refund_overdue", sourceType: "commission_refund_obligation", sourceId: obligationId, orderId: o.orderId });
    const opened = await f.outbox("trust.case_opened.v1", "trust_case", caseId, { caseId, orderId: o.orderId, sourceId: obligationId, policyRevisionId: null, correlationId: randomUUID() });
    await expectNotices(opened, [
      { to: owner, kind: "owner_case_opened", variant: "refund_overdue", action: false, category: "owner_queue", link: `/admin/cases/${caseId}`, email: "now" },
      { to: o.creator.userId, kind: "refund_overdue", action: true, category: "disputes_refunds", link: creatorLink(o), email: "now" },
      { to: o.buyer.userId, kind: "refund_overdue", action: false, category: "disputes_refunds", link: buyerLink(o), email: "now" }]);
    // The case names an obligation of another order than its own order_id: refuse instead of guessing.
    const second = await f.refundObligation(o);
    const stray = await f.openCase({ kind: "refund_overdue", sourceType: "commission_refund_obligation", sourceId: second, orderId: (await f.paidOrder()).orderId });
    await expect(notices(await f.outbox("trust.case_opened.v1", "trust_case", stray, { caseId: stray, orderId: null, sourceId: second, policyRevisionId: null, correlationId: randomUUID() }))).rejects.toThrow();
    await expect(notices(await f.outbox("trust.case_opened.v1", "trust_case", caseId, { caseId, orderId: null, sourceId: second, policyRevisionId: null, correlationId: randomUUID() }))).rejects.toThrow();
  });

  test("report receipt and closure reach each reporter only", async () => {
    const o = await f.paidOrder(); const outsider = await f.person();
    const report = await f.reportCase(o, [o.buyer.userId, outsider]);
    await expectNotices(await f.outbox("trust.report_received.v1", "trust_report", report.reportIds[0]!, { reportId: report.reportIds[0], caseId: report.caseId, targetKind: "commission_message" }),
      [{ to: o.buyer.userId, kind: "report_received", action: false, category: "moderation", link: "/help/cases", email: "now" }]);
    await expectNotices(await f.outbox("trust.report_case_closed.v1", "trust_case", report.caseId, { caseId: report.caseId, resolution: "dismissed" }), [
      { to: o.buyer.userId, kind: "report_closed", action: false, category: "moderation", link: "/help/cases", email: "now" },
      { to: outsider, kind: "report_closed", action: false, category: "moderation", link: "/help/cases", email: "now" }]);
  });

  test("a reporter never receives a notice about the reported party", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const report = await f.reportCase(o, [o.buyer.userId]);
    const hideId = await f.hide(o, report, owner);
    const received = await notices(await f.outbox("trust.report_received.v1", "trust_report", report.reportIds[0]!, { reportId: report.reportIds[0], caseId: report.caseId, targetKind: "commission_message" }));
    const hidden = await notices(await f.outbox("trust.content_hidden.v1", "trust_content_hide", hideId, { hideId, caseId: report.caseId, targetKind: "commission_message" }));
    const closed = await notices(await f.outbox("trust.report_case_closed.v1", "trust_case", report.caseId, { caseId: report.caseId, resolution: "actioned" }));
    expect(received.map((row) => row.recipientUserId)).toEqual([o.buyer.userId]);
    expect(closed.map((row) => row.recipientUserId)).toEqual([o.buyer.userId]);
    expect(hidden.map((row) => row.recipientUserId)).toEqual([o.creator.userId]);
    for (const row of [...received, ...closed]) {
      expect(row.linkPath).toBe("/help/cases"); expect(row.variant).toBeNull();
      expect(JSON.stringify(row)).not.toContain(o.creator.userId); expect(JSON.stringify(row)).not.toContain(o.orderId); expect(JSON.stringify(row)).not.toContain(report.messageId);
    }
  });

  test("hides, restores, penalties and appeals reach the affected user", async () => {
    const o = await f.paidOrder(); const owner = await f.owner(); const report = await f.reportCase(o, [o.buyer.userId]); const c = o.creator.userId;
    const hideId = await f.hide(o, report, owner);
    await expectNotices(await f.outbox("trust.content_hidden.v1", "trust_content_hide", hideId, { hideId, caseId: report.caseId, targetKind: "commission_message" }),
      [{ to: c, kind: "content_hidden", action: true, category: "moderation", link: "/help/cases", email: "now" }]);
    const appealed = await f.appeal(c, { hideId });
    await expectNotices(await f.outbox("trust.appeal_submitted.v1", "trust_appeal", appealed.appealId, { appealId: appealed.appealId, caseId: appealed.caseId }),
      [{ to: c, kind: "appeal_received", action: false, category: "moderation", link: "/help/cases", email: "now" }]);
    await f.decideAppeal(appealed.appealId, owner, "reversed");
    await expectNotices(await f.outbox("trust.appeal_decided.v1", "trust_appeal", appealed.appealId, { appealId: appealed.appealId, caseId: appealed.caseId, decision: "reversed" }),
      [{ to: c, kind: "appeal_decided", variant: "reversed", action: true, category: "moderation", link: "/help/cases", email: "now" }]);
    await f.restore(hideId, owner);
    await expectNotices(await f.outbox("trust.content_restored.v1", "trust_content_hide", hideId, { hideId, caseId: report.caseId, targetKind: "commission_message" }),
      [{ to: c, kind: "content_restored", action: false, category: "moderation", link: "/help/cases", email: "now" }]);
    const subject = await f.person();
    for (const kind of ["warning", "restriction"] as const) {
      const penaltyId = await f.penalty(subject, kind, owner);
      await expectNotices(await f.outbox("trust.penalty_applied.v1", "trust_penalty", penaltyId, { penaltyId, subjectUserId: subject, kind }),
        [{ to: subject, kind: "penalty_applied", variant: kind, action: true, category: "moderation", link: "/help/cases", email: "now" }]);
    }
    for (const kind of ["suspension", "removal"] as const) {
      const other = await f.person(); const penaltyId = await f.penalty(other, kind, owner);
      await expectNotices(await f.outbox("trust.penalty_applied.v1", "trust_penalty", penaltyId, { penaltyId, subjectUserId: other, kind }),
        [{ to: other, kind: "penalty_applied", variant: kind, action: false, category: "moderation", link: "/help/cases", email: "never" }]);
    }
    const endedSubject = await f.person(); const ended = await f.penalty(endedSubject, "restriction", owner);
    await expectNotices(await f.outbox("trust.penalty_ended.v1", "trust_penalty", ended, { penaltyId: ended, subjectUserId: endedSubject, state: "lifted" }),
      [{ to: endedSubject, kind: "penalty_ended", action: false, category: "moderation", link: "/help/cases", email: "now" }]);
  });

  test("penalty_applied always carries the penalty kind as its variant", async () => {
    const owner = await f.owner();
    for (const kind of ["warning", "restriction", "suspension", "removal"] as const) {
      const subject = await f.person(); const penaltyId = await f.penalty(subject, kind, owner);
      const rows = await notices(await f.outbox("trust.penalty_applied.v1", "trust_penalty", penaltyId, { penaltyId, subjectUserId: subject, kind }));
      expect(rows.map((row) => row.variant)).toEqual([kind]);
    }
  });

  test("a penalty whose committed kind differs from the event is refused", async () => {
    const owner = await f.owner(); const subject = await f.person(); const penaltyId = await f.penalty(subject, "suspension", owner);
    await expect(notices(await f.outbox("trust.penalty_applied.v1", "trust_penalty", penaltyId, { penaltyId, subjectUserId: subject, kind: "warning" }))).rejects.toThrow();
  });

  test("tip items go to the tip's creator", async () => {
    const creator = await f.person(); const tip = await f.tipIntent(creator); const sourceEventId = randomUUID();
    await expectNotices(await f.outbox("tip.notification_available.v1", "tip_notification", sourceEventId,
      { creatorUserId: creator, paymentIntentId: tip.intentId, state: "created", returnPath: "/creator/tips", sourceEventId }),
    [{ to: creator, kind: "tip_status", variant: "created", action: false, category: "tips", link: "/creator/tips", email: "never" }]);
    await expectNotices(await f.outbox("tip.transfer_claimed.v1", "payment_intent", tip.intentId,
      { paymentIntentId: tip.intentId, tipId: tip.tipId, creatorUserId: creator, authoritative: false, correlationId: randomUUID() }),
    [{ to: creator, kind: "tip_transfer_claimed", action: true, category: "tips", link: "/creator/tips", email: "now" }]);
  });

  test("a tip item naming someone other than the intent's creator is refused", async () => {
    const creator = await f.person(); const other = await f.person(); const tip = await f.tipIntent(creator); const sourceEventId = randomUUID();
    await expect(notices(await f.outbox("tip.notification_available.v1", "tip_notification", sourceEventId,
      { creatorUserId: other, paymentIntentId: tip.intentId, state: "created", returnPath: "/creator/tips", sourceEventId }))).rejects.toThrow();
  });

  test("account events are in-app only and never emailed", async () => {
    const owner = await f.owner(); const applicant = await f.person(); const { applicationId } = await f.application(applicant);
    await expectNotices(await f.outbox("creator.application_outcome_email.v1", "creator_application", applicationId,
      { applicationId, applicantUserId: applicant, revisionId: randomUUID(), state: "approved", decisionAction: "approved", correlationId: randomUUID() }),
    [{ to: applicant, kind: "account_application", variant: "approved", action: false, category: "account", link: "/creator/apply", email: "never" }]);
    const creator = await f.person(); const capabilityId = await f.capability(creator);
    await expectNotices(await f.outbox("creator.capability_outcome_email.v1", "creator_capability", capabilityId, { userId: creator, capabilityId, state: "suspended", correlationId: randomUUID() }),
      [{ to: creator, kind: "account_creator_status", variant: "suspended", action: false, category: "account", link: "/creator", email: "never" }]);
    const depositor = await f.person(); const obligationId = await f.depositObligation(depositor, owner);
    for (const [type, variant] of [["payments.receiving_account_control_verified.v1", "pending_window"], ["payments.verification_deposit_refund_due_soon.v1", "ready"],
      ["payments.verification_deposit_refund_due_today.v1", "due_today"], ["payments.verification_deposit_refund_overdue.v1", "overdue"],
      ["payments.verification_deposit_refund_sent.v1", "sent"], ["payments.verification_deposit_refund_attention_required.v1", "attention_required"]] as const) {
      await expectNotices(await f.outbox(type, "verification_deposit_refund_obligation", obligationId, { obligationId }),
        [{ to: depositor, kind: "account_deposit_refund", variant, action: false, category: "account", link: "/creator/apply", email: "never" }]);
    }
  });

  test("an application event naming another user is refused", async () => {
    const applicant = await f.person(); const other = await f.person(); const { applicationId } = await f.application(applicant);
    await expect(notices(await f.outbox("creator.application_outcome_email.v1", "creator_application", applicationId,
      { applicationId, applicantUserId: other, revisionId: randomUUID(), state: "approved", decisionAction: "approved", correlationId: randomUUID() }))).rejects.toThrow();
  });

  test("a missing source row is refused instead of guessing a recipient", async () => {
    const orderId = randomUUID(); const proposalId = randomUUID();
    await expect(notices(await f.outbox("commission.requested.v1", "commission_order", orderId, { orderId, version: 1, state: "requested", reason: null, correlationId: randomUUID() }))).rejects.toThrow();
    await expect(notices(await f.outbox("resolution.proposal_made.v1", "commission_proposal", proposalId, { proposalId, orderId, kind: "cancel_with_refund" }))).rejects.toThrow();
  });
});
