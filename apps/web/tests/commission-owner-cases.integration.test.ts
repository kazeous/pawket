import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { calculateStoredBusinessDayDeadline } from "@pawket/database";
import { createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import * as resolution from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionResolutionTestFixture, resolutions, service } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8owner");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const DAY = 86_400_000; const calendarVersion = "vn-proposals-test";
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const refunds = (p: Paid) => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, p.orderId));
const allAudits = (requestId: string) => f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, requestId));
// Orders owns a separate transition audit. Count the owner command's audit independently.
const audit = (requestId: string) => allAudits(requestId).then((rows) => rows.filter((row) => row.action.startsWith("owner.case_")));
const orderPort = () => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
const refundPort = (p: Paid) => createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion });
function kit(p: Paid, consumeStepUpProof?: Parameters<typeof resolution.createResolutionCommandKit>[0]["consumeStepUpProof"]) {
  return resolution.createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, consumeStepUpProof });
}
function partyRefunds(p: Paid) {
  return createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion, mode: "enabled",
    recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases: createTrustCasePort(),
    assurance: { getTipSessionAssurance: async (_tx, actor, at) => p.s.users.get(actor.userId) === actor.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
}
function view(p: Paid) {
  return resolution.createResolutionViewService({ db: f.db, keyring: p.s.input.keyring, orders: { ...orderPort(), listOrders: service(p).listOrders },
    refunds: partyRefunds(p), session: p.s.input.identity, now: p.s.creator.now });
}
async function setup(delivered = true, responded = true) {
  const p = delivered ? await f.deliveredOrder() : await f.paidOrder();
  if (!delivered) p.s.creator.setNow(new Date((await order(p)).dueAt!.getTime() + 7 * DAY));
  const disputes = resolution.createDisputeService(kit(p), { orders: orderPort(), refunds: refundPort(p), cases: createTrustCasePort(), mode: "enabled" });
  const opened = await disputes.openDispute({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version,
    reason: "not_as_agreed", statement: "Synthetic opening", requestedOutcome: { kind: "close", refundAmountVnd: 200_000 },
    acknowledgeStaffReview: true, ...commandIds() });
  if (responded) await disputes.addStatement({ actor: p.creator, disputeId: opened.disputeId, text: "Synthetic response", ...commandIds() });
  const owner = await p.s.buyer();
  const consume = vi.fn<NonNullable<Parameters<typeof resolution.createResolutionCommandKit>[0]["consumeStepUpProof"]>>(async (_tx, command) => command.userId === owner.userId && command.sessionId === owner.sessionId);
  const ports = { orders: orderPort(), refunds: refundPort(p), payments: createCommissionPaymentFactsPort(), cases: createTrustCasePort(), mode: "enabled" as const, applicationRevision: "synthetic-i8" };
  const instance = resolution.createOwnerResolutionService(kit(p, consume), ports);
  return { p, owner, consume, ports, instance, ...opened };
}
type Context = Awaited<ReturnType<typeof setup>>;
const base = (c: Context) => ({ owner: c.owner, stepUpProofId: randomUUID(), ...commandIds() });
const ruling = (c: Context, outcome: "complete" | "close" = "complete", refundAmountVnd = 200_000) => ({ ...base(c), disputeId: c.disputeId,
  outcome, refundAmountVnd, reasoning: "Synthetic public reasoning", internalNote: "Synthetic private owner note" });
const correction = (c: Context, rulingId: string, newRefundAmountVnd: number) => ({ ...base(c), rulingId, newRefundAmountVnd, reason: "Synthetic correction reason" });
async function audited(c: Context, command: { requestId: string }, action: string, subjectType: string, subjectId: string) {
  const rows = await audit(command.requestId); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId, subjectType, subjectId, action,
    outcome: "succeeded", assurance: { method: "owner_step_up" }, applicationRevision: "synthetic-i8", occurredAt: c.p.s.creator.now() });
  expect(rows[0]!.beforeState).not.toBeNull(); expect(rows[0]!.afterState).not.toBeNull();
  expect(c.consume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...c.owner, actionClass: action }));
  for (const text of ["Synthetic public reasoning", "Synthetic private owner note", "Synthetic correction reason", "Synthetic owner question", "Synthetic deadline reason", "Synthetic refund reason"])
    expect(JSON.stringify(rows).includes(text)).toBe(false);
}
async function disputeRow(c: Context) {
  return (await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, c.disputeId)))[0]!;
}
async function caseRow(caseId: string) {
  return (await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, caseId)))[0]!;
}
async function destination(c: Context, obligationId: string) {
  const [row] = await refunds(c.p); expect(row!.id).toBe(obligationId);
  await partyRefunds(c.p).enterDestination({ actor: c.p.buyer, obligationId, expectedVersion: row!.version,
    bankBin: "970422", accountNumber: "000000123456", accountHolder: "SYNTHETIC BUYER", ...commandIds() });
}
async function send(c: Context, obligationId: string) {
  const [row] = await refunds(c.p);
  await partyRefunds(c.p).recordSend({ actor: c.p.creator, obligationId, expectedVersion: row!.version,
    transferDate: c.p.s.creator.now().toISOString().slice(0, 10), bankReference: "SYNTHETIC_REF", ...commandIds() });
}
async function refundCase(kind: "refund_not_received" | "refund_overdue") {
  const c = await setup(); await c.instance.rule(ruling(c)); const obligationId = (await refunds(c.p))[0]!.id;
  await destination(c, obligationId);
  if (kind === "refund_not_received") {
    await send(c, obligationId); const [row] = await refunds(c.p);
    await partyRefunds(c.p).confirmReceipt({ actor: c.p.buyer, obligationId, expectedVersion: row!.version, received: false, ...commandIds() });
  } else {
    const [row] = await refunds(c.p); c.p.s.creator.setNow(new Date(row!.dueAt!.getTime() + 1));
    await f.db.transaction((tx) => c.ports.cases.openCase(tx, { kind, orderId: c.p.orderId, sourceType: "commission_refund_obligation",
      sourceId: obligationId, policyRevisionId: c.p.s.policyId, requestId: randomUUID(), at: c.p.s.creator.now() }));
  }
  const opened = await f.db.transaction((tx) => c.ports.cases.findOpenCase(tx, { kind, sourceId: obligationId }));
  return { ...c, refundCaseId: opened!.caseId, obligationId };
}

