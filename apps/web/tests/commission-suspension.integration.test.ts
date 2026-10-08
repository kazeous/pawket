import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionThreadService } from "@pawket/commission-files";
import * as identity from "@pawket/identity";
import { createCommissionFileAccessPort, createCommissionResolutionOrderPort, lockCommissionCreator } from "@pawket/orders";
import { createCommissionPaymentFactsPort, createCommissionRefundPort, createCommissionRefundService } from "@pawket/payments";
import * as resolution from "@pawket/resolutions";
import { createTrustCasePort } from "@pawket/trust";
import { createCommissionResolutionTestFixture, resolutions, service, submit } from "./commission-resolution-test-support.js";
import { commandIds, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const f = createCommissionResolutionTestFixture("i8suspension");
const calendarVersion = "vn-proposals-test";
beforeAll(f.initialize, 60_000); afterAll(f.dispose, 30_000);
type Paid = Awaited<ReturnType<typeof f.paidOrder>>;
const order = (p: Paid) => f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)).then((rows) => rows[0]!);
const refunds = (p: Paid) => f.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.orderId, p.orderId));
const reservations = (p: Paid) => f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId));
const outbox = (id: string) => f.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, id));
const paymentFacts = (p: Paid) => f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, p.confirmationCommand.paymentIntentId));
function ports(p: Paid) {
  return { orders: createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID }),
    refunds: createCommissionRefundPort({ keyring: p.s.input.keyring, calendarVersion }), payments: createCommissionPaymentFactsPort(),
    cases: createTrustCasePort(), standing: identity.createCreatorStandingPort(), mode: "enabled" as const };
}
function kit(p: Paid, options: Partial<Parameters<typeof resolution.createResolutionCommandKit>[0]> = {}) {
  return resolution.createResolutionCommandKit({ ...p.s.creator.common, session: p.s.input.identity, ...options });
}
function suspension(p: Paid, options: Partial<Parameters<typeof resolution.createSuspensionService>[1]> = {},
  kitOptions: Partial<Parameters<typeof resolution.createResolutionCommandKit>[0]> = {}) {
  return resolution.createSuspensionService(kit(p, kitOptions), { ...ports(p), ...options });
}
function partyRefunds(p: Paid) {
  return createCommissionRefundService({ ...p.s.creator.common, applicationRevision: "synthetic-i8", calendarVersion, mode: "enabled",
    recentAuthMs: 3_600_000, mfaAuthMs: 300_000, lockCreator: lockCommissionCreator, cases: createTrustCasePort(),
    assurance: { getTipSessionAssurance: async (_tx, actor, at) => p.s.users.get(actor.userId) === actor.sessionId
      ? { primaryAuthenticatedAt: at, mfaEnrolled: false, mfaVerifiedAt: null, sessionExpiresAt: new Date(at.getTime() + 60_000) } : null } });
}
function view(p: Paid, standing = identity.createCreatorStandingPort()) {
  return resolution.createResolutionViewService({ db: f.db, keyring: p.s.input.keyring,
    orders: { ...ports(p).orders, listOrders: service(p).listOrders }, refunds: partyRefunds(p),
    session: p.s.input.identity, now: p.s.creator.now, standing });
}
async function capability(p: Paid, state: "active" | "suspended" = "suspended") {
  const at = p.s.creator.now(); const applicationId = randomUUID(); const revisionId = randomUUID();
  await f.db.insert(schema.creatorApplications).values({ id: applicationId, userId: p.creator.userId, state: "approved", version: 2,
    currentRevisionId: revisionId, createdAt: at, updatedAt: at });
  await f.db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1,
    artistDisplayName: "Synthetic artist", shortIntroduction: "Synthetic introduction", createdAt: at, updatedAt: at });
  await f.db.insert(schema.identityCreatorCapabilities).values({ id: randomUUID(), userId: p.creator.userId, state,
    approvedApplicationId: applicationId, approvedRevisionId: revisionId, suspendedAt: state === "suspended" ? at : null, createdAt: at, updatedAt: at });
}
async function reinstate(p: Paid) {
  await f.db.update(schema.identityCreatorCapabilities).set({ state: "active", version: 2, suspendedAt: null, updatedAt: p.s.creator.now() })
    .where(eq(schema.identityCreatorCapabilities.userId, p.creator.userId));
}
const cancel = async (p: Paid) => ({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version, ...commandIds() });
async function ownerService(p: Paid, options: Partial<Parameters<typeof resolution.createOwnerResolutionService>[1]> = {}) {
  const owner = await p.s.buyer(); const consume = vi.fn(async (_tx: unknown, command: { userId: string; sessionId: string }) =>
    command.userId === owner.userId && command.sessionId === owner.sessionId);
  return { owner, consume, instance: resolution.createOwnerResolutionService(kit(p, { consumeStepUpProof: consume }),
    { ...ports(p), applicationRevision: "synthetic-i8", ...options }) };
}
const freeze = (p: Paid, owner: Paid["buyer"]) => ({ owner, creatorUserId: p.creator.userId, stepUpProofId: randomUUID(),
  reason: "Synthetic freeze reason", ...commandIds() });
