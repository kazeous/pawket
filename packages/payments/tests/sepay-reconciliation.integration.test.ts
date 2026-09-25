import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createSePayReconciliationService } from "../src/sepay-reconciliation-service.js";
import { SePayProviderError } from "../src/sepay-provider.js";
import { commandIds, createSePayIntegrationFixture, deferred, schema } from "./sepay-integration-fixture.js";

const fixture = createSePayIntegrationFixture("reconciliation");
beforeAll(fixture.initialize, 30_000);
afterAll(fixture.dispose, 30_000);

async function pendingProviderTip() {
  const creator = await fixture.creator(); const connected = await creator.connect(); const cutover = await creator.cutover();
  creator.advance(1_000); const intent = await creator.createIntent(cutover.id);
  creator.advance(1_000); const event = creator.event(intent.reference);
  await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, event));
  const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
  if (!inbox) throw new Error("Missing synthetic accepted event");
  return { creator, connected, cutover, intent, event, inbox };
}
type Pending = Awaited<ReturnType<typeof pendingProviderTip>>;
async function financialFacts(pending: Pending) {
  return {
    intent: (await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, pending.intent.id)))[0],
    tip: (await fixture.db.select().from(schema.tips).where(eq(schema.tips.id, pending.intent.tipId)))[0],
    confirmations: await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, pending.intent.id)),
    transactions: await fixture.db.select().from(schema.paymentsSepayTransactions).where(eq(schema.paymentsSepayTransactions.paymentIntentId, pending.intent.id)),
    outbox: await fixture.db.select().from(schema.systemOutbox).where(and(eq(schema.systemOutbox.aggregateId, pending.intent.id), eq(schema.systemOutbox.eventType, "tip.confirmed.v1"))),
    decisions: await fixture.db.select().from(schema.paymentsSepayDecisions).where(eq(schema.paymentsSepayDecisions.inboxId, pending.inbox.id)),
    processing: (await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, pending.inbox.id)))[0],
  };
}
async function expectUnsettled(pending: Pending) {
  const facts = await financialFacts(pending);
  expect(facts.intent?.state).toBe("awaiting_transfer"); expect(facts.tip?.state).toBe("awaiting_payment");
  expect(facts.confirmations).toHaveLength(0); expect(facts.transactions).toHaveLength(0); expect(facts.outbox).toHaveLength(0);
  expect(facts.decisions.filter((row) => row.action === "confirmed")).toHaveLength(0);
  return facts;
}

