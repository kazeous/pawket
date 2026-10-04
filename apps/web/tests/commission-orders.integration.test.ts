import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COMMISSION_POLICY, createCommissionOrderService } from "@pawket/orders";
import { createCreatorCommissionPaymentService } from "@pawket/payments";
import { commandIds, deferred, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";
import { createCommissionOrderTestFixture } from "./commission-order-test-support.js";

const f = createCommissionOrderTestFixture("commission_orders");
beforeAll(f.initialize, 30_000); afterAll(f.dispose, 30_000);
type Setup = Awaited<ReturnType<typeof f.setup>>;
const detail = (s: Setup, orderId: string, actor = s.buyerActor) => s.service.getOrder({ actor, orderId });
async function accept(s: Setup, orderId: string, expectedVersion: number, quoteRevisionId: string | null = null) {
  return s.service.accept({ actor: quoteRevisionId ? s.buyerActor : s.creator.actor, orderId, expectedVersion, quoteRevisionId,
    policyRevisionId: s.policyId, acceptTerms: true, abuseKeyHash: fixtureHash(), ...commandIds() });
}
async function confirm(s: Setup, orderId: string) {
  const order = await detail(s, orderId);
  const service = createCreatorCommissionPaymentService({ ...s.creator.common, applicationRevision: "synthetic-i6", paymentsMode: "manual_only", recentAuthMs: 900_000,
    mfaAuthMs: 300_000, assurance: s.creator.assurance, commissions: s.service.paymentsLifecycle });
  return service.confirm({ actor: s.creator.actor, paymentIntentId: order.payment!.id, observedAmountVnd: order.payment!.amountVnd,
    observedTransferReference: order.payment!.reference, observedBankTransactionId: randomUUID(), attestedReceived: true, ...commandIds() });
}
async function rowsFor(s: Setup) {
  return { orders: await f.db.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.creatorUserId, s.creator.actor.userId)),
    intents: await f.db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.creatorUserId, s.creator.actor.userId)),
    slots: await f.db.select().from(schema.commissionReservations).where(eq(schema.commissionReservations.creatorUserId, s.creator.actor.userId)) };
}