async function additionalPaid(p: Paid) {
  const buyer = await p.s.buyer(); const orderId = await p.s.service.request(p.s.request(buyer)); p.s.creator.advance(1_000);
  const detail = await p.s.service.getOrder({ actor: buyer, orderId }); const payment = detail.payment!;
  const confirmationCommand = { ...p.confirmationCommand, paymentIntentId: payment.id, observedAmountVnd: payment.amountVnd,
    observedTransferReference: payment.reference, observedBankTransactionId: randomUUID(), ...commandIds() };
  await p.confirmationService.confirm(confirmationCommand); return { ...p, buyer, orderId, confirmationCommand };
}
async function pendingAndDispute(p: Paid) {
  const { proposalId } = await resolutions(p).propose({ actor: p.creator, orderId: p.orderId, expectedVersion: (await order(p)).version,
    kind: "cancel_with_refund", refundAmountVnd: 100_000, note: "Synthetic proposal", ...commandIds() });
  const { disputeId, caseId } = await resolution.createDisputeService(kit(p), ports(p)).openDispute({ actor: p.buyer, orderId: p.orderId,
    expectedVersion: (await order(p)).version, reason: "not_as_agreed", statement: "Synthetic dispute",
    requestedOutcome: { kind: "close", refundAmountVnd: 200_000 }, acknowledgeStaffReview: true, ...commandIds() });
  return { proposalId, disputeId, caseId };
}
async function superseded(ids: Awaited<ReturnType<typeof pendingAndDispute>>, p: Paid, reason: string | null = null) {
  expect(await f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, ids.proposalId)))
    .toMatchObject([{ state: "superseded", version: 2, endedAt: p.s.creator.now() }]);
  expect(await f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, ids.disputeId)))
    .toMatchObject([{ state: "superseded", version: 2, closedAt: p.s.creator.now() }]);
  expect(await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, ids.caseId)))
    .toMatchObject([{ state: "resolved", resolutionKind: "superseded" }]);
  const events = await f.db.select().from(schema.trustCaseEvents)
    .where(and(eq(schema.trustCaseEvents.caseId, ids.caseId), eq(schema.trustCaseEvents.action, "resolved")));
  expect(events).toHaveLength(1); expect(events[0]!.reason === reason).toBe(true);
  expect((await outbox(ids.proposalId)).filter((row) => row.eventType === "resolution.proposal_ended.v1").map((row) => row.payload))
    .toEqual([{ proposalId: ids.proposalId, orderId: p.orderId, state: "superseded" }]);
  expect((await outbox(ids.disputeId)).filter((row) => row.eventType === "resolution.dispute_closed.v1").map((row) => row.payload))
    .toEqual([{ disputeId: ids.disputeId, orderId: p.orderId, state: "superseded" }]);
}

