import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createCommissionOrderMaintenanceService, createCommissionPaymentLifecyclePort, lockCommissionCreator } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { createCreatorTipPaymentService } from "@pawket/payments";
import { createReceivingAccountService } from "@pawket/payments";
import { createCommissionPaymentIntentPort } from "@pawket/payments";
import { createSePayReconciliationService, createSePayReviewService } from "@pawket/payments";
import { runRetentionSweep } from "@pawket/database";
import { commissionFixture } from "./commission-payment-test-support.js";
import { commandIds, createSePayIntegrationFixture, deferred, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

const url = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test|ci/iu.test(url.pathname)) throw new Error("Commission tests require a dedicated local test database");
const fixture = createSePayIntegrationFixture("commission_payment");
beforeAll(fixture.initialize, 30_000);
afterAll(fixture.dispose, 30_000);
const eligibility = { lockSettlementParticipants: vi.fn(async () => true) };
type Pending = Awaited<ReturnType<typeof commissionFixture>>;
function service(pending: Pending, commissions = createCommissionPaymentLifecyclePort({ eligibility })) {
  return createCreatorCommissionPaymentService({ ...pending.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only",
    recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: pending.creator.assurance, commissions });
}
function command(p: Pending, bankTransactionId = randomUUID()) {
  return { actor: p.creator.actor, paymentIntentId: p.payment.id, observedAmountVnd: p.payment.amountVnd, observedTransferReference: p.payment.reference,
    observedBankTransactionId: bankTransactionId, attestedReceived: true, ...commandIds() };
}
async function facts(p: Pending) {
  return {
    order: (await fixture.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId)))[0]!,
    slot: (await fixture.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.orderId, p.orderId)))[0]!,
    intent: (await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, p.payment.id)))[0]!,
    confirmations: await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, p.payment.id)),
    events: await fixture.db.select().from(schema.commissionEvents).where(eq(schema.commissionEvents.orderId, p.orderId)),
    outbox: await fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.aggregateId, p.payment.id)),
  };
}
async function cancel(p: Pending) {
  return fixture.db.transaction(async (tx) => {
    await lockCommissionCreator(tx, p.creator.actor.userId);
    const at = p.creator.now();
    if (!await p.payments.closeIntent(tx, { ...p.binding, at, reason: "buyer_cancelled" })) return false;
    const [order] = await tx.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, p.orderId));
    await tx.update(schema.commissionOrders).set({ state: "closed", version: order!.version + 1, closeReason: "buyer_cancelled", closedAt: at, updatedAt: at }).where(eq(schema.commissionOrders.id, p.orderId));
    await tx.update(schema.commissionReservations).set({ state: "released", releasedAt: at }).where(eq(schema.commissionReservations.orderId, p.orderId));
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: order!.version + 1, type: "closed", reason: "buyer_cancelled",
      actorUserId: p.buyerUserId, actorSessionId: "synthetic-buyer-session", requestId: randomUUID(), occurredAt: at });
    return true;
  });
}
async function expectSqlState(operation: PromiseLike<unknown>, code: string) {
  try { await operation; } catch (error) { expect((error as { cause?: unknown }).cause ?? error).toMatchObject({ code }); return; }
  throw new Error(`Expected SQLSTATE ${code}`);
}
describe("commission payments share the existing financial boundary", () => {
  test("QR opens atomically with terms and a slot; incomplete or failed creation rolls everything back", async () => {
    const creator = await fixture.creator();
    await expectSqlState(commissionFixture(fixture, creator, { omitPayment: true }), "23514");
    await expect(commissionFixture(fixture, creator, { afterPayment: () => { throw new Error("synthetic failure"); } })).rejects.toThrow("synthetic failure");
    expect(await fixture.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.creatorUserId, creator.actor.userId))).toHaveLength(0);
    const p = await commissionFixture(fixture, creator);
    expect(p.payment).toMatchObject({ state: "awaiting_transfer", settlementLane: "manual_attested", instruction: { amountVnd: 50_000, currency: "VND" } });
    expect(p.payment.instruction?.qrPayload).toBeTruthy();
    expect((await facts(p)).intent).toMatchObject({ purpose: "commission", tipId: null, commissionOrderId: p.orderId });
    await expectSqlState(fixture.db.insert(schema.paymentGuestCapabilities).values({ id: randomUUID(), paymentIntentId: p.payment.id, capabilityHash: fixtureHash(), createdAt: creator.now(), expiresAt: new Date(creator.now().getTime() + 86_400_000) }), "23514");
  });
  test("manual confirmation occupies the slot and starts turnaround, with one event on replay", async () => {
    const p = await commissionFixture(fixture, await fixture.creator()); p.creator.advance(1_000);
    const s = service(p); const c = command(p);
    expect(await s.confirm(c)).toMatchObject({ state: "confirmed", confirmationSource: "creator_manual", instruction: null });
    expect(await s.confirm(c)).toMatchObject({ state: "confirmed" });
    const f = await facts(p);
    expect(f.order).toMatchObject({ state: "in_progress", version: 2, confirmedAt: p.creator.now(), dueAt: new Date(p.creator.now().getTime() + 7 * 86_400_000) });
    expect(f.slot).toMatchObject({ state: "occupied", occupiedAt: p.creator.now() });
    expect(f.confirmations).toHaveLength(1); expect(f.events).toHaveLength(2); expect(f.outbox).toHaveLength(1);
    expect(f.outbox[0]).toMatchObject({ eventType: "commission.confirmed.v1", payload: { orderId: p.orderId } });
    expect(f.outbox[0]!.payload).not.toHaveProperty("tipId");
    expect(await cancel(p)).toBe(false);
  });
  test("an Orders refusal after the financial write rolls back confirmation, slot, order and outbox", async () => {
    const p = await commissionFixture(fixture, await fixture.creator()); p.creator.advance(1_000);
    const port = createCommissionPaymentLifecyclePort({ eligibility });
    const failing = { ...port, confirmPayment: async (...args: Parameters<typeof port.confirmPayment>) => { await port.confirmPayment(...args); return false; } };
    await expect(service(p, failing).confirm(command(p))).rejects.toMatchObject({ code: "intent_not_pending" });
    const f = await facts(p);
    expect(f.order.state).toBe("awaiting_payment"); expect(f.slot.state).toBe("reserved"); expect(f.intent.state).toBe("awaiting_transfer");
    expect(f.confirmations).toHaveLength(0); expect(f.outbox).toHaveLength(0); expect(f.events).toHaveLength(1);
  });
  test("manual bank transaction identity is shared by tips and commissions in both directions", async () => {
    for (const first of ["tip", "commission"] as const) {
      const creator = await fixture.creator(); const tip = await creator.createIntent(); const p = await commissionFixture(fixture, creator); creator.advance(1_000);
      const tips = createCreatorTipPaymentService({ ...creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", pageSize: 25,
        recentAuthMs: 900_000, mfaAuthMs: 300_000, assurance: creator.assurance,
        tips: { ...creator.tips, getConfirmedGuestContent: async () => ({ name: "Synthetic buyer", message: "Private fixture message" }) } });
      const shared = command(p);
      const tipCommand = { ...shared, paymentIntentId: tip.id, observedTransferReference: tip.reference };
      const commissions = service(p);
      if (first === "tip") { await tips.confirm(tipCommand); await expect(commissions.confirm(shared)).rejects.toMatchObject({ code: "bank_transaction_conflict" }); }
      else { await commissions.confirm(shared); await expect(tips.confirm(tipCommand)).rejects.toMatchObject({ code: "bank_transaction_conflict" }); }
      await expect(tips.confirm({ ...shared, ...commandIds() })).rejects.toMatchObject({ code: "not_authorized" });
      await expect(commissions.confirm({ ...tipCommand, ...commandIds() })).rejects.toMatchObject({ code: "not_authorized" });
      const confirmations = await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.creatorUserId, creator.actor.userId));
      expect(confirmations).toHaveLength(1);
    }
  });
  test("claims are buyer-only and idempotent; pausing payments removes instructions without removing history", async () => {
    const p = await commissionFixture(fixture, await fixture.creator());
    await expectSqlState(fixture.db.transaction((tx) => p.payments.claimTransfer(tx, { ...p.binding, buyerUserId: p.creator.actor.userId, requestId: randomUUID() })), "23514");
    const claim = { ...p.binding, buyerUserId: p.buyerUserId, requestId: randomUUID() };
    const created = await fixture.db.transaction((tx) => p.payments.claimTransfer(tx, claim));
    expect(created.created).toBe(true);
    expect(await fixture.db.transaction((tx) => p.payments.claimTransfer(tx, claim))).toEqual({ ...created, created: false });
    const paused = createCommissionPaymentIntentPort({ ...p.creator.common, paymentsMode: "disabled" });
    const receipt = await fixture.db.transaction((tx) => paused.projectPayment(tx, { ...p.binding, includeInstructions: true }));
    expect(receipt).toMatchObject({ state: "awaiting_transfer", instruction: null, transferClaimedAt: p.creator.now().toISOString() });
    await expectSqlState(fixture.db.transaction((tx) => p.payments.closeIntent(tx, { ...p.binding, reason: "buyer_cancelled" })), "23514");
    expect(await cancel(p)).toBe(true);
    await expect(service(p).confirm(command(p))).rejects.toMatchObject({ code: "not_available" });
    expect((await facts(p)).slot.state).toBe("released");
  });
  test("confirmation holding the creator fence wins over cancellation without a mixed commit", async () => {
    const p = await commissionFixture(fixture, await fixture.creator()); p.creator.advance(1_000);
    const locked = deferred<void>(); const release = deferred<void>(); const port = createCommissionPaymentLifecyclePort({ eligibility });
    const s = service(p, { ...port, lockSettlement: async (...args: Parameters<typeof port.lockSettlement>) => {
      const result = await port.lockSettlement(...args); locked.resolve(); await release.promise; return result;
    } });
    const confirmed = s.confirm(command(p)); await locked.promise;
    const cancelled = cancel(p); release.resolve();
    expect(await confirmed).toMatchObject({ state: "confirmed" }); expect(await cancelled).toBe(false);
    const f = await facts(p); expect(f.order.state).toBe("in_progress"); expect(f.intent.state).toBe("confirmed"); expect(f.slot.state).toBe("occupied");
  });
  test("provider-bound commission routes to Orders with tip payments paused", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect(); await creator.cutover(); creator.advance(1_000);
    await expect(commissionFixture(fixture, creator)).rejects.toMatchObject({ code: "not_available" });
    const p = await commissionFixture(fixture, creator, { paymentsMode: "sepay_optional" }); creator.advance(1_000);
    const event = creator.event(p.payment.reference); await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, event));
    const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    const review = createSePayReviewService({ ...creator.common, assurance: creator.assurance, paymentsMode: "sepay_optional", applicationRevision: "synthetic-i6", authorizeOwner: async () => false });
    expect((await review.list({ actor: creator.actor, status: "pending" })).items[0]?.payment).toEqual({ purpose: "commission", resourceId: p.orderId });
    const commissions = createCommissionPaymentLifecyclePort({ eligibility });
    const observed = vi.fn();
    const reconciliation = createSePayReconciliationService({ ...creator.reconciliationInput, paymentsMode: "disabled", commissionPaymentsMode: "sepay_optional", commissions, onCommissionConfirmed: observed });
    expect(await reconciliation.processInbox(inbox!.id)).toBe("confirmed");
    expect(observed).toHaveBeenCalledExactlyOnceWith("sepay_automatic");
    expect(await reconciliation.processInbox(inbox!.id)).toBe("confirmed");
    expect(observed).toHaveBeenCalledTimes(1);
    expect(creator.tips.completeTip).not.toHaveBeenCalled();
    const f = await facts(p); expect(f.order.state).toBe("in_progress"); expect(f.confirmations[0]?.source).toBe("sepay_automatic");
    expect(f.outbox[0]?.eventType).toBe("commission.confirmed.v1");
    const transaction = await fixture.db.select().from(schema.paymentsSepayTransactions).where(and(eq(schema.paymentsSepayTransactions.paymentIntentId, p.payment.id), eq(schema.paymentsSepayTransactions.providerTransactionId, String(event.id))));
    expect(transaction).toHaveLength(1);
  });
  test("manual commission creation fences SePay cutover until the pending payment closes", async () => {
    const creator = await fixture.creator(); await creator.connect();
    const entered = deferred<number>(); const release = deferred<void>();
    const creating = commissionFixture(fixture, creator, { afterPayment: async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      entered.resolve(backend!.pid); await release.promise;
    } });
    const pid = await entered.promise;
    const switching = creator.cutover().then(() => ({ code: "unexpected_success" }), (error: { code: string }) => error);
    try {
      await expect.poll(async () => {
        const [row] = await fixture.db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        ) as waiting`);
        return row?.waiting;
      }, { timeout: 5_000 }).toBe(true);
    } finally { release.resolve(); }
    const p = await creating;
    expect(await switching).toMatchObject({ code: "open_manual_intents" });
    expect(await fixture.db.select().from(schema.paymentsSepayAccountCutovers).where(eq(schema.paymentsSepayAccountCutovers.creatorUserId, creator.actor.userId))).toHaveLength(0);
    expect(await cancel(p)).toBe(true);
    await creator.cutover();
    await expect(commissionFixture(fixture, creator)).rejects.toMatchObject({ code: "not_available" });
    const next = await commissionFixture(fixture, creator, { paymentsMode: "sepay_optional" });
    expect(next.payment.settlementLane).toBe("provider_bound");
  });
  test.each(["tip", "commission"] as const)("a canonical provider transfer first used by a %s cannot settle the other purpose", async (first) => {
    const creator = await fixture.creator(); const connected = await creator.connect(); const cutover = await creator.cutover();
    creator.advance(1_000);
    const tip = await creator.createIntent(cutover.id); const p = await commissionFixture(fixture, creator, { paymentsMode: "sepay_optional" });
    creator.advance(1_000);
    const winner = first === "tip" ? tip : p.payment;
    const loser = first === "tip" ? p.payment : tip;
    const event = creator.event(winner.reference);
    expect(await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, event))).toBe("accepted");
    const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    const reconciliation = createSePayReconciliationService({ ...creator.reconciliationInput, commissionPaymentsMode: "sepay_optional",
      commissions: createCommissionPaymentLifecyclePort({ eligibility }) });
    expect(await reconciliation.processInbox(inbox!.id)).toBe("confirmed");
    const [canonical] = await fixture.db.select().from(schema.paymentsSepayTransactions).where(eq(schema.paymentsSepayTransactions.connectionId, connected.connection.id));
    const otherEvent = creator.event(loser.reference, { id: (BigInt(event.id) + 1n).toString() });
    await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, otherEvent));
    const [otherInbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(and(
      eq(schema.paymentsSepayInbox.connectionId, connected.connection.id), eq(schema.paymentsSepayInbox.providerEventId, otherEvent.id)));
    const [loserIntent] = await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, loser.id));
    // Exercise the database-wide canonical identity independently of inbox dedup.
    await expect(fixture.db.insert(schema.paymentsSepayTransactions).values({ ...canonical!, id: randomUUID(),
      inboxId: otherInbox!.id, paymentIntentId: loser.id, referenceHash: loserIntent!.referenceHash }))
      .rejects.toMatchObject({ cause: { code: "23505", constraint_name: "sepay_transaction_identity_uidx" } });
    const altered = creator.event(loser.reference, { id: event.id });
    expect(await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, altered))).toBe("conflict");
    expect(await reconciliation.processInbox(inbox!.id)).toBe("confirmed");
    const confirmations = await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.creatorUserId, creator.actor.userId));
    expect(confirmations).toHaveLength(1); expect(confirmations[0]?.paymentIntentId).toBe(winner.id);
    const transactions = await fixture.db.select().from(schema.paymentsSepayTransactions).where(eq(schema.paymentsSepayTransactions.connectionId, connected.connection.id));
    expect(transactions).toHaveLength(1); expect(transactions[0]?.providerTransactionId).toBe(event.id);
    const [unpaid] = await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, loser.id));
    expect(unpaid?.state).toBe("awaiting_transfer");
    expect((await facts(p)).slot.state).toBe(first === "tip" ? "reserved" : "occupied");
  });
  test("legacy retention skips an in-flight commission account and preserves its committed evidence", async () => {
    const creator = await fixture.creator(); const old = new Date("2020-01-01T00:00:00Z"); const applicationId = randomUUID();
    await fixture.db.insert(schema.creatorApplications).values({ id: applicationId, userId: creator.actor.userId,
      state: "withdrawn", version: 1, createdAt: old, updatedAt: old });
    await fixture.db.insert(schema.creatorApplicationRevisions).values({ id: randomUUID(), applicationId,
      revisionNumber: 1, proposedReceivingAccountId: creator.accountVersionId, createdAt: old, updatedAt: old });
    await fixture.db.insert(schema.systemRetentionHolds).values({ dataset: "application_content", subjectType: "creator_application",
      subjectId: applicationId, reasonCategory: "legal", referenceId: "synthetic-i6-retention-test", startsAt: old, createdAt: old });
    const sweep = () => runRetentionSweep({ db: fixture.db, now: creator.now(), mode: "enforce",
      policyVersion: "synthetic-i6-retention-test", enforcementPaused: false, batchSize: 100 });
    const entered = deferred<void>(); const release = deferred<void>();
    const creating = commissionFixture(fixture, creator, { afterPayment: async () => { entered.resolve(); await release.promise; } });
    await entered.promise;
    try {
      const results = await sweep();
      expect(results.find((row) => row.dataset === "receiving_accounts")).toMatchObject({ outcome: "completed", candidateCount: 1, processedCount: 0 });
    } finally { release.resolve(); }
    const p = await creating;
    for (const closed of [false, true]) {
      if (closed) await cancel(p);
      const results = await sweep();
      expect(results.find((row) => row.dataset === "receiving_accounts")).toMatchObject({ outcome: "completed", candidateCount: 1, protectedCount: 1, processedCount: 0 });
      const [account] = await fixture.db.select().from(schema.paymentsReceivingAccountOnboarding).where(eq(schema.paymentsReceivingAccountOnboarding.id, creator.accountVersionId));
      expect(account?.minimizedAt).toBeNull(); expect(account?.accountNumberEnvelope).toBeTruthy();
    }
  });
  test("account replacement waits for commission settlement and cannot erase the paid obligation", async () => {
    const creator = await fixture.creator();
    await fixture.db.update(schema.identityUsers).set({ emailVerified: true, emailVerifiedAt: creator.now(),
      emailVerificationProvenance: "password_email_challenge" }).where(eq(schema.identityUsers.id, creator.actor.userId));
    const paid = await commissionFixture(fixture, creator); const unpaid = await commissionFixture(fixture, creator); creator.advance(1_000);
    const entered = deferred<number>(); const release = deferred<void>();
    const port = createCommissionPaymentLifecyclePort({ eligibility });
    const confirming = service(paid, { ...port, confirmPayment: async (tx, input) => {
      const result = await port.confirmPayment(tx, input);
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      entered.resolve(backend!.pid); await release.promise; return result;
    } }).confirm(command(paid));
    const pid = await entered.promise;
    const accounts = createReceivingAccountService({ ...creator.common, supportedBanks: { "970436": "Vietcombank" } });
    const replacement = accounts.propose({ applicantUserId: creator.actor.userId, sessionId: creator.actor.sessionId,
      primaryAuthenticatedAt: creator.now(), idempotencyKey: randomUUID(), bankBin: "970436",
      accountNumber: creator.accountNumber === "009876543210" ? "009876543211" : "009876543210", accountHolderLabel: "SYNTHETIC CREATOR" });
    try {
      await expect.poll(async () => {
        const [row] = await fixture.db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        ) as waiting`);
        return row?.waiting;
      }, { timeout: 5_000 }).toBe(true);
    } finally { release.resolve(); }
    expect(await confirming).toMatchObject({ state: "confirmed" });
    expect((await replacement).referenceId).not.toBe(creator.accountVersionId);
    expect(await facts(paid)).toMatchObject({ order: { state: "in_progress" }, slot: { state: "occupied" }, intent: { state: "confirmed" } });
    await expect(service(unpaid).confirm(command(unpaid))).rejects.toMatchObject({ code: "evidence_mismatch" });
    const [old] = await fixture.db.select().from(schema.paymentsReceivingAccountOnboarding).where(eq(schema.paymentsReceivingAccountOnboarding.id, creator.accountVersionId));
    expect(old?.retiredAt).toEqual(creator.now()); expect(old?.accountNumberEnvelope).toBeTruthy();
  });
  test("a confirmation crossing the exact deadline loses to expiry without partial evidence", async () => {
    const p = await commissionFixture(fixture, await fixture.creator());
    p.creator.setNow(new Date(new Date(p.payment.expiresAt).getTime() - 1));
    const entered = deferred<number>(); const release = deferred<void>();
    const port = createCommissionPaymentLifecyclePort({ eligibility });
    const confirming = service(p, { ...port, lockSettlement: async (tx, input) => {
      const result = await port.lockSettlement(tx, input);
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      entered.resolve(backend!.pid); await release.promise; return result;
    } }).confirm(command(p)).then(() => ({ code: "unexpected_success" }), (error: { code: string }) => error);
    const pid = await entered.promise; p.creator.advance(1);
    const cleanup = createCommissionOrderMaintenanceService({ ...p.creator.common, applicationRevision: "synthetic-i6-expiry-race",
      identity: eligibility, trust: { lockCommissionPage: async () => true }, payments: p.payments });
    const expiring = cleanup.expireDue(500);
    try {
      await expect.poll(async () => {
        const [row] = await fixture.db.execute<{ waiting: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
        ) as waiting`);
        return row?.waiting;
      }, { timeout: 5_000 }).toBe(true);
    } finally { release.resolve(); }
    expect(await confirming).toMatchObject({ code: "intent_not_pending" }); await expiring;
    expect(await facts(p)).toMatchObject({ order: { state: "closed", closeReason: "payment_expired" },
      slot: { state: "released" }, intent: { state: "expired" }, confirmations: [] });
    expect((await facts(p)).events.filter((event) => event.type === "closed")).toHaveLength(1);
    expect((await cleanup.expireDue(500)).expired).toBe(0);
  });
});