describe("commission order workflows", () => {
  test.each(["fixed_immediate", "fixed_approval", "custom_quote"] as const)("%s reaches in_progress with immutable terms and provenance", async (route) => {
    const s = await f.setup(route); const command = s.request(); const orderId = await s.service.request(command);
    expect(await s.service.request(command)).toBe(orderId);
    if (route === "fixed_approval") { expect((await rowsFor(s)).slots).toHaveLength(0); s.creator.advance(60_000); await accept(s, orderId, 1); }
    if (route === "custom_quote") {
      expect((await rowsFor(s)).intents).toHaveLength(0); s.creator.advance(60_000);
      await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
      const quoted = await detail(s, orderId); s.creator.advance(60_000); await accept(s, orderId, 2, quoted.quote!.id);
    }
    const accepted = await detail(s, orderId); expect(accepted).toMatchObject({ state: "awaiting_payment", terms: s.terms, brief: command.brief });
    expect(accepted.payment?.instruction?.qrPayload).toBeTruthy(); expect(accepted.payment?.expiresAt).toBe(new Date(s.creator.now().getTime() + 86_400_000).toISOString());
    const [stored] = await f.db.select().from(schema.commissionBriefs).where(eq(schema.commissionBriefs.orderId, orderId));
    expect(JSON.stringify(stored)).not.toContain(command.brief.text);
    s.creator.advance(1_000); await confirm(s, orderId);
    expect(await detail(s, orderId)).toMatchObject({ state: "in_progress", dueAt: new Date(s.creator.now().getTime() + 7 * 86_400_000).toISOString(), payment: { state: "confirmed", instruction: null } });
    await expect(s.service.close({ actor: s.buyerActor, orderId, expectedVersion: accepted.version + 1, ...commandIds() })).rejects.toMatchObject({ code: "invalid_transition" });
    const acceptances = await f.db.select().from(schema.commissionAcceptances).where(eq(schema.commissionAcceptances.orderId, orderId));
    expect(acceptances).toHaveLength(2); expect(acceptances.find((item) => item.role === "creator")?.actorSessionId).toBe(s.creator.actor.sessionId);
  });
  test("fixed approval preserves the original price after the package is edited and republished", async () => {
    const s = await f.setup("fixed_approval"); const orderId = await s.service.request(s.request());
    await s.catalog.saveDraft({ actor: s.creator.actor, packageId: s.packageId, pageId: s.pageId, expectedVersion: 2, draft: { ...s.draft, terms: { ...s.terms, amountVnd: 600_000 } }, ...commandIds() });
    await s.catalog.changePackage({ actor: s.creator.actor, packageId: s.packageId, expectedVersion: 3, action: "publish", policyRevisionId: s.policyId, ...commandIds() });
    await accept(s, orderId, 1); expect((await detail(s, orderId)).payment?.amountVnd).toBe(500_000);
    expect((await detail(s, orderId)).package.revisionId).toBe(s.revisionId);
  });
  test("quote replacement rejects stale acceptance and retains a private immutable revision", async () => {
    const s = await f.setup("custom_quote"); const orderId = await s.service.request(s.request());
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
    const old = await detail(s, orderId);
    const changed = { ...s.terms, amountVnd: 650_000, scope: "Two portraits" };
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 2, terms: changed, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
    await expect(accept(s, orderId, 2, old.quote!.id)).rejects.toMatchObject({ code: "version_conflict" });
    await expect(accept(s, orderId, 3, old.quote!.id)).rejects.toMatchObject({ code: "version_conflict" });
    const current = await detail(s, orderId); await accept(s, orderId, 3, current.quote!.id);
    expect((await detail(s, orderId)).terms).toEqual(changed);
    const quotes = await f.db.select().from(schema.commissionQuoteRevisions).where(eq(schema.commissionQuoteRevisions.orderId, orderId));
    expect(quotes).toHaveLength(2); expect(JSON.stringify(quotes)).not.toContain(changed.scope);
    const recent = await s.service.listQuoteHistory({ actor: s.buyerActor, orderId, limit: 1 });
    expect(recent.items[0]).toMatchObject({ revisionNumber: 2, terms: changed }); expect(recent.nextBeforeRevision).toBe(2);
    const earlier = await s.service.listQuoteHistory({ actor: s.creator.actor, orderId, beforeRevision: recent.nextBeforeRevision!, limit: 1 });
    expect(earlier.items[0]).toMatchObject({ revisionNumber: 1, terms: s.terms }); expect(earlier.nextBeforeRevision).toBeNull();
    expect(JSON.stringify(recent)).not.toMatch(/actorSessionId|requestId|Envelope/u);
    const timeline = await s.service.listTimeline({ actor: s.buyerActor, orderId, limit: 2 });
    expect(timeline.items.map((item) => item.version)).toEqual([4, 3]); expect(timeline.nextBeforeVersion).toBe(3);
    expect((await s.service.listTimeline({ actor: s.buyerActor, orderId, beforeVersion: 3 })).items.map((item) => item.version)).toEqual([2, 1]);
  });
  test.each(["quote", "accept"] as const)("concurrent quote replacement/acceptance serializes when %s holds the creator fence", async (winner) => {
    const s = await f.setup("custom_quote"); const orderId = await s.service.request(s.request());
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
    const old = await detail(s, orderId); const entered = deferred<number>(); const release = deferred<void>();
    const controlled = createCommissionOrderService({ ...s.input, catalog: { ...s.catalog, getIntakePackage: async (tx, command) => {
      const data = await s.catalog.getIntakePackage(tx, command); const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      entered.resolve(pid!.pid); await release.promise; return data;
    } } });
    const replace = (service: typeof s.service) => service.quote({ actor: s.creator.actor, orderId, expectedVersion: 2,
      terms: { ...s.terms, amountVnd: 650_000 }, ttlMs: COMMISSION_POLICY.defaultQuoteTtlMs, ...commandIds() });
    const commit = (service: typeof s.service) => service.accept({ actor: s.buyerActor, orderId, expectedVersion: 2, quoteRevisionId: old.quote!.id,
      policyRevisionId: s.policyId, acceptTerms: true, abuseKeyHash: fixtureHash(), ...commandIds() });
    const first = winner === "quote" ? replace(controlled) : commit(controlled);
    const pid = await entered.promise;
    const second = winner === "quote" ? commit(s.service) : replace(s.service);
    const results = Promise.allSettled([first, second]);
    try {
      const deadline = Date.now() + 3_000; let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = await f.client`select exists(select 1 from pg_locks held join pg_locks contender
          on contender.locktype = held.locktype and contender.database = held.database and contender.classid = held.classid
          and contender.objid = held.objid and contender.objsubid = held.objsubid
          where held.pid = ${pid} and held.locktype = 'advisory' and held.granted and not contender.granted) as waiting`;
        waiting = row!.waiting === true;
      }
      expect(waiting).toBe(true);
    } finally { release.resolve(); }
    expect(await results).toMatchObject([{ status: "fulfilled" }, { status: "rejected", reason: { code: "version_conflict" } }]);
    const rows = await rowsFor(s); const current = await detail(s, orderId);
    expect(current.state).toBe(winner === "quote" ? "quoted" : "awaiting_payment");
    expect(rows.intents).toHaveLength(winner === "quote" ? 0 : 1); expect(rows.slots).toHaveLength(rows.intents.length);
    if (winner === "accept") expect(current.payment?.amountVnd).toBe(500_000);
    else expect(current.terms?.amountVnd).toBe(650_000);
  });
  test("only the owning buyer and creator can see private content and act in their assigned role", async () => {
    const s = await f.setup("fixed_approval"); const orderId = await s.service.request(s.request()); const stranger = await s.buyer();
    await expect(detail(s, orderId, stranger)).rejects.toMatchObject({ code: "not_authorized" });
    await expect(s.service.listQuoteHistory({ actor: stranger, orderId })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(s.service.listTimeline({ actor: stranger, orderId })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(detail(s, randomUUID(), stranger)).rejects.toMatchObject({ code: "not_authorized" });
    await expect(s.service.request(s.request(s.creator.actor))).rejects.toMatchObject({ code: "not_available" });
    await expect(s.service.accept({ actor: s.buyerActor, orderId, expectedVersion: 1, quoteRevisionId: null, policyRevisionId: s.policyId,
      acceptTerms: true, abuseKeyHash: fixtureHash(), ...commandIds() })).rejects.toMatchObject({ code: "not_authorized" });
    expect((await s.service.listOrders({ actor: stranger, role: "buyer" })).items).toEqual([]);
    expect((await s.service.listOrders({ actor: s.creator.actor, role: "creator" })).items[0]?.id).toBe(orderId);
    s.users.delete(s.buyerActor.userId); await expect(detail(s, orderId)).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("two buyers competing for the last slot create one complete order and one capacity error", async () => {
    const s = await f.setup(); await s.catalog.saveSettings({ actor: s.creator.actor, expectedVersion: 1, enabled: true, capacityLimit: 1, ...commandIds() });
    const second = await s.buyer();
    const results = await Promise.allSettled([s.service.request(s.request()), s.service.request(s.request(second))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "capacity_full" } });
    const rows = await rowsFor(s); expect(rows.orders).toHaveLength(1); expect(rows.intents).toHaveLength(1); expect(rows.slots).toHaveLength(1);
  });
  test("open pair quota includes pending requests; withdrawal releases room without creating payment", async () => {
    const s = await f.setup("custom_quote"); const first = await s.service.request(s.request());
    await s.service.request(s.request()); await s.service.request(s.request());
    await expect(s.service.request(s.request())).rejects.toMatchObject({ code: "request_limit" });
    const close = { actor: s.buyerActor, orderId: first, expectedVersion: 1, ...commandIds() };
    await s.service.close(close); expect(await s.service.close(close)).toBe(first);
    await s.service.request(s.request()); expect((await rowsFor(s)).intents).toHaveLength(0);
  });
  test("failure after intent insertion rolls back every order fact and the command can retry", async () => {
    const s = await f.setup(); const command = s.request();
    const failing = createCommissionOrderService({ ...s.input, payments: { ...s.payments, createIntent: async (...args: Parameters<typeof s.payments.createIntent>) => {
      await s.payments.createIntent(...args); throw new Error("synthetic failure after payment write");
    } } });
    await expect(failing.request(command)).rejects.toMatchObject({ code: "dependency_unavailable" });
    expect(await rowsFor(s)).toEqual({ orders: [], intents: [], slots: [] });
    const orderId = await s.service.request(command); expect(await s.service.request(command)).toBe(orderId);
  });
  test("request expiry wins at the exact deadline, and worker cleanup continues during pauses", async () => {
    const s = await f.setup("fixed_approval"); const orderId = await s.service.request(s.request()); s.creator.advance(COMMISSION_POLICY.requestTtlMs);
    await expect(accept(s, orderId, 1)).rejects.toMatchObject({ code: "expired" });
    const paused = createCommissionOrderService({ ...s.input, intakeMode: "disabled", paymentsMode: "disabled" });
    const result = await paused.expireDue(); expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await detail(s, orderId)).toMatchObject({ state: "closed", closeReason: "request_expired", payment: null });
    const again = await paused.expireDue(); expect(again.expired).toBe(0);
  });
  test("claim does not extend the 24-hour payment deadline and expiry releases exactly one slot", async () => {
    const s = await f.setup(); const orderId = await s.service.request(s.request());
    await s.service.claimTransfer({ actor: s.buyerActor, orderId, expectedVersion: 1, ...commandIds() }); s.creator.advance(COMMISSION_POLICY.paymentTtlMs);
    const expired = await detail(s, orderId); expect(expired.payment).toMatchObject({ state: "expired", instruction: null });
    await s.service.expireDue(); expect(await detail(s, orderId)).toMatchObject({ state: "closed", closeReason: "payment_expired" });
    const rows = await rowsFor(s); expect(rows.slots[0]?.state).toBe("released"); expect(rows.intents[0]?.state).toBe("expired");
    await expect(confirm(s, orderId)).rejects.toMatchObject({ code: "not_available" });
  });
  test("quote renewal has an absolute 30-day cap and cannot create less than one hour of validity", async () => {
    const s = await f.setup("custom_quote"); const createdAt = s.creator.now(); const orderId = await s.service.request(s.request());
    s.creator.advance(6 * 86_400_000);
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 1, terms: s.terms, ttlMs: COMMISSION_POLICY.maximumQuoteTtlMs, ...commandIds() });
    s.creator.advance(13 * 86_400_000);
    await s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 2, terms: s.terms, ttlMs: COMMISSION_POLICY.maximumQuoteTtlMs, ...commandIds() });
    expect((await detail(s, orderId)).expiresAt).toBe(new Date(createdAt.getTime() + 30 * 86_400_000).toISOString());
    s.creator.setNow(new Date(createdAt.getTime() + 30 * 86_400_000 - 3_599_999));
    await expect(s.service.quote({ actor: s.creator.actor, orderId, expectedVersion: 3, terms: s.terms, ttlMs: COMMISSION_POLICY.maximumQuoteTtlMs, ...commandIds() })).rejects.toMatchObject({ code: "expired" });
  });
  test("cancellation commits payment rejection and slot release; intake pause retains authorized history", async () => {
    const s = await f.setup(); const command = s.request(); const orderId = await s.service.request(command);
    const paused = createCommissionOrderService({ ...s.input, intakeMode: "disabled", paymentsMode: "disabled" });
    expect(await paused.request(command)).toBe(orderId);
    await expect(paused.request(s.request())).rejects.toMatchObject({ code: "intake_disabled" });
    expect((await paused.getOrder({ actor: s.buyerActor, orderId })).payment?.instruction).toBeNull();
    await paused.close({ actor: s.buyerActor, orderId, expectedVersion: 1, ...commandIds() });
    const rows = await rowsFor(s); expect(rows.orders[0]?.closeReason).toBe("buyer_cancelled"); expect(rows.slots[0]?.state).toBe("released");
    expect(rows.intents[0]).toMatchObject({ state: "rejected", rejectionReason: "buyer_cancelled" });
    expect(await f.db.select().from(schema.commissionEvents).where(and(eq(schema.commissionEvents.orderId, orderId), eq(schema.commissionEvents.type, "closed")))).toHaveLength(1);
  });
});