describe("SePay exact settlement with real transactions", () => {
  test("atomically confirms exact post-cutover evidence, completes Tips and emits one confirmed event under replay", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    expect(await creator.reconciliation.processInbox(pending.inbox.id)).toBe("confirmed");
    expect(await creator.reconciliation.processInbox(pending.inbox.id)).toBe("confirmed");
    const facts = await financialFacts(pending);
    expect(facts.intent).toMatchObject({ state: "confirmed", settlementLane: "provider_bound", closedAt: creator.now() });
    expect(facts.tip).toMatchObject({ state: "completed", closedAt: creator.now() });
    expect(facts.transactions).toHaveLength(1);
    expect(facts.transactions[0]).toMatchObject({ providerEnvironment: "test", providerTenantId: creator.binding.tenantId,
      providerAccountId: creator.binding.accountId, providerTransactionId: pending.event.id, paymentIntentId: pending.intent.id });
    expect(facts.confirmations).toHaveLength(1);
    expect(facts.confirmations[0]).toMatchObject({ source: "sepay_automatic", actorSessionId: null, primaryAuthenticatedAt: null,
      attestedReceived: null, bankTransactionFingerprint: null, workerIdentity: "synthetic-worker", providerTransactionId: facts.transactions[0]!.id });
    expect(facts.outbox).toHaveLength(1);
    expect(facts.outbox[0]?.payload).toMatchObject({ paymentIntentId: pending.intent.id, tipId: pending.intent.tipId, confirmationId: facts.confirmations[0]!.id });
    expect(facts.processing).toMatchObject({ status: "confirmed", leaseOwner: null });
    expect(facts.decisions).toMatchObject([{ action: "confirmed", actorUserId: null }]);
    expect(creator.provider.readback).toHaveBeenCalledTimes(1);
    expect(creator.tips.completeTip).toHaveBeenCalledTimes(1);
  });

  test("a Tips domain refusal rolls back reservation, confirmation and intent before recording the failed review", async () => {
    const pending = await pendingProviderTip();
    pending.creator.tips.completeTip.mockResolvedValueOnce(false);
    expect(await pending.creator.reconciliation.processInbox(pending.inbox.id)).toBe("review_required");
    const facts = await expectUnsettled(pending);
    expect(facts.processing).toMatchObject({ status: "review_required", lastErrorCode: "intent_not_pending" });
    expect(facts.decisions).toMatchObject([{ action: "review_required" }]);
  });

  test("a final outbox failure rolls back the financial transaction and can recover from the durable inbox", async () => {
    const pending = await pendingProviderTip();
    await fixture.client.unsafe(`create function reject_sepay_confirmation_outbox() returns trigger language plpgsql as $$ begin
      if NEW.event_type = 'tip.confirmed.v1' then raise exception 'synthetic outbox unavailable'; end if; return NEW; end $$`);
    await fixture.client.unsafe("create trigger reject_sepay_confirmation_outbox before insert on system_outbox for each row execute function reject_sepay_confirmation_outbox()");
    try {
      expect(await pending.creator.reconciliation.processInbox(pending.inbox.id)).toBe("deferred");
      const facts = await expectUnsettled(pending);
      expect(facts.processing).toMatchObject({ status: "pending", lastErrorCode: "dependency_unavailable" });
    } finally {
      await fixture.client.unsafe("drop trigger reject_sepay_confirmation_outbox on system_outbox");
      await fixture.client.unsafe("drop function reject_sepay_confirmation_outbox()");
    }
    pending.creator.advance(60_000);
    expect(await pending.creator.reconciliation.recoverDue()).toBe(1);
    expect((await financialFacts(pending)).intent?.state).toBe("confirmed");
  });

  test("manual-only mode pauses automation but permits fresh provider review with genuine creator assurance", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const service = createSePayReconciliationService({ ...creator.reconciliationInput, paymentsMode: "manual_only" });
    expect(await service.processInbox(pending.inbox.id)).toBe("review_required");
    expect(creator.provider.readback).not.toHaveBeenCalled();
    const state = (await financialFacts(pending)).processing!;
    const command = { actor: creator.actor, inboxId: pending.inbox.id, expectedVersion: state.version,
      attestedReceived: true as const, reason: "Checked the synthetic bank receipt", ...commandIds() };
    expect(await service.confirmReviewed(command)).toBe("confirmed");
    expect(await service.confirmReviewed(command)).toBe("confirmed");
    await expect(service.confirmReviewed({ ...command, reason: "Changed after confirmation" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.confirmReviewed({ ...command, ...commandIds() })).rejects.toMatchObject({ code: "intent_not_pending" });
    const facts = await financialFacts(pending);
    expect(facts.confirmations).toHaveLength(1);
    expect(facts.confirmations[0]).toMatchObject({ source: "creator_reviewed_sepay", actorSessionId: creator.actor.sessionId,
      primaryAuthenticatedAt: creator.now(), attestedReceived: true, workerIdentity: null, bankTransactionFingerprint: null });
    expect(creator.provider.readback).toHaveBeenCalledTimes(1);
    expect(facts.decisions.find((row) => row.action === "confirmed")).toMatchObject({ actorUserId: creator.actor.userId, actorSessionId: creator.actor.sessionId });
  });

  test("concurrent worker and creator review cannot reserve or complete the same evidence twice", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const entered = deferred<void>(); const resume = deferred<void>();
    const original = creator.provider.readback.getMockImplementation()!;
    creator.provider.readback.mockImplementationOnce(async (command) => { entered.resolve(); await resume.promise; return original(command); });
    const automatic = creator.reconciliation.processInbox(pending.inbox.id);
    await entered.promise;
    const state = (await financialFacts(pending)).processing!;
    expect(await creator.reconciliation.confirmReviewed({ actor: creator.actor, inboxId: pending.inbox.id, expectedVersion: state.version,
      attestedReceived: true, reason: "Review racing with the worker", ...commandIds() })).toBe("unchanged");
    resume.resolve();
    expect(await automatic).toBe("confirmed");
    const facts = await financialFacts(pending);
    expect(facts.transactions).toHaveLength(1); expect(facts.confirmations).toHaveLength(1); expect(facts.outbox).toHaveLength(1);
    expect(creator.provider.readback).toHaveBeenCalledTimes(1);
  });

  test.each(["pause", "disconnect"] as const)("a %s during independent readback fences the final commit", async (action) => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const entered = deferred<void>(); const resume = deferred<void>(); const original = creator.provider.readback.getMockImplementation()!;
    creator.provider.readback.mockImplementationOnce(async (command) => { entered.resolve(); await resume.promise; return original(command); });
    const processing = creator.reconciliation.processInbox(pending.inbox.id);
    await entered.promise;
    await creator.change(action); resume.resolve();
    expect(await processing).toBe("review_required");
    const facts = await expectUnsettled(pending);
    expect(facts.processing?.lastErrorCode).toBe("version_conflict");
    expect(creator.tips.completeTip).not.toHaveBeenCalled();
  });

  test("expiry at final commit cannot be bypassed by a previously valid provider response", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const original = creator.provider.readback.getMockImplementation()!;
    creator.provider.readback.mockImplementationOnce(async (command) => { const result = await original(command); creator.setNow(pending.intent.expiresAt); return result; });
    expect(await creator.reconciliation.processInbox(pending.inbox.id)).toBe("review_required");
    await expectUnsettled(pending);
    expect(creator.tips.completeTip).not.toHaveBeenCalled();
  });

  test.each([
    ["partial transfer", (row: { amountVnd: number }) => ({ ...row, amountVnd: 49_999 }), "amount_mismatch"],
    ["excess transfer", (row: { amountVnd: number }) => ({ ...row, amountVnd: 50_001 }), "amount_mismatch"],
  ] as const)("keeps %s in review without a financial override", async (_label, change, reason) => {
    const pending = await pendingProviderTip(); const original = pending.creator.provider.readback.getMockImplementation()!;
    pending.creator.provider.readback.mockImplementationOnce(async (command) => {
      const result = await original(command);
      if (result.kind !== "complete") throw new Error("Invalid synthetic fixture");
      return { ...result, transactions: result.transactions.map((row) => ({ ...row, ...change(row) })) };
    });
    expect(await pending.creator.reconciliation.processInbox(pending.inbox.id)).toBe("review_required");
    expect((await expectUnsettled(pending)).processing?.lastErrorCode).toBe(reason);
  });

  test("incomplete provider pagination is evidence for review, never confirmation", async () => {
    const pending = await pendingProviderTip();
    pending.creator.provider.readback.mockResolvedValue({ kind: "inconclusive", reason: "pagination_changed" });
    expect(await pending.creator.reconciliation.processInbox(pending.inbox.id)).toBe("review_required");
    expect((await expectUnsettled(pending)).processing?.lastErrorCode).toBe("readback_inconclusive");
  });

  test("a signed event for a historical manual intent does not invoke provider readback or complete it", async () => {
    const creator = await fixture.creator(); const connected = await creator.connect(); const intent = await creator.createIntent();
    await creator.inbox.receive(creator.signed(connected.connection.id, connected.secret, creator.event(intent.reference)));
    const [inbox] = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, connected.connection.id));
    // Creator review can inspect the manual observation; it cannot promote its settlement lane.
    const result = await creator.reconciliation.confirmReviewed({ actor: creator.actor, inboxId: inbox!.id, expectedVersion: 1,
      attestedReceived: true, reason: "Checking a historical manual observation", ...commandIds() });
    expect(result).toBe("review_required");
    expect(creator.provider.readback).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, intent.id)))[0]).toMatchObject({ state: "awaiting_transfer", settlementLane: "manual_attested" });
    expect(await fixture.db.select().from(schema.paymentConfirmations).where(eq(schema.paymentConfirmations.paymentIntentId, intent.id))).toHaveLength(0);
  });

  test("contradictory replay during provider readback prevents a stale worker from committing", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const entered = deferred<void>(); const resume = deferred<void>(); const original = creator.provider.readback.getMockImplementation()!;
    creator.provider.readback.mockImplementationOnce(async (command) => { entered.resolve(); await resume.promise; return original(command); });
    const processing = creator.reconciliation.processInbox(pending.inbox.id);
    await entered.promise;
    await creator.inbox.receive(creator.signed(pending.connected.connection.id, pending.connected.secret, { ...pending.event, transferAmount: 90_000 }));
    resume.resolve();
    expect(await processing).toBe("review_required");
    const facts = await expectUnsettled(pending);
    expect(facts.processing?.lastErrorCode).toBe("contradictory_replay");
  });

  test("bounded provider retries respect Retry-After then stop for review", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const service = createSePayReconciliationService({ ...creator.reconciliationInput, maxAttempts: 2 });
    creator.provider.readback.mockRejectedValue(new SePayProviderError("rate_limited", 300));
    expect(await service.processInbox(pending.inbox.id)).toBe("deferred");
    let facts = await expectUnsettled(pending);
    expect(facts.processing?.availableAt.getTime()).toBe(creator.now().getTime() + 300_000);
    expect(await service.processInbox(pending.inbox.id)).toBe("unchanged");
    expect(creator.provider.readback).toHaveBeenCalledTimes(1);
    creator.advance(300_000);
    expect(await service.processInbox(pending.inbox.id)).toBe("review_required");
    expect(await service.processInbox(pending.inbox.id)).toBe("unchanged");
    facts = await expectUnsettled(pending);
    expect(facts.processing).toMatchObject({ status: "review_required", attempts: 2, lastErrorCode: "rate_limited" });
    expect(creator.provider.readback).toHaveBeenCalledTimes(2);
  });

  test("another tip waits for the shared refresh lease and settles after refresh without manual review", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    creator.advance(3_580_000);
    const another = await creator.createIntent(pending.cutover.id);
    await creator.inbox.receive(creator.signed(pending.connected.connection.id, pending.connected.secret, creator.event(another.reference)));
    const inboxes = await fixture.db.select().from(schema.paymentsSepayInbox).where(eq(schema.paymentsSepayInbox.connectionId, pending.connected.connection.id));
    const second = inboxes.find((row) => row.id !== pending.inbox.id)!;
    const entered = deferred<void>(); const response = deferred<Awaited<ReturnType<typeof creator.provider.refresh>>>();
    creator.provider.refresh.mockImplementationOnce(async () => { entered.resolve(); return response.promise; });
    const first = creator.reconciliation.processInbox(pending.inbox.id);
    await entered.promise;
    expect(await creator.reconciliation.processInbox(second.id)).toBe("deferred");
    expect((await fixture.db.select().from(schema.paymentsSepayProcessing).where(eq(schema.paymentsSepayProcessing.inboxId, second.id)))[0])
      .toMatchObject({ status: "pending", availableAt: new Date(creator.now().getTime() + 30_000), lastErrorCode: "provider_unavailable" });
    response.resolve({ accessToken: "refreshed-synthetic-access", refreshToken: "rotated-synthetic-refresh", expiresAt: new Date(creator.now().getTime() + 3_600_000), scopes: ["bank-account:read", "transaction:read"] });
    expect(await first).toBe("confirmed");
    creator.advance(30_000);
    expect(await creator.reconciliation.processInbox(second.id)).toBe("confirmed");
    expect(creator.provider.refresh).toHaveBeenCalledTimes(1);
    expect(await fixture.db.select().from(schema.paymentsSepayDecisions).where(and(eq(schema.paymentsSepayDecisions.inboxId, second.id), eq(schema.paymentsSepayDecisions.action, "review_required")))).toHaveLength(0);
  });

  test("recovers an expired processing lease but never steals an active one", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    await fixture.db.update(schema.paymentsSepayProcessing).set({ status: "processing", leaseOwner: randomUUID(), version: 2, attempts: 1, updatedAt: creator.now(),
      leaseExpiresAt: new Date(creator.now().getTime() + 10_000) }).where(eq(schema.paymentsSepayProcessing.inboxId, pending.inbox.id));
    expect(await creator.reconciliation.processInbox(pending.inbox.id)).toBe("unchanged");
    creator.advance(10_001);
    expect(await creator.reconciliation.processInbox(pending.inbox.id)).toBe("confirmed");
    expect((await financialFacts(pending)).processing?.attempts).toBe(2);
  });

  test("disabled payments and a stale or foreign actor cannot mutate financial state", async () => {
    const pending = await pendingProviderTip(); const { creator } = pending;
    const disabled = createSePayReconciliationService({ ...creator.reconciliationInput, paymentsMode: "disabled" });
    await expect(disabled.processInbox(pending.inbox.id)).rejects.toMatchObject({ code: "payments_disabled" });
    await expect(creator.reconciliation.confirmReviewed({ actor: { ...creator.actor, sessionId: "revoked-session" }, inboxId: pending.inbox.id,
      expectedVersion: 1, attestedReceived: true, reason: "Stale session review", ...commandIds() })).rejects.toMatchObject({ code: "not_authorized" });
    const other = await fixture.creator();
    const foreign = createSePayReconciliationService({ ...creator.reconciliationInput, assurance: other.assurance });
    await expect(foreign.confirmReviewed({ actor: other.actor, inboxId: pending.inbox.id, expectedVersion: 1,
      attestedReceived: true, reason: "Other creator review", ...commandIds() })).rejects.toMatchObject({ code: "not_available" });
    await expectUnsettled(pending);
    expect(creator.provider.readback).not.toHaveBeenCalled();
  });
});