describe("commission suspension effects", () => {
  test("standing includes capability suspension and account suspension, and distinguishes active from none", async () => {
    const p = await f.paidOrder(); const standing = identity.createCreatorStandingPort();
    const read = (userId = p.creator.userId) => f.db.transaction((tx) => standing.readCreatorStanding(tx, userId));
    expect(await read()).toBe("none"); expect(await read("synthetic-unknown")).toBe("none");
    await capability(p, "active"); expect(await read()).toBe("active");
    await f.db.update(schema.identityCreatorCapabilities).set({ state: "suspended", suspendedAt: p.s.creator.now(), version: 2 })
      .where(eq(schema.identityCreatorCapabilities.userId, p.creator.userId)); expect(await read()).toBe("suspended");
    await reinstate(p); await f.db.update(schema.identityUsers).set({ accessStatus: "access_suspended" }).where(eq(schema.identityUsers.id, p.creator.userId));
    expect(await read()).toBe("suspended");
    await f.db.update(schema.identityUsers).set({ accessStatus: "access_suspended" }).where(eq(schema.identityUsers.id, p.buyer.userId));
    expect(await read(p.buyer.userId)).toBe("suspended");
  });
  test("a suspended creator can still submit a final on a paid order", async () => {
    const p = await f.paidOrder(); await capability(p); await submit(p, "final");
    expect(await order(p)).toMatchObject({ state: "delivered", confirmedAt: expect.any(Date) });
  });
  test.each(["in_progress", "delivered"] as const)("while suspended the buyer cancels %s with a full refund and supersedes resolutions", async (state) => {
    const p = state === "delivered" ? await f.deliveredOrder() : await f.paidOrder(); await capability(p);
    const ids = state === "delivered" ? await pendingAndDispute(p) : null;
    const before = await order(p); const payment = await paymentFacts(p); const instance = suspension(p); const command = await cancel(p);
    const result = await instance.cancelAfterSuspension(command); expect(await instance.cancelAfterSuspension(command)).toEqual(result);
    expect(await order(p)).toMatchObject({ state: "closed", closeReason: "buyer_cancelled_after_suspension", version: before.version + 1,
      completionFloorAt: before.completionFloorAt, confirmedAt: before.confirmedAt });
    expect(await refunds(p)).toMatchObject([{ id: result.obligationId, source: "suspension_cancel", sourceId: p.orderId,
      paymentIntentId: p.confirmationCommand.paymentIntentId, amountVnd: 500_000, state: "awaiting_destination" }]);
    expect(await refunds(p)).toHaveLength(1); expect(await reservations(p)).toMatchObject([{ state: "cancelled" }]);
    expect(await paymentFacts(p)).toEqual(payment); if (ids) await superseded(ids, p);
    await reinstate(p); expect(await instance.cancelAfterSuspension(command)).toEqual(result);
    await expect(instance.cancelAfterSuspension({ ...command, ...commandIds(), expectedVersion: before.version + 1 })).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("after reinstatement cancellation fails invalid_transition and the buyer-only view follows standing", async () => {
    const p = await f.paidOrder(); await capability(p); const views = view(p);
    const action = async (actor = p.buyer) => (await views.getOrderResolution({ actor, orderId: p.orderId })).actions.canCancelAfterSuspension;
    expect(await action()).toBe(true); expect(await action(p.creator)).toBe(false);
    await submit(p, "final"); expect(await action()).toBe(true);
    await reinstate(p); expect(await action()).toBe(false);
    await expect(suspension(p).cancelAfterSuspension(await cancel(p))).rejects.toMatchObject({ code: "invalid_transition" });
    await f.db.update(schema.identityUsers).set({ accessStatus: "access_suspended" }).where(eq(schema.identityUsers.id, p.creator.userId));
    expect(await action()).toBe(true); await suspension(p).cancelAfterSuspension(await cancel(p)); expect(await action()).toBe(false);
  });
  test("a completed paid order has no cancellation action while its creator is suspended", async () => {
    const p = await f.deliveredOrder(); await capability(p);
    await service(p).respondToSubmission({ actor: p.buyer, orderId: p.orderId, expectedVersion: (await order(p)).version,
      submissionId: p.finalId, response: "accept", note: undefined, ...commandIds() });
    expect((await view(p).getOrderResolution({ actor: p.buyer, orderId: p.orderId })).actions.canCancelAfterSuspension).toBe(false);
    await expect(suspension(p).cancelAfterSuspension(await cancel(p))).rejects.toMatchObject({ code: "invalid_transition" });
  });
  test("freeze closes every live order with one full obligation, supersedes resolutions, audits and replays before proof", async () => {
    const p = await f.deliveredOrder(); const second = await additionalPaid(p); const pendingOrderId = await p.s.service.request(p.s.request(await p.s.buyer()));
    const unrelated = await f.paidOrder(); const ids = await pendingAndDispute(p); await capability(p);
    const before = await order(p); const secondBefore = await order(second); const payments = await Promise.all([paymentFacts(p), paymentFacts(second)]);
    const c = await ownerService(p); const command = freeze(p, c.owner);
    expect(await c.instance.freezeFulfillment(command)).toEqual({ closedOrders: 2 }); c.consume.mockResolvedValue(false);
    expect(await c.instance.freezeFulfillment(command)).toEqual({ closedOrders: 2 }); expect(c.consume).toHaveBeenCalledTimes(1);
    expect(c.consume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ...c.owner, actionClass: "owner.commission_fulfillment_freeze" }));
    for (const [paid, previous] of [[p, before], [second, secondBefore]] as const) {
      expect(await order(paid)).toMatchObject({ state: "closed", closeReason: "fulfillment_frozen", version: previous.version + 1,
        completionFloorAt: previous.completionFloorAt });
      expect(await refunds(paid)).toMatchObject([{ source: "fulfillment_freeze", sourceId: paid.orderId, amountVnd: 500_000,
        paymentIntentId: paid.confirmationCommand.paymentIntentId }]); expect(await refunds(paid)).toHaveLength(1);
      expect(await reservations(paid)).toMatchObject([{ state: "cancelled" }]);
    }
    expect(await Promise.all([paymentFacts(p), paymentFacts(second)])).toEqual(payments); await superseded(ids, p, command.reason);
    expect(await order({ ...p, orderId: pendingOrderId })).toMatchObject({ state: "awaiting_payment" }); expect((await order(unrelated)).state).toBe("in_progress");
    expect((await outbox(p.creator.userId)).filter((row) => row.eventType === "resolution.fulfillment_frozen.v1").map((row) => row.payload))
      .toEqual([{ creatorUserId: p.creator.userId, closedOrders: 2 }]);
    const audits = (await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, command.requestId)))
      .filter((row) => row.action === "owner.commission_fulfillment_freeze");
    expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ actorUserId: c.owner.userId, actorSessionId: c.owner.sessionId,
      subjectId: p.creator.userId, applicationRevision: "synthetic-i8", assurance: { method: "owner_step_up" }, afterState: { closedOrders: 2 } });
    expect(audits[0]!.afterState?.reason === command.reason).toBe(true);
  });
  test("freeze keeps the normalized owner reason in audit and every superseded case, excluding outbox and party projections", async () => {
    const p = await f.deliveredOrder(); const second = await additionalPaid(p); await submit(second, "final");
    const firstIds = await pendingAndDispute(p); const secondIds = await pendingAndDispute(second); await capability(p);
    const c = await ownerService(p); const command = { ...freeze(p, c.owner), reason: "  Synthetic freeze cafe\u0301 reason  " };
    const reason = "Synthetic freeze caf\u00e9 reason";
    expect(await c.instance.freezeFulfillment(command)).toEqual({ closedOrders: 2 });
    const audits = await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, command.requestId));
    const ownerAudits = audits.filter((row) => row.action === "owner.commission_fulfillment_freeze");
    expect(ownerAudits).toHaveLength(1); expect(ownerAudits[0]!.afterState?.reason === reason).toBe(true);
    const aggregateIds = [p.creator.userId];
    for (const [paid, ids] of [[p, firstIds], [second, secondIds]] as const) {
      await superseded(ids, paid, reason);
      aggregateIds.push(paid.orderId, ids.proposalId, ids.disputeId, ids.caseId, (await refunds(paid))[0]!.id);
      const views = view(paid);
      for (const actor of [paid.buyer, paid.creator]) {
        const projections = await Promise.all([views.getOrderResolution({ actor, orderId: paid.orderId }),
          views.listMyCases({ actor }), service(paid).getOrder({ actor, orderId: paid.orderId })]);
        for (const text of [command.reason, reason]) expect(JSON.stringify(projections).includes(text)).toBe(false);
      }
    }
    const payloads = await f.db.select({ payload: schema.systemOutbox.payload }).from(schema.systemOutbox)
      .where(inArray(schema.systemOutbox.aggregateId, aggregateIds));
    for (const text of [command.reason, reason]) expect(JSON.stringify(payloads).includes(text)).toBe(false);
  });
  test("a fresh freeze with standing omitted fails dependency_unavailable and writes nothing", async () => {
    const p = await f.deliveredOrder(); const ids = await pendingAndDispute(p); await capability(p); const c = await ownerService(p);
    const { orders, refunds: refundPort, payments, cases, mode } = ports(p);
    const instance = resolution.createOwnerResolutionService(kit(p, { consumeStepUpProof: c.consume }),
      { orders, refunds: refundPort, payments, cases, mode, applicationRevision: "synthetic-i8" });
    const command = freeze(p, c.owner);
    const read = () => Promise.all([order(p), reservations(p), paymentFacts(p), outbox(p.orderId), outbox(p.creator.userId),
      outbox(ids.proposalId), outbox(ids.disputeId), outbox(ids.caseId),
      f.db.select().from(schema.commissionProposals).where(eq(schema.commissionProposals.id, ids.proposalId)),
      f.db.select().from(schema.commissionDisputes).where(eq(schema.commissionDisputes.id, ids.disputeId)),
      f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, ids.caseId)),
      f.db.select().from(schema.trustCaseEvents).where(eq(schema.trustCaseEvents.caseId, ids.caseId)),
      f.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId))]);
    const before = await read();
    await expect(instance.freezeFulfillment(command)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await read()).toEqual(before); expect(await refunds(p)).toHaveLength(0);
    expect(await f.db.select().from(schema.commissionRefundEvents).where(eq(schema.commissionRefundEvents.requestId, command.requestId))).toHaveLength(0);
    expect(await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, command.requestId))).toHaveLength(0);
    expect(await f.db.select().from(schema.systemCommandIdempotency).where(eq(schema.systemCommandIdempotency.actorUserId, c.owner.userId))).toHaveLength(0);
  });
  test("freeze on an active creator fails invalid_transition and a fresh freeze needs step-up and reason", async () => {
    const p = await f.paidOrder(); await capability(p, "active"); const c = await ownerService(p); const command = freeze(p, c.owner);
    await expect(c.instance.freezeFulfillment(command)).rejects.toMatchObject({ code: "invalid_transition" });
    c.consume.mockResolvedValue(false); await expect(c.instance.freezeFulfillment({ ...command, ...commandIds() })).rejects.toMatchObject({ code: "owner_step_up_required" });
    await expect(c.instance.freezeFulfillment({ ...command, reason: "" })).rejects.toMatchObject({ code: "invalid_request" });
    expect((await order(p)).state).toBe("in_progress"); expect(await refunds(p)).toHaveLength(0);
  });
  test("threads of frozen orders refuse new messages from either party", async () => {
    const p = await f.deliveredOrder(); await capability(p); const c = await ownerService(p);
    const messages = createCommissionThreadService({ ...p.s.input, filesMode: "enabled", fulfillmentMode: "enabled", sessions: p.s.input.identity,
      orders: createCommissionFileAccessPort({ catalog: p.s.catalog }) });
    await messages.sendMessage({ actor: p.creator, orderId: p.orderId, text: "Synthetic message", fileIds: [], ...commandIds() });
    await c.instance.freezeFulfillment(freeze(p, c.owner));
    for (const actor of [p.buyer, p.creator]) {
      await expect(messages.sendMessage({ actor, orderId: p.orderId, text: "Synthetic message", fileIds: [], ...commandIds() })).rejects.toMatchObject({ code: "invalid_state" });
    }
  });
  test("freeze rolls every order, obligation, reservation, supersession and audit back if a later refund fails", async () => {
    const p = await f.deliveredOrder(); const second = await additionalPaid(p); const ids = await pendingAndDispute(p); await capability(p);
    const before = await Promise.all([order(p), order(second), reservations(p), reservations(second), outbox(ids.proposalId), outbox(ids.disputeId)]);
    const refundsPort = ports(p).refunds; const create = refundsPort.createObligation; let calls = 0;
    vi.spyOn(refundsPort, "createObligation").mockImplementation(async (tx, command) => {
      const result = await create(tx, command); if (++calls === 2) throw new Error("Synthetic refund dependency failure"); return result;
    });
    const c = await ownerService(p, { refunds: refundsPort }); const command = freeze(p, c.owner);
    await expect(c.instance.freezeFulfillment(command)).rejects.toMatchObject({ code: "dependency_unavailable" }); expect(calls).toBe(2);
    expect(await Promise.all([order(p), order(second), reservations(p), reservations(second), outbox(ids.proposalId), outbox(ids.disputeId)])).toEqual(before);
    expect(await refunds(p)).toHaveLength(0); expect(await refunds(second)).toHaveLength(0);
    expect(await f.db.select().from(schema.trustCases).where(eq(schema.trustCases.id, ids.caseId))).toMatchObject([{ state: "open" }]);
    expect(await f.db.select().from(schema.adminAuditEvents).where(eq(schema.adminAuditEvents.requestId, command.requestId))).toHaveLength(0);
    expect((await outbox(p.creator.userId)).filter((row) => row.eventType === "resolution.fulfillment_frozen.v1")).toHaveLength(0);
  });
  test("a buyer whose account is suspended keeps their order progressing; creator delivers and automatic completion runs", async () => {
    const p = await f.paidOrder(); await f.db.update(schema.identityUsers).set({ accessStatus: "access_suspended" }).where(eq(schema.identityUsers.id, p.buyer.userId));
    p.s.users.delete(p.buyer.userId); await submit(p, "final"); const row = await order(p); expect(row.state).toBe("delivered");
    const due = (await f.db.transaction((tx) => createCommissionResolutionOrderPort({ applicationRevision: "synthetic-i8", newId: randomUUID }).completionDueAt(tx, p.orderId)))!;
    p.s.creator.setNow(due);
    await service(p).completeDue(); expect(await order(p)).toMatchObject({ state: "completed", completionKind: "review_window_elapsed" });
    expect(await reservations(p)).toMatchObject([{ state: "completed" }]);
  });
  test.each(["cancel_first", "freeze_first"] as const)("freeze racing buyer cancellation closes once with one obligation (%s)", async (first) => {
    const p = await f.paidOrder(); await capability(p); const c = await ownerService(p); const command = await cancel(p);
    const orders = ports(p).orders; const close = orders.closePaidOrder; let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(orders, "closePaidOrder").mockImplementation(async (tx, change) => { entered(); await gate; return close(tx, change); });
    const firstOwner = await ownerService(p, { orders });
    const winner = first === "cancel_first" ? suspension(p, { orders }).cancelAfterSuspension(command)
      : firstOwner.instance.freezeFulfillment(freeze(p, firstOwner.owner));
    await ready;
    const loser = first === "cancel_first" ? c.instance.freezeFulfillment(freeze(p, c.owner)) : suspension(p).cancelAfterSuspension(command);
    const settled = Promise.allSettled([winner, loser]); release(); const results = await settled;
    expect(results[0]!.status).toBe("fulfilled");
    if (first === "cancel_first") expect(results[1]).toMatchObject({ status: "fulfilled", value: { closedOrders: 0 } });
    else expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "version_conflict" } });
    expect(await refunds(p)).toHaveLength(1); expect((await order(p)).version).toBe(command.expectedVersion + 1);
    expect((await order(p)).closeReason).toBe(first === "cancel_first" ? "buyer_cancelled_after_suspension" : "fulfillment_frozen");
    expect(await reservations(p)).toMatchObject([{ state: "cancelled" }]);
  });
  test("a suspended creator can still reveal a refund destination and record a send after freeze", async () => {
    const p = await f.paidOrder(); await capability(p); const c = await ownerService(p); await c.instance.freezeFulfillment(freeze(p, c.owner));
    const obligationId = (await refunds(p))[0]!.id; const instance = partyRefunds(p); const accountNumber = "000000123456";
    await instance.enterDestination({ actor: p.buyer, obligationId, expectedVersion: 1, bankBin: "970422", accountNumber,
      accountHolder: "SYNTHETIC BUYER", ...commandIds() });
    const destination = await instance.revealDestination({ actor: p.creator, obligationId, requestId: randomUUID() });
    expect(destination.accountNumber === accountNumber && destination.amountVnd === 500_000).toBe(true);
    await instance.recordSend({ actor: p.creator, obligationId, expectedVersion: 2, transferDate: p.s.creator.now().toISOString().slice(0, 10),
      bankReference: "SYNTHETIC_REF", ...commandIds() });
    expect(await refunds(p)).toMatchObject([{ state: "sent", version: 3 }]);
    expect((await f.db.select().from(schema.commissionRefundEvents).where(eq(schema.commissionRefundEvents.obligationId, obligationId))).map((row) => row.action))
      .toEqual(["created", "destination_entered", "destination_revealed", "sent_recorded"]);
  });
  test("a skipped capability row fails dependency_unavailable promptly for cancellation, freeze and the view", async () => {
    const p = await f.paidOrder(); await capability(p); const instance = suspension(p); const c = await ownerService(p); const views = view(p); const command = await cancel(p);
    let entered!: () => void; let release!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = f.db.transaction(async (tx) => {
      await tx.select().from(schema.identityCreatorCapabilities).where(eq(schema.identityCreatorCapabilities.userId, p.creator.userId)).for("update"); entered(); await gate;
    });
    await ready;
    try {
      await expect(instance.cancelAfterSuspension(command)).rejects.toMatchObject({ code: "dependency_unavailable" });
      await expect(c.instance.freezeFulfillment(freeze(p, c.owner))).rejects.toMatchObject({ code: "dependency_unavailable" });
      await expect(views.getOrderResolution({ actor: p.buyer, orderId: p.orderId })).rejects.toMatchObject({ code: "dependency_unavailable" });
    } finally { release(); await holder; }
    expect((await order(p)).state).toBe("in_progress"); expect(await refunds(p)).toHaveLength(0);
  });
  test("cancel enforces buyer, session, switch, version and payload binding without creating obligations", async () => {
    const p = await f.paidOrder(); await capability(p); const instance = suspension(p); const command = await cancel(p); const outsider = await p.s.buyer();
    for (const actor of [p.creator, outsider]) await expect(instance.cancelAfterSuspension({ ...command, actor })).rejects.toMatchObject({ code: "not_available" });
    await expect(instance.cancelAfterSuspension({ ...command, actor: { ...p.buyer, sessionId: randomUUID() } })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(suspension(p, { mode: "disabled" }).cancelAfterSuspension(command)).rejects.toMatchObject({ code: "resolution_disabled" });
    await expect(instance.cancelAfterSuspension({ ...command, expectedVersion: command.expectedVersion + 1 })).rejects.toMatchObject({ code: "version_conflict" });
    const other = await additionalPaid(p); await instance.cancelAfterSuspension(command);
    await expect(instance.cancelAfterSuspension({ ...command, orderId: other.orderId })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await refunds(other)).toHaveLength(0);
  });
});