describe("commission owner case commands", () => {
  test("complete with 200,000 completes the slot, supersedes a proposal and rules the case atomically; replay writes nothing", async () => {
    const c = await setup(); const proposals = resolutions(c.p);
    const made = await proposals.propose({ actor: c.p.creator, orderId: c.p.orderId, expectedVersion: (await order(c.p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 100_000, note: "Synthetic proposal", ...commandIds() });
    const command = ruling(c); const result = await c.instance.rule(command);
    c.consume.mockResolvedValue(false); expect(await c.instance.rule(command)).toEqual(result); expect(c.consume).toHaveBeenCalledTimes(1);
    expect(await order(c.p)).toMatchObject({ state: "completed", completionKind: "ruling", completionFloorAt: null });
    expect(await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, c.p.orderId))).toMatchObject([{ state: "completed" }]);
    expect(await refunds(c.p)).toMatchObject([{ source: "ruling", sourceId: result.rulingId, amountVnd: 200_000, state: "awaiting_destination" }]);
    expect(await disputeRow(c)).toMatchObject({ state: "ruled", version: 2 });
    expect(await caseRow(c.caseId)).toMatchObject({ state: "resolved", resolutionKind: "ruled" });
    expect(await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, made.proposalId)))
      .toMatchObject([{ state: "superseded", endedByUserId: c.owner.userId }]);
    const records = await f.db.select().from(schema.commissionRulings).where(eq(schema.commissionRulings.id, result.rulingId));
    expect(records).toMatchObject([{ policyRevisionId: c.p.s.policyId, ownerUserId: c.owner.userId, stepUpProofId: command.stepUpProofId }]);
    for (const text of [command.reasoning, command.internalNote]) expect(JSON.stringify(records).includes(text)).toBe(false);
    const outbox = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.rulingId));
    expect(outbox.map((event) => event.payload)).toEqual([{ rulingId: result.rulingId, disputeId: c.disputeId, orderId: c.p.orderId, outcome: "complete" }]);
    await audited(c, command, "owner.case_rule", "commission_dispute", c.disputeId);
    expect((await allAudits(command.requestId)).filter((row) => row.action === "commission.completed")).toHaveLength(1);
    for (const actor of [c.p.buyer, c.p.creator]) {
      const projected = await view(c.p).getOrderResolution({ actor, orderId: c.p.orderId });
      expect(projected.dispute?.ruling?.reasoning === command.reasoning).toBe(true);
      expect(JSON.stringify(projected).includes(command.internalNote)).toBe(false);
    }
  });
  test("complete on in_progress is invalid_transition and writes no ruling or audit", async () => {
    const c = await setup(false); const command = ruling(c); const before = await order(c.p);
    await expect(c.instance.rule(command)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(await order(c.p)).toEqual(before); expect(await refunds(c.p)).toHaveLength(0); expect(await audit(command.requestId)).toHaveLength(0);
    expect(await disputeRow(c)).toMatchObject({ state: "open" }); expect(await caseRow(c.caseId)).toMatchObject({ state: "open" });
  });
  test("close with the full amount cancels the slot and closes the paid order", async () => {
    const c = await setup(false); const command = ruling(c, "close", 500_000); await c.instance.rule(command);
    expect(await order(c.p)).toMatchObject({ state: "closed", closeReason: "cancelled_by_ruling" });
    expect(await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, c.p.orderId))).toMatchObject([{ state: "cancelled" }]);
    expect(await refunds(c.p)).toMatchObject([{ amountVnd: 500_000 }]); await audited(c, command, "owner.case_rule", "commission_dispute", c.disputeId);
  });
  test("zero refund creates no obligation; complete rejects the full amount", async () => {
    const c = await setup(); const invalid = ruling(c, "complete", 500_000);
    await expect(c.instance.rule(invalid)).rejects.toMatchObject({ code: "invalid_request" }); expect(await audit(invalid.requestId)).toHaveLength(0);
    await c.instance.rule(ruling(c, "complete", 0)); expect(await refunds(c.p)).toHaveLength(0);
  });
  test("ruling waits for a response or the effective response deadline", async () => {
    const c = await setup(true, false); const command = ruling(c);
    await expect(c.instance.rule(command)).rejects.toMatchObject({ code: "invalid_transition" }); expect(await audit(command.requestId)).toHaveLength(0);
    c.p.s.creator.setNow((await disputeRow(c)).respondBy); await c.instance.rule(command);
  });
  test("a missing consumable step-up proof changes nothing", async () => {
    const c = await setup(); c.consume.mockResolvedValue(false); const command = ruling(c); const before = await order(c.p);
    await expect(c.instance.rule(command)).rejects.toMatchObject({ code: "owner_step_up_required" });
    expect(await order(c.p)).toEqual(before); expect(await refunds(c.p)).toHaveLength(0); expect(await audit(command.requestId)).toHaveLength(0);
    expect(await f.db.select().from(schema.commissionRulings).where(eq(schema.commissionRulings.disputeId, c.disputeId))).toHaveLength(0);
    expect(await disputeRow(c)).toMatchObject({ state: "open" }); expect(await caseRow(c.caseId)).toMatchObject({ state: "open" });
  });
  test.each(["correct", "question", "extend", "accept_evidence", "require_resend", "waive", "extend_deadline"] as const)("%s requires a proof and rolls back every audit on rejection", async (action) => {
    const refundAction = ["accept_evidence", "require_resend", "waive", "extend_deadline"].includes(action);
    const c = refundAction ? await refundCase(action === "extend_deadline" ? "refund_overdue" : "refund_not_received") : await setup();
    const rulingId = action === "correct" ? (await c.instance.rule(ruling(c))).rulingId : undefined;
    const command = base(c); const beforeOrder = await order(c.p); const beforeRefunds = await refunds(c.p); const beforeDispute = await disputeRow(c);
    c.consume.mockResolvedValue(false);
    const run = action === "correct" ? c.instance.correctRuling({ ...command, rulingId: rulingId!, newRefundAmountVnd: 100_000, reason: "Synthetic correction reason" })
      : action === "question" ? c.instance.postQuestion({ ...command, disputeId: c.disputeId, text: "Synthetic owner question" })
      : action === "extend" ? c.instance.extendDispute({ ...command, disputeId: c.disputeId, until: new Date(beforeDispute.openedAt.getTime() + 14 * DAY), reason: "Synthetic deadline reason" })
      : c.instance.resolveRefundCase({ ...command, caseId: (c as Awaited<ReturnType<typeof refundCase>>).refundCaseId,
        action: action as "accept_evidence" | "require_resend" | "waive" | "extend_deadline",
        ...(action === "extend_deadline" ? { until: new Date(c.p.s.creator.now().getTime() + DAY) } : {}), reason: "Synthetic refund reason" });
    await expect(run).rejects.toMatchObject({ code: "owner_step_up_required" });
    expect(await order(c.p)).toEqual(beforeOrder); expect(await refunds(c.p)).toEqual(beforeRefunds); expect(await disputeRow(c)).toEqual(beforeDispute);
    expect(await allAudits(command.requestId)).toHaveLength(0);
  });
  test("owner question is encrypted, visible to both parties, replayable and audited once", async () => {
    const c = await setup(); const command = { ...base(c), disputeId: c.disputeId, text: "Synthetic owner question" };
    await c.instance.postQuestion(command); await c.instance.postQuestion(command);
    const rows = await f.db.select().from(schema.commissionDisputeStatements).where(and(eq(schema.commissionDisputeStatements.disputeId, c.disputeId), eq(schema.commissionDisputeStatements.authorRole, "owner")));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: "question", authorUserId: c.owner.userId });
    expect(JSON.stringify(rows).includes(command.text)).toBe(false);
    for (const actor of [c.p.buyer, c.p.creator]) expect((await view(c.p).getOrderResolution({ actor, orderId: c.p.orderId })).dispute?.statements.some((row) => row.authorRole === "owner" && row.text === command.text)).toBe(true);
    expect(await caseRow(c.caseId)).toMatchObject({ state: "open", version: 2 });
    await audited(c, command, "owner.case_question", "commission_dispute", c.disputeId);
  });
  test("dispute extension permits openedAt + 14 days, rejects one millisecond beyond and does not repeat its audit", async () => {
    const c = await setup(); const before = await disputeRow(c); const limit = new Date(before.openedAt.getTime() + 14 * DAY);
    const command = { ...base(c), disputeId: c.disputeId, until: limit, reason: "Synthetic deadline reason" };
    const invalid = { ...command, ...commandIds(), until: new Date(limit.getTime() + 1) };
    await expect(c.instance.extendDispute(invalid)).rejects.toMatchObject({ code: "invalid_request" }); expect(await audit(invalid.requestId)).toHaveLength(0);
    await c.instance.extendDispute(command); await c.instance.extendDispute(command);
    expect(await disputeRow(c)).toMatchObject({ respondBy: limit, version: 2 });
    expect(await caseRow(c.caseId)).toMatchObject({ state: "open", version: 2 }); await audited(c, command, "owner.case_extend", "commission_dispute", c.disputeId);
  });
  test.each(["increase", "reduce", "sent", "zero"] as const)("correction %s uses Payments and preserves the terminal order", async (kind) => {
    const c = await setup(); const { rulingId } = await c.instance.rule(ruling(c)); const before = await order(c.p); const obligationId = (await refunds(c.p))[0]!.id;
    if (kind === "sent") { await destination(c, obligationId); await send(c, obligationId); }
    c.p.s.creator.advance(1);
    const amount = kind === "increase" ? 300_000 : kind === "zero" ? 0 : 100_000;
    const expected = kind === "increase" ? "increased" : kind === "zero" ? "waived" : kind === "sent" ? "recorded_only" : "reduced";
    const command = correction(c, rulingId, amount); const result = await c.instance.correctRuling(command);
    expect(result.effect).toBe(expected); expect(await c.instance.correctRuling(command)).toEqual(result); expect(await order(c.p)).toEqual(before);
    const rows = await refunds(c.p);
    if (kind === "increase") expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ source: "correction", sourceId: result.correctionId, amountVnd: 100_000 })]));
    else expect(rows).toMatchObject([{ amountVnd: kind === "reduce" ? 100_000 : 200_000, state: kind === "zero" ? "waived" : kind === "sent" ? "sent" : "awaiting_destination" }]);
    const records = await f.db.select().from(schema.commissionRulingCorrections).where(eq(schema.commissionRulingCorrections.rulingId, rulingId));
    expect(records).toMatchObject([{ id: result.correctionId, effect: expected, refundAmountVnd: amount }]); expect(JSON.stringify(records).includes(command.reason)).toBe(false);
    const outbox = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, result.correctionId));
    expect(outbox.map((row) => row.payload)).toEqual([{ correctionId: result.correctionId, rulingId, effect: expected }]);
    await audited(c, command, "owner.case_correct", "commission_ruling", rulingId);
  });
  test("correction is allowed at 30 days, rejected afterwards and replay still succeeds", async () => {
    const c = await setup(); const { rulingId } = await c.instance.rule(ruling(c)); const ruledAt = c.p.s.creator.now();
    c.p.s.creator.setNow(new Date(ruledAt.getTime() + 30 * DAY)); const command = correction(c, rulingId, 100_000);
    const recorded = await c.instance.correctRuling(command); c.p.s.creator.advance(1);
    const late = correction(c, rulingId, 0); await expect(c.instance.correctRuling(late)).rejects.toMatchObject({ code: "deadline_passed" });
    expect(await audit(late.requestId)).toHaveLength(0); expect(await c.instance.correctRuling(command)).toEqual(recorded);
  });
  test.each(["accept_evidence", "require_resend", "waive", "extend_deadline"] as const)("refund case %s resolves with the matching kind and one audit", async (action) => {
    const c = await refundCase(action === "extend_deadline" ? "refund_overdue" : "refund_not_received");
    const until = action === "extend_deadline" ? new Date(c.p.s.creator.now().getTime() + 30 * DAY) : undefined;
    const command = { ...base(c), caseId: c.refundCaseId, action, ...(until ? { until } : {}), reason: "Synthetic refund reason" };
    const before = (await refunds(c.p))[0]!; await c.instance.resolveRefundCase(command); await c.instance.resolveRefundCase(command);
    const expected = { accept_evidence: "receipt_accepted", require_resend: "resend_required", waive: "waived", extend_deadline: "extended" }[action];
    expect(await caseRow(c.refundCaseId)).toMatchObject({ state: "resolved", resolutionKind: expected, version: 2 });
    const after = (await refunds(c.p))[0]!;
    expect(after.state).toBe({ accept_evidence: "received", require_resend: "awaiting_send", waive: "waived", extend_deadline: "awaiting_send" }[action]);
    if (action === "require_resend") {
      const due = await f.db.transaction((tx) => calculateStoredBusinessDayDeadline(tx, { from: c.p.s.creator.now(), businessDays: 5, calendarVersion }));
      expect(after).toMatchObject({ dueAt: due, currentSendId: null, confirmBy: null });
      expect(await f.db.select().from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, c.obligationId))).toHaveLength(1);
    } else if (until) expect(after.dueAt).toEqual(until);
    else expect(after.amountVnd).toBe(before.amountVnd);
    await audited(c, command, `owner.case_${action}`, "trust_case", c.refundCaseId);
  });
  test("refund deadline beyond 30 days fails and leaves the case and obligation untouched", async () => {
    const c = await refundCase("refund_overdue"); const before = await refunds(c.p);
    const command = { ...base(c), caseId: c.refundCaseId, action: "extend_deadline" as const,
      until: new Date(c.p.s.creator.now().getTime() + 30 * DAY + 1), reason: "Synthetic refund reason" };
    await expect(c.instance.resolveRefundCase(command)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await refunds(c.p)).toEqual(before); expect(await caseRow(c.refundCaseId)).toMatchObject({ state: "open" }); expect(await audit(command.requestId)).toHaveLength(0);
  });
  test("refund actions reject a dispute target and mismatched refund action", async () => {
    const c = await setup(); const wrong = { ...base(c), caseId: c.caseId, action: "waive" as const, reason: "Synthetic refund reason" };
    await expect(c.instance.resolveRefundCase(wrong)).rejects.toMatchObject({ code: "not_available" }); expect(await audit(wrong.requestId)).toHaveLength(0);
    const r = await refundCase("refund_overdue"); const invalid = { ...base(r), caseId: r.refundCaseId, action: "accept_evidence" as const, reason: "Synthetic refund reason" };
    await expect(r.instance.resolveRefundCase(invalid)).rejects.toMatchObject({ code: "invalid_transition" }); expect(await audit(invalid.requestId)).toHaveLength(0);
  });
  test("idempotency payload includes target id and owner session is checked on replay", async () => {
    const c = await setup(); const command = ruling(c); await c.instance.rule(command);
    const other = await setup(); c.p.s.users.set(c.owner.userId, c.owner.sessionId);
    await expect(c.instance.rule({ ...command, disputeId: other.disputeId })).rejects.toMatchObject({ code: "idempotency_conflict" });
    c.p.s.users.delete(c.owner.userId); await expect(c.instance.rule(command)).rejects.toMatchObject({ code: "not_authorized" }); expect(await audit(command.requestId)).toHaveLength(1);
  });
  test("dependency failure rolls back ruling, order, refund, case, outbox and audit", async () => {
    const c = await setup(); const before = await order(c.p); const command = ruling(c);
    vi.spyOn(c.ports.cases, "resolveCase").mockRejectedValue(new Error("Synthetic dependency failure"));
    await expect(c.instance.rule(command)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await order(c.p)).toEqual(before); expect(await refunds(c.p)).toHaveLength(0); expect(await disputeRow(c)).toMatchObject({ state: "open" });
    expect(await caseRow(c.caseId)).toMatchObject({ state: "open" }); expect(await audit(command.requestId)).toHaveLength(0);
    expect(await f.db.select().from(schema.commissionRulings).where(eq(schema.commissionRulings.disputeId, c.disputeId))).toHaveLength(0);
    expect(await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, c.p.orderId), eq(schema.systemOutbox.eventType, "commission.completed.v1")))).toHaveLength(0);
  });
  test("ruling racing proposal acceptance commits exactly one outcome; loser writes nothing", async () => {
    const c = await setup(); const proposals = resolutions(c.p);
    const made = await proposals.propose({ actor: c.p.creator, orderId: c.p.orderId, expectedVersion: (await order(c.p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 200_000, note: "Synthetic proposal", ...commandIds() });
    const command = ruling(c); const results = await Promise.allSettled([c.instance.rule(command),
      proposals.respondToProposal({ actor: c.p.buyer, proposalId: made.proposalId, response: "accept", ...commandIds() })]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((row) => row.status === "rejected") as PromiseRejectedResult; expect(["version_conflict", "invalid_transition"]).toContain(loser.reason.code);
    const ruled = results[0]!.status === "fulfilled";
    expect(await refunds(c.p)).toHaveLength(1); expect((await refunds(c.p))[0]!.source).toBe(ruled ? "ruling" : "agreement");
    expect((await disputeRow(c)).state).toBe(ruled ? "ruled" : "settled"); expect(await audit(command.requestId)).toHaveLength(ruled ? 1 : 0);
    expect(await f.db.select().from(schema.commissionRulings).where(eq(schema.commissionRulings.disputeId, c.disputeId))).toHaveLength(ruled ? 1 : 0);
    expect(await f.db.select().from(schema.commissionEvents).where(and(eq(schema.commissionEvents.orderId, c.p.orderId), inArray(schema.commissionEvents.type, ["closed", "completed"])))).toHaveLength(1);
  });
});
