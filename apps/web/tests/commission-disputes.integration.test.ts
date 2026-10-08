import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionThreadService } from "@pawket/commission-files";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import { createDisputeService, createResolutionCommandKit, createResolutionViewService, RESOLUTION_POLICY } from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionResolutionTestFixture, resolutions, respond, service, submit, submitCommand } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8disputes");
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
const HOUR = 3_600_000; const DAY = 24 * HOUR;
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const disputes = (p: Paid) => f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.orderId, p.orderId));
const statements = (disputeId: string) => f.db.select().from(schema.commissionDisputeStatements).where(eq(schema.commissionDisputeStatements.disputeId, disputeId));
const cases = (p: Paid) => f.db.select().from(schema.trustCases).where(eq(schema.trustCases.orderId, p.orderId));
const orderPort = () => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID });
function disputeService(p: Paid, options: Partial<Parameters<typeof createDisputeService>[1]> = {}, kitOptions: Partial<Parameters<typeof createResolutionCommandKit>[0]> = {}) {
  return createDisputeService(createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, ...kitOptions }), {
    orders: orderPort(), refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" }),
    cases: createTrustCasePort(), mode: "enabled", ...options,
  });
}
async function opening(p: Paid, actor = p.buyer) {
  return { actor, orderId: p.orderId, expectedVersion: (await order(p)).version, reason: "not_as_agreed" as const,
    statement: "Synthetic opening statement", requestedOutcome: { kind: "close" as const, refundAmountVnd: 250_000 },
    acknowledgeStaffReview: true as const, ...commandIds() };
}
const statement = (p: Paid, disputeId: string, actor = p.creator) => ({ actor, disputeId, text: "Synthetic party statement", ...commandIds() });
const withdrawal = (p: Paid, disputeId: string, actor = p.buyer) => ({ actor, disputeId, ...commandIds() });
async function endedProposal(p: Paid, actor = p.creator, ending: "declined" | "expired" | "withdrawn" | "lapsed" = "declined") {
  const instance = resolutions(p); const made = await instance.propose({ actor, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind: "cancel_with_refund", refundAmountVnd: 0, note: "Synthetic proposal", ...commandIds() });
  p.s.creator.advance(HOUR);
  if (ending === "declined") await instance.respondToProposal({ actor: actor.userId === p.creator.userId ? p.buyer : p.creator,
    proposalId: made.proposalId, response: "decline", ...commandIds() });
  else {
    const [proposal] = await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, made.proposalId));
    if (ending === "expired") p.s.creator.setNow(proposal!.respondBy);
    await f.db.transaction((tx) => instance.endProposalWithoutAgreement(tx, proposal!, ending, p.s.creator.now(), null, randomUUID()));
  }
  return { ...made, endedAt: p.s.creator.now() };
}
async function deliveredProposalTrigger(role: "buyer" | "creator") {
  const p = await f.deliveredOrder();
  if (role === "buyer") {
    const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    p.s.creator.advance(1); await instance.withdrawDispute(withdrawal(p, opened.disputeId));
  }
  p.s.creator.advance(1); const ended = await endedProposal(p);
  const due = await f.db.transaction((tx) => orderPort().completionDueAt(tx, p.orderId));
  return { p, ended, due: due! };
}
function refundService(p: Paid) {
  return createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion: "vn-proposals-test",
    mode: "enabled", recentAuthMs: HOUR, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases: createTrustCasePort(),
    assurance: { getTipSessionAssurance: async (_tx, actor, at) => p.s.users.get(actor.userId) === actor.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
}
const viewService = (p: Paid, refunds = refundService(p)) => createResolutionViewService({ db: f.db, keyring: p.s.input.keyring,
  orders: { ...orderPort(), listOrders: service(p).listOrders }, refunds, session: p.s.input.identity, now: p.s.creator.now });

describe("commission disputes and completion holds", () => {
  test("buyer final-delivery trigger opens at completionDueAt - 1 ms and fails at the deadline", async () => {
    const p = await f.deliveredOrder(); const due = await f.db.transaction((tx) => orderPort().completionDueAt(tx, p.orderId));
    p.s.creator.setNow(due!);
    await expect(disputeService(p).openDispute(await opening(p))).rejects.toMatchObject({ code: "deadline_passed" });
    p.s.creator.setNow(new Date(due!.getTime() - 1));
    await disputeService(p).openDispute(await opening(p));
    expect(await disputes(p)).toMatchObject([{ trigger: "final_delivery", triggerAt: (await order(p)).deliveredAt, remainingReviewMs: 1 }]);
  });
  test.each(["buyer", "creator"] as const)("%s delivered proposal trigger refuses opening at completionDueAt and allows one millisecond before", async (role) => {
    const { p, ended, due } = await deliveredProposalTrigger(role); const before = await order(p);
    expect(due.getTime()).toBeLessThan(ended.endedAt.getTime() + RESOLUTION_POLICY.proposalTriggerWindowMs);
    p.s.creator.setNow(due);
    await expect(disputeService(p).openDispute(await opening(p, p[role]))).rejects.toMatchObject({ code: "deadline_passed" });
    expect((await disputes(p)).filter((row) => row.state === "open")).toHaveLength(0); expect(await order(p)).toEqual(before);
    p.s.creator.setNow(new Date(due.getTime() - 1));
    const opened = await disputeService(p).openDispute(await opening(p, p[role]));
    expect((await disputes(p)).find((row) => row.id === opened.disputeId)).toMatchObject({ trigger: "proposal_declined", remainingReviewMs: 1 });
  });
  test.each(["buyer", "creator"] as const)("%s delivered proposal view bounds its trigger by completionDueAt", async (role) => {
    const { p, due } = await deliveredProposalTrigger(role); p.s.creator.setNow(due);
    expect((await viewService(p).getOrderResolution({ actor: p[role], orderId: p.orderId })).actions)
      .toMatchObject({ canOpenDispute: false, disputeTrigger: null, disputeTriggerEndsAt: null });
    p.s.creator.setNow(new Date(due.getTime() - 1));
    expect((await viewService(p).getOrderResolution({ actor: p[role], orderId: p.orderId })).actions)
      .toMatchObject({ canOpenDispute: true, disputeTrigger: "proposal_declined", disputeTriggerEndsAt: due.toISOString() });
  });
  test.each(["buyer", "creator"] as const)("%s delivered opening and view require a non-null completion deadline", async (role) => {
    const p = await f.deliveredOrder(); if (role === "creator") await endedProposal(p);
    const pauseId = randomUUID(); const startedAt = p.s.creator.now();
    await f.db.insert(schema.commissionFulfillmentPauses).values({ id: pauseId, startedAt });
    try {
      expect(await f.db.transaction((tx) => orderPort().completionDueAt(tx, p.orderId))).toBeNull();
      await expect(disputeService(p).openDispute(await opening(p, p[role]))).rejects.toMatchObject({ code: "resolution_disabled" });
      expect((await viewService(p).getOrderResolution({ actor: p[role], orderId: p.orderId })).actions.canOpenDispute).toBe(false);
      expect(await disputes(p)).toHaveLength(0); expect(await cases(p)).toHaveLength(0);
    } finally {
      await f.db.update(schema.commissionFulfillmentPauses).set({ endedAt: new Date(startedAt.getTime() + 1) })
        .where(eq(schema.commissionFulfillmentPauses.id, pauseId));
    }
  });
  test("delivered proposal-trigger opening rolls back when its commit reaches completionDueAt", async () => {
    const { p, due } = await deliveredProposalTrigger("creator"); const before = await order(p);
    p.s.creator.setNow(new Date(due.getTime() - 1));
    const casesPort = createTrustCasePort(); const openCase = casesPort.openCase;
    vi.spyOn(casesPort, "openCase").mockImplementation(async (tx, command) => {
      const result = await openCase(tx, command); p.s.creator.advance(1); return result;
    });
    await expect(disputeService(p, { cases: casesPort }).openDispute(await opening(p, p.creator))).rejects.toMatchObject({ code: "deadline_passed" });
    expect(await disputes(p)).toHaveLength(0); expect(await cases(p)).toHaveLength(0); expect(await order(p)).toEqual(before);
  });
  test("buyer overdue trigger opens at dueAt + 7 days and fails one millisecond before", async () => {
    const p = await f.paidOrder(); const at = new Date((await order(p)).dueAt!.getTime() + 7 * DAY);
    p.s.creator.setNow(new Date(at.getTime() - 1));
    await expect(disputeService(p).openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_not_allowed" });
    p.s.creator.setNow(at); await disputeService(p).openDispute(await opening(p));
    expect(await disputes(p)).toMatchObject([{ trigger: "overdue", triggerAt: at }]);
  });
  test.each(["buyer", "creator"] as const)("%s proposal trigger opens at endedAt + 7 days and fails one millisecond after", async (role) => {
    const p = await f.paidOrder(); const ended = await endedProposal(p); const at = new Date(ended.endedAt.getTime() + 7 * DAY);
    p.s.creator.setNow(new Date(at.getTime() + 1));
    await expect(disputeService(p).openDispute(await opening(p, p[role]))).rejects.toMatchObject({ code: "dispute_not_allowed" });
    p.s.creator.setNow(at); await disputeService(p).openDispute(await opening(p, p[role]));
    expect(await disputes(p)).toMatchObject([{ trigger: "proposal_declined", triggerAt: ended.endedAt }]);
  });
  test("buyer may use another party's expired proposal; creator may use only their own", async () => {
    const p = await f.paidOrder(); const ended = await endedProposal(p, p.buyer, "expired");
    await expect(disputeService(p).openDispute(await opening(p, p.creator))).rejects.toMatchObject({ code: "dispute_not_allowed" });
    await disputeService(p).openDispute(await opening(p));
    expect(await disputes(p)).toMatchObject([{ trigger: "proposal_declined", triggerAt: ended.endedAt }]);
  });
  test.each(["withdrawn", "lapsed"] as const)("a %s proposal does not arm the proposal trigger", async (ending) => {
    const p = await f.paidOrder(); await endedProposal(p, p.creator, ending);
    await expect(disputeService(p).openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_not_allowed" });
  });
  test("opening requires explicit staff-review acknowledgement", async () => {
    const p = await f.deliveredOrder(); const command = await opening(p);
    await expect(disputeService(p).openDispute({ ...command, acknowledgeStaffReview: false } as unknown as typeof command)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await disputes(p)).toHaveLength(0); expect(await cases(p)).toHaveLength(0);
  });
  test("opening creates one encrypted opening, case with locked policy and safe outbox; replay returns both ids", async () => {
    const p = await f.deliveredOrder(); const command = await opening(p); const instance = disputeService(p); const before = await order(p);
    const opened = await instance.openDispute(command); expect(await instance.openDispute(command)).toEqual(opened);
    expect(await cases(p)).toMatchObject([{ id: opened.caseId, sourceId: opened.disputeId, kind: "dispute", policyRevisionId: p.s.policyId, state: "open" }]);
    expect(await statements(opened.disputeId)).toMatchObject([{ authorRole: "buyer", kind: "opening", requestedOutcome: "close", requestedRefundVnd: 250_000 }]);
    expect(await order(p)).toEqual(before);
    const events = await f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, opened.disputeId));
    expect(events.map((event) => event.payload)).toEqual([{ disputeId: opened.disputeId, orderId: p.orderId }]);
    expect(JSON.stringify(await statements(opened.disputeId)).includes(command.statement)).toBe(false);
    expect(JSON.stringify(events).includes(command.statement)).toBe(false);
    await expect(instance.openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_open" });
  });
  test("while open, submissions and changes fail dispute_open, acceptance fails completion_held and messages send", async () => {
    const p = await f.deliveredOrder(); await disputeService(p).openDispute(await opening(p));
    await expect(service(p).submit(await submitCommand(p))).rejects.toMatchObject({ code: "dispute_open" });
    await expect(respond(p, p.finalId, "request_changes")).rejects.toMatchObject({ code: "dispute_open" });
    await expect(respond(p, p.finalId, "accept")).rejects.toMatchObject({ code: "completion_held" });
    const messages = createCommissionThreadService({ ...p.s.input, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
      orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
    await expect(messages.sendMessage({ actor: p.buyer, orderId: p.orderId, text: "Synthetic thread message", fileIds: [], ...commandIds() }))
      .resolves.toMatchObject({ messageId: expect.any(String) });
  });
  test("open dispute is reported before an elapsed review deadline for change requests", async () => {
    const p = await f.deliveredOrder(); await disputeService(p).openDispute(await opening(p));
    p.s.creator.setNow((await order(p)).reviewEndsAt!);
    await expect(respond(p, p.finalId, "request_changes")).rejects.toMatchObject({ code: "dispute_open" });
  });
  test("in-progress submissions are blocked by the real dispute port", async () => {
    const p = await f.paidOrder(); await endedProposal(p); await disputeService(p).openDispute(await opening(p));
    await expect(service(p).submit(await submitCommand(p, "final"))).rejects.toMatchObject({ code: "dispute_open" });
  });
  test("first respondent statement is response, later ones statement; each party's eleventh fails statement_limit", async () => {
    const p = await f.deliveredOrder(); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    const command = statement(p, opened.disputeId); const added = await instance.addStatement(command);
    expect(await instance.addStatement(command)).toEqual(added);
    for (let i = 1; i < 10; i++) await instance.addStatement(statement(p, opened.disputeId));
    for (let i = 1; i < 10; i++) await instance.addStatement(statement(p, opened.disputeId, p.buyer));
    for (const actor of [p.buyer, p.creator]) await expect(instance.addStatement(statement(p, opened.disputeId, actor))).rejects.toMatchObject({ code: "statement_limit" });
    const rows = await statements(opened.disputeId);
    expect(rows.filter((row) => row.authorRole === "creator" && row.kind === "response")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "statement")).toHaveLength(18); expect(rows).toHaveLength(20);
    const events = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, opened.disputeId), eq(schema.systemOutbox.eventType, "resolution.dispute_statement_added.v1")));
    expect(events).toHaveLength(19);
    expect(events.find((event) => event.payload.statementId === added.statementId)?.payload).toEqual({ disputeId: opened.disputeId, statementId: added.statementId, authorRole: "creator" });
  });
  test("parties may add statements after the response deadline until the dispute closes", async () => {
    const p = await f.deliveredOrder(); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    p.s.creator.advance(6 * DAY); await instance.addStatement(statement(p, opened.disputeId));
    await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    await expect(instance.addStatement(statement(p, opened.disputeId))).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test.each([10 * HOUR, 5 * DAY])("withdrawal restores max(%i ms, 48 hours) and resolves the case", async (remaining) => {
    const p = await f.deliveredOrder(); p.s.creator.setNow(new Date((await order(p)).reviewEndsAt!.getTime() - remaining));
    const instance = disputeService(p); const opened = await instance.openDispute(await opening(p)); p.s.creator.advance(DAY);
    await expect(instance.withdrawDispute(withdrawal(p, opened.disputeId, p.creator))).rejects.toMatchObject({ code: "not_available" });
    const command = withdrawal(p, opened.disputeId); const result = await instance.withdrawDispute(command);
    expect(await instance.withdrawDispute(command)).toEqual(result);
    expect(await order(p)).toMatchObject({ state: "delivered", completionFloorAt: new Date(p.s.creator.now().getTime() + Math.max(remaining, 48 * HOUR)) });
    expect(await cases(p)).toMatchObject([{ state: "resolved", resolutionKind: "withdrawn" }]);
    const events = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, opened.disputeId), eq(schema.systemOutbox.eventType, "resolution.dispute_closed.v1")));
    expect(events.map((event) => event.payload)).toEqual([{ disputeId: opened.disputeId, orderId: p.orderId, state: "withdrawn" }]);
  });
  test("withdrawn final trigger cannot reopen; a newly declined proposal re-arms", async () => {
    const p = await f.deliveredOrder(); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    p.s.creator.advance(HOUR); await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    await expect(instance.openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_not_allowed" });
    const ended = await endedProposal(p); const next = await instance.openDispute(await opening(p));
    expect((await disputes(p)).find((row) => row.id === next.disputeId)).toMatchObject({ trigger: "proposal_declined", triggerAt: ended.endedAt });
  });
  test("a newly declined proposal during the dispute remains a new trigger after withdrawal", async () => {
    const p = await f.deliveredOrder(); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    p.s.creator.advance(HOUR); const ended = await endedProposal(p); p.s.creator.advance(HOUR);
    await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    const reopened = await instance.openDispute(await opening(p));
    expect((await disputes(p)).find((row) => row.id === reopened.disputeId)).toMatchObject({ trigger: "proposal_declined", triggerAt: ended.endedAt });
  });
  test("a new final delivery re-arms after withdrawal", async () => {
    const p = await f.deliveredOrder(); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    p.s.creator.advance(HOUR); await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    await respond(p, p.finalId, "request_changes"); p.s.creator.advance(HOUR); await submit(p, "final");
    await expect(instance.openDispute(await opening(p))).resolves.toMatchObject({ disputeId: expect.any(String) });
  });
  test("overdue never re-arms after withdrawal, even after a proposal-triggered dispute", async () => {
    const p = await f.paidOrder(); const instance = disputeService(p); const ended = await endedProposal(p);
    const opened = await instance.openDispute(await opening(p)); await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    p.s.creator.setNow(new Date(Math.max((await order(p)).dueAt!.getTime(), ended.endedAt.getTime()) + 8 * DAY));
    await expect(instance.openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_not_allowed" });
  });
  test("a withdrawn proposal-triggered dispute needs a newly ended proposal", async () => {
    const p = await f.paidOrder(); await endedProposal(p); const instance = disputeService(p); const opened = await instance.openDispute(await opening(p));
    await instance.withdrawDispute(withdrawal(p, opened.disputeId));
    await expect(instance.openDispute(await opening(p))).rejects.toMatchObject({ code: "dispute_not_allowed" });
    await endedProposal(p, p.buyer); await expect(instance.openDispute(await opening(p))).resolves.toMatchObject({ disputeId: expect.any(String) });
  });
  test("accepting a proposal during a dispute settles it and its case with one closed event", async () => {
    const p = await f.deliveredOrder(); const opened = await disputeService(p).openDispute(await opening(p)); const instance = resolutions(p);
    const proposal = await instance.propose({ actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 250_000, note: "Synthetic settlement", ...commandIds() });
    await instance.respondToProposal({ actor: p.buyer, proposalId: proposal.proposalId, response: "accept", ...commandIds() });
    expect(await disputes(p)).toMatchObject([{ state: "settled" }]); expect(await cases(p)).toMatchObject([{ state: "resolved", resolutionKind: "settled" }]);
    const events = await f.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, opened.disputeId), eq(schema.systemOutbox.eventType, "resolution.dispute_closed.v1")));
    expect(events.map((event) => event.payload)).toEqual([{ disputeId: opened.disputeId, orderId: p.orderId, state: "settled" }]);
  });
  test("a pending delivered proposal holds buyer acceptance and automatic completion", async () => {
    const p = await f.deliveredOrder({ reviewWindowDays: 3 }); await resolutions(p).propose({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 0, note: "Synthetic proposal", ...commandIds() });
    await expect(respond(p, p.finalId, "accept")).rejects.toMatchObject({ code: "completion_held" });
    const due = await f.db.transaction((tx) => orderPort().completionDueAt(tx, p.orderId)); p.s.creator.setNow(due!);
    expect(await service(p).completeDue()).toMatchObject({ held: 1 });
    expect((await order(p)).state).toBe("delivered");
  });
  test("a proposal made in progress does not hold completion after final delivery", async () => {
    const p = await f.paidOrder(); await resolutions(p).propose({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 0, note: "Synthetic proposal", ...commandIds() });
    const final = await submit(p, "final"); await respond(p, final.id, "accept"); expect((await order(p)).state).toBe("completed");
  });
  test("automatic completion racing dispute opening has exactly one winning outcome", async () => {
    const p = await f.deliveredOrder(); const due = await f.db.transaction((tx) => orderPort().completionDueAt(tx, p.orderId));
    const command = await opening(p); const buyerClock = () => new Date(due!.getTime() - 1); const workerClock = () => new Date(due!);
    const [opened, completed] = await Promise.allSettled([disputeService(p, {}, { now: buyerClock }).openDispute(command), service(p, { now: workerClock }).completeDue()]);
    expect(completed.status).toBe("fulfilled"); if (completed.status !== "fulfilled") throw new Error("Completion worker failed");
    const current = await order(p);
    if (opened.status === "fulfilled") {
      expect(current.state).toBe("delivered"); expect(await disputes(p)).toMatchObject([{ state: "open" }]); expect(completed.value.held).toBeGreaterThanOrEqual(1);
    } else {
      expect(opened.reason).toMatchObject({ code: "invalid_transition" }); expect(current.state).toBe("completed"); expect(await disputes(p)).toHaveLength(0);
    }
  });
  test("views decrypt participant statements and proposal notes, deny unrelated users and expired sessions", async () => {
    const p = await f.deliveredOrder(); const opened = await disputeService(p).openDispute(await opening(p));
    await disputeService(p).addStatement(statement(p, opened.disputeId));
    await resolutions(p).propose({ actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
      kind: "cancel_with_refund", refundAmountVnd: 0, note: "Synthetic proposal", ...commandIds() });
    for (const actor of [p.buyer, p.creator]) {
      const view = await viewService(p).getOrderResolution({ actor, orderId: p.orderId });
      expect(view.dispute).toMatchObject({ id: opened.disputeId, state: "open", statements: expect.arrayContaining([
        expect.objectContaining({ kind: "opening", text: "Synthetic opening statement" }), expect.objectContaining({ kind: "response", text: "Synthetic party statement" })]) });
      expect(view.proposals.pending).toMatchObject({ note: "Synthetic proposal" }); expect(view.refunds).toEqual([]);
      expect(view.actions).toMatchObject({ canOpenDispute: false, canPropose: false, canCancelAfterSuspension: false });
      expect(view).not.toHaveProperty("lateClaim");
    }
    await expect(viewService(p).getOrderResolution({ actor: await p.s.buyer(), orderId: p.orderId })).rejects.toMatchObject({ code: "not_available" });
    p.s.users.delete(p.buyer.userId);
    await expect(viewService(p).getOrderResolution({ actor: p.buyer, orderId: p.orderId })).rejects.toMatchObject({ code: "not_authorized" });
  });
  test.each(["dueAt", "confirmBy"] as const)("resolution view applies pause fairness to refund %s from the Payments viewer", async (field) => {
    const p = await f.deliveredOrder(); p.s.creator.setNow(new Date(field === "dueAt" ? "2027-01-04T04:00:00Z" : "2027-02-01T04:00:00Z"));
    const refunds = refundService(p);
    const created = await f.db.transaction((tx) => createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" }).createObligation(tx, {
      orderId: p.orderId, paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId,
      source: "agreement", sourceId: randomUUID(), amountVnd: 1, requestId: randomUUID(), at: p.s.creator.now() }));
    await refunds.enterDestination({ actor: p.buyer, obligationId: created.obligationId, expectedVersion: 1, bankBin: "970422",
      accountNumber: "000000123456", accountHolder: "SYNTHETIC BUYER", ...commandIds() });
    if (field === "confirmBy") await refunds.recordSend({ actor: p.creator, obligationId: created.obligationId, expectedVersion: 2,
      transferDate: "2027-02-01", bankReference: "SYNTHETIC", ...commandIds() });
    const original = (await refunds.listForViewer({ actor: p.buyer, orderId: p.orderId }))[0]!;
    const deadline = new Date(original[field]!); const pauseId = randomUUID(); const resumed = new Date(deadline.getTime() + DAY);
    await f.db.insert(schema.commissionResolutionPauses).values({ id: pauseId, startedAt: new Date(deadline.getTime() - HOUR) });
    try {
      expect((await viewService(p, refunds).getOrderResolution({ actor: p.buyer, orderId: p.orderId })).refunds[0]![field]).toBeNull();
    } finally {
      await f.db.update(schema.commissionResolutionPauses).set({ endedAt: resumed, version: 2 }).where(eq(schema.commissionResolutionPauses.id, pauseId));
    }
    const listForViewer = vi.spyOn(refunds, "listForViewer");
    expect((await viewService(p, refunds).getOrderResolution({ actor: p.buyer, orderId: p.orderId })).refunds[0]![field])
      .toBe(new Date(resumed.getTime() + RESOLUTION_POLICY.pauseGraceMs).toISOString());
    expect(listForViewer).toHaveBeenCalledOnce();
    expect((await refunds.listForViewer({ actor: p.buyer, orderId: p.orderId }))[0]![field]).toBe(original[field]);
  });
  test("help-center my cases includes respondent disputes and refund-only orders, excluding unrelated orders", async () => {
    const p = await f.deliveredOrder(); const opened = await disputeService(p).openDispute(await opening(p));
    const mine = await viewService(p).listMyCases({ actor: p.creator });
    expect(mine.disputes).toMatchObject([{ orderId: p.orderId, id: opened.disputeId }]); expect(mine.refunds).toEqual([]);
    const other = await f.deliveredOrder(); await disputeService(other).openDispute(await opening(other));
    const created = await f.db.transaction((tx) => createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion: "vn-proposals-test" }).createObligation(tx, {
      orderId: p.orderId, paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId, buyerUserId: p.buyer.userId,
      source: "agreement", sourceId: randomUUID(), amountVnd: 1, requestId: randomUUID(), at: p.s.creator.now() }));
    await disputeService(p).withdrawDispute(withdrawal(p, opened.disputeId));
    const buyerCases = await viewService(p).listMyCases({ actor: p.buyer });
    expect(buyerCases.disputes).toHaveLength(1); expect(buyerCases.refunds).toMatchObject([{ orderId: p.orderId, obligationId: created.obligationId }]);
    expect(await viewService(p).listMyCases({ actor: await p.s.buyer() })).toEqual({ disputes: [], refunds: [] });
    const refundOnly = await f.paidOrder();
    const obligation = await f.db.transaction((tx) => createCommissionRefundPort({ keyring: refundOnly.s.input.keyring, calendarVersion: "vn-proposals-test" }).createObligation(tx, {
      orderId: refundOnly.orderId, paymentIntentId: refundOnly.confirmationCommand.paymentIntentId, creatorUserId: refundOnly.creator.userId, buyerUserId: refundOnly.buyer.userId,
      source: "agreement", sourceId: randomUUID(), amountVnd: 1, requestId: randomUUID(), at: refundOnly.s.creator.now() }));
    const onlyRefund = await viewService(refundOnly).listMyCases({ actor: refundOnly.buyer });
    expect(onlyRefund.disputes).toEqual([]); expect(onlyRefund.refunds).toMatchObject([{ orderId: refundOnly.orderId, obligationId: obligation.obligationId }]);
  });
});
