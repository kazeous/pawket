import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importConfiguredBusinessCalendarVersion, calculateStoredBusinessDayDeadline } from "@pawket/database";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureKeyring, fixtureHash, schema } from "./sepay-integration-fixture.js";
import { createCommissionRefundPort } from "../src/commission-refund-port.js";
import { createCommissionPaymentFactsPort } from "../src/commission-payment-facts.js";
import { COMMISSION_REFUND_POLICY, createRefundReference, normalizeBankReference } from "../src/commission-refund-policy.js";

const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Refund port tests require a dedicated local test database");
const fixture = createSePayIntegrationFixture("refund_port");
const calendarVersion = "vn-refund-test";
beforeAll(async () => {
  await fixture.initialize();
  await fixture.db.transaction((tx) => importConfiguredBusinessCalendarVersion(tx, { version: calendarVersion, holidayDates: ["2026-10-12"] }));
}, 30_000); afterAll(fixture.dispose, 30_000);
const at = new Date("2026-10-09T04:00:00Z");
const port = createCommissionRefundPort({ keyring: fixtureKeyring, calendarVersion });
const command = (obligationId: string) => ({ obligationId, actor: null, requestId: randomUUID(), at });
// Build a valid paid/expired graph locally: Payments tests have a package-scoped rootDir.
async function paymentOrder(state: "confirmed" | "expired" = "confirmed") {
  const createdAt = new Date("2026-09-26T04:00:00Z"); const expiresAt = new Date(createdAt.getTime() + 86_400_000);
  const closedAt = state === "confirmed" ? new Date(createdAt.getTime() + 1_000) : expiresAt;
  const c = await fixture.creator(); const creator = c.actor;
  const buyer = { userId: `refund-buyer-${randomUUID()}`, sessionId: "synthetic-buyer" };
  const orderId = randomUUID(); const paymentIntentId = randomUUID(); const pageId = randomUUID(); const packageId = randomUUID(); const revisionId = randomUUID();
  const referenceHash = fixtureHash();
  await fixture.db.insert(schema.identityUsers).values({ id: buyer.userId, name: "Synthetic buyer", email: `${buyer.userId}@example.invalid`,
    canonicalEmail: `${buyer.userId}@example.invalid`, createdAt, updatedAt: createdAt });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creator.userId, initializedFromRevisionId: randomUUID(), createdAt, updatedAt: createdAt });
  await fixture.db.insert(schema.creatorCommissionSettings).values({ creatorUserId: creator.userId, enabled: true, capacityLimit: 1, createdAt, updatedAt: createdAt });
  const terms = { amountVnd: 500_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7, scope: "Portrait", deliverables: "PNG",
    usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "fixed_immediate" as const,
    briefInstructions: "Describe the portrait", terms, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId: creator.userId, pageId, draft, createdAt, updatedAt: createdAt });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: revisionId, packageId, creatorUserId: creator.userId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: creator.sessionId, requestId: randomUUID(), publishedAt: createdAt });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: revisionId }).where(eq(schema.commissionPackages.id, packageId));
  await fixture.db.transaction(async (tx) => {
    await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId: creator.userId, buyerUserId: buyer.userId, packageId, packageRevisionId: revisionId,
      route: "fixed_immediate", state: "awaiting_payment", amountVnd: terms.amountVnd, acceptedAt: createdAt, expiresAt, createdAt, updatedAt: createdAt });
    await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: fixtureEnvelope("commission_briefs", orderId, "text", "Synthetic private brief"),
      linksEnvelope: fixtureEnvelope("commission_briefs", orderId, "links", "[]"), buyerSessionId: buyer.sessionId, requestId: randomUUID(), createdAt });
    for (const role of ["buyer", "creator"] as const) await tx.insert(schema.commissionAcceptances).values({ id: randomUUID(), orderId,
      actorUserId: role === "buyer" ? buyer.userId : creator.userId, actorSessionId: role === "buyer" ? buyer.sessionId : creator.sessionId,
      role, packageRevisionId: revisionId, policyRevisionId: terms.policyRevisionId, requestId: randomUUID(), acceptedAt: createdAt });
    await tx.insert(schema.commissionTermsSnapshots).values({ orderId, packageRevisionId: revisionId, policyRevisionId: terms.policyRevisionId,
      amountVnd: terms.amountVnd, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
      scopeEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "scope", "Portrait"),
      deliverablesEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "deliverables", "PNG"),
      usageRightsEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "usage_rights", "Personal"),
      artistTermsEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "artist_terms", "Synthetic terms"),
      buyerAcceptedAt: createdAt, creatorAcceptedAt: createdAt, createdAt });
    await tx.insert(schema.commissionReservations).values({ orderId, creatorUserId: creator.userId, reservedAt: createdAt });
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "awaiting_payment", requestId: randomUUID(), occurredAt: createdAt });
    await tx.insert(schema.paymentIntents).values({ id: paymentIntentId, purpose: "commission", commissionOrderId: orderId, creatorUserId: creator.userId,
      amountVnd: terms.amountVnd, referenceHash, referenceEnvelope: fixtureEnvelope("payment_intents", paymentIntentId, "transfer_reference", "SYNTHETIC1"),
      destinationEnvelope: fixtureEnvelope("payment_intents", paymentIntentId, "destination", "Synthetic private destination"), accountVersionId: c.accountVersionId,
      abuseKeyHash: fixtureHash(), expiresAt, requestId: randomUUID(), createdAt, updatedAt: createdAt });
  });
  await fixture.db.transaction(async (tx) => {
    if (state === "confirmed") await tx.insert(schema.paymentConfirmations).values({ id: randomUUID(), paymentIntentId, creatorUserId: creator.userId,
      accountVersionId: c.accountVersionId, observedAmountVnd: terms.amountVnd, referenceHash, bankTransactionFingerprint: fixtureHash(), attestedReceived: true,
      actorSessionId: creator.sessionId, primaryAuthenticatedAt: closedAt, confirmedAt: closedAt, requestId: randomUUID(), idempotencyKeyHash: fixtureHash() });
    await tx.update(schema.paymentIntents).set({ state, closedAt, updatedAt: closedAt }).where(eq(schema.paymentIntents.id, paymentIntentId));
    await tx.update(schema.commissionOrders).set({ version: 2, updatedAt: closedAt,
      ...(state === "confirmed" ? { state: "in_progress", confirmedAt: closedAt, dueAt: new Date(closedAt.getTime() + 604_800_000) }
        : { state: "closed", closeReason: "payment_expired", closedAt }) }).where(eq(schema.commissionOrders.id, orderId));
    await tx.update(schema.commissionReservations).set(state === "confirmed" ? { state: "occupied", occupiedAt: closedAt } : { state: "released", releasedAt: closedAt })
      .where(eq(schema.commissionReservations.orderId, orderId));
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 2, type: state === "confirmed" ? "in_progress" : "closed",
      reason: state === "confirmed" ? null : "payment_expired", requestId: randomUUID(), occurredAt: closedAt });
  });
  return { orderId, creator, buyer, confirmationCommand: { paymentIntentId } };
}
async function create() {
  const p = await paymentOrder();
  const input = { orderId: p.orderId, paymentIntentId: p.confirmationCommand.paymentIntentId, creatorUserId: p.creator.userId,
    buyerUserId: p.buyer.userId, source: "agreement" as const, sourceId: randomUUID(), amountVnd: 500_000, requestId: randomUUID(), at };
  const result = await fixture.db.transaction((tx) => port.createObligation(tx, input));
  return { ...result, input, p };
}
const row = (id: string) => fixture.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, id)).then((rows) => rows[0]!);
async function destination(id: string) {
  await fixture.db.transaction(async (tx) => {
    const current = await row(id);
    await tx.update(schema.commissionRefundObligations).set({ state: "awaiting_send", destinationBankBin: "970436", destinationBankName: "Vietcombank",
      destinationAccountEnvelope: fixtureEnvelope("commission_refund_obligation", id, "account_number", "000000123456"),
      destinationHolderEnvelope: fixtureEnvelope("commission_refund_obligation", id, "holder_name", "SYNTHETIC BUYER"), destinationSuffix: "3456",
      destinationEnteredAt: at, dueAt: await calculateStoredBusinessDayDeadline(tx, { from: at, businessDays: 5, calendarVersion }),
      version: current.version + 1, updatedAt: at }).where(eq(schema.commissionRefundObligations.id, id));
  });
}
async function sent(c: Awaited<ReturnType<typeof create>>) {
  await destination(c.obligationId); const id = randomUUID();
  await fixture.db.transaction(async (tx) => {
    const current = await row(c.obligationId);
    await tx.insert(schema.commissionRefundSends).values({ id, obligationId: c.obligationId, transferDate: "2026-10-09",
      referenceEnvelope: fixtureEnvelope("commission_refund_send", id, "bank_reference", "SYNTHETIC-1"), actorUserId: c.p.creator.userId,
      actorSessionId: c.p.creator.sessionId, requestId: randomUUID(), recordedAt: at });
    await tx.update(schema.commissionRefundObligations).set({ state: "sent", currentSendId: id, confirmBy: new Date(at.getTime() + 604_800_000),
      version: current.version + 1, updatedAt: at }).where(eq(schema.commissionRefundObligations.id, c.obligationId));
  });
  return id;
}
describe("commission refund port", () => {
  test("createObligation is idempotent per source", async () => {
    const c = await create();
    expect(await fixture.db.transaction((tx) => port.createObligation(tx, c.input))).toEqual({ obligationId: c.obligationId, created: false });
    await expect(fixture.db.transaction((tx) => port.createObligation(tx, { ...c.input, orderId: randomUUID() }))).rejects.toThrow();
    const next = { ...c.input, sourceId: randomUUID(), requestId: randomUUID() };
    const raced = await Promise.all([fixture.db.transaction((tx) => port.createObligation(tx, next)), fixture.db.transaction((tx) => port.createObligation(tx, next))]);
    expect(raced.map((r) => r.created).sort()).toEqual([false, true]); expect(raced[0]!.obligationId).toBe(raced[1]!.obligationId);
    const events = await fixture.db.select({ action: schema.commissionRefundEvents.action }).from(schema.commissionRefundEvents)
      .where(eq(schema.commissionRefundEvents.obligationId, raced[0]!.obligationId));
    expect(events).toEqual([{ action: "created" }]);
  });
  test("adjustAmount reduces an unsent obligation, waives at zero, and is recorded_only once sent", async () => {
    const c = await create(); const cmd = command(c.obligationId);
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...cmd, newAmountVnd: 200_000 }))).toBe("adjusted");
    expect((await row(c.obligationId)).amountVnd).toBe(200_000);
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...command(c.obligationId), newAmountVnd: 0 }))).toBe("waived");
    expect((await row(c.obligationId)).state).toBe("waived");
    const s = await create(); await sent(s);
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...command(s.obligationId), newAmountVnd: 100_000 }))).toBe("recorded_only");
    expect((await row(s.obligationId)).amountVnd).toBe(500_000);
  });
  test("extendDeadline refuses a date more than 30 days ahead", async () => {
    const c = await create(); await destination(c.obligationId);
    await expect(fixture.db.transaction((tx) => port.extendDeadline(tx, { ...command(c.obligationId), until: new Date(at.getTime() + 2_592_000_001) }))).rejects.toThrow();
    const until = new Date(at.getTime() + 2_592_000_000);
    await fixture.db.transaction((tx) => port.extendDeadline(tx, { ...command(c.obligationId), until }));
    expect((await row(c.obligationId)).dueAt?.getTime()).toBe(until.getTime());
  });
  test("requireResend keeps the earlier send row and returns to awaiting_send with a new deadline", async () => {
    const c = await create(); const sendId = await sent(c);
    await fixture.db.update(schema.commissionRefundObligations).set({ state: "not_received", version: 4 }).where(eq(schema.commissionRefundObligations.id, c.obligationId));
    const later = new Date("2026-10-16T04:00:00Z");
    await fixture.db.transaction((tx) => port.requireResend(tx, { ...command(c.obligationId), at: later }));
    const current = await row(c.obligationId);
    expect(current.state).toBe("awaiting_send"); expect(current.currentSendId).toBeNull(); expect(current.confirmBy).toBeNull();
    expect(current.dueAt?.toISOString()).toBe("2026-10-23T16:59:59.999Z");
    expect((await fixture.db.select({ id: schema.commissionRefundSends.id }).from(schema.commissionRefundSends).where(eq(schema.commissionRefundSends.obligationId, c.obligationId))).map((r) => r.id)).toEqual([sendId]);
  });
  test("purgeDestinations nulls envelopes 30 days after a terminal state and keeps bank name and suffix", async () => {
    const c = await create(); await destination(c.obligationId);
    await fixture.db.transaction((tx) => port.waive(tx, command(c.obligationId)));
    expect(await port.purgeDestinations(fixture.db, { at: new Date(at.getTime() + 2_592_000_000 - 1), limit: 100 })).toBe(0);
    expect(await port.purgeDestinations(fixture.db, { at: new Date(at.getTime() + 2_592_000_000), limit: 100 })).toBe(1);
    const current = await row(c.obligationId);
    expect(current.destinationAccountEnvelope === null && current.destinationHolderEnvelope === null).toBe(true);
    expect(current.destinationBankName).toBe("Vietcombank"); expect(current.destinationSuffix).toBe("3456");
    expect(await port.purgeDestinations(fixture.db, { at: new Date(at.getTime() + 2_592_000_000), limit: 100 })).toBe(0);
  });
  test("paidIntent returns the confirmed intent, closedIntent the expired one", async () => {
    const c = await create(); const facts = createCommissionPaymentFactsPort();
    expect(await fixture.db.transaction((tx) => facts.paidIntent(tx, c.p.orderId))).toEqual({ paymentIntentId: c.input.paymentIntentId, amountVnd: 500_000 });
    expect(await fixture.db.transaction((tx) => facts.closedIntent(tx, c.p.orderId))).toBeNull();
    const { orderId } = await paymentOrder("expired");
    const closed = await fixture.db.transaction((tx) => facts.closedIntent(tx, orderId));
    expect(closed?.amountVnd).toBe(500_000);
    expect(await fixture.db.transaction((tx) => facts.paidIntent(tx, orderId))).toBeNull();
  });
  test("policy constants, refund references and bank references use the approved values", () => {
    expect(COMMISSION_REFUND_POLICY).toEqual({ sendBusinessDays: 5, confirmWindowMs: 604_800_000, purgeAfterMs: 2_592_000_000,
      agingAfterMs: 2_592_000_000, maxExtensionMs: 2_592_000_000 });
    const references = new Set(Array.from({ length: 100 }, createRefundReference));
    expect(references.size).toBe(100);
    expect([...references].every((reference) => /^PKR[0-9A-HJKMNP-TV-Z]{12}$/u.test(reference))).toBe(true);
    expect(normalizeBankReference(" SYNTHETIC_1/a.b-c ")).toBe("SYNTHETIC_1/a.b-c");
    for (const value of ["", "A".repeat(65), "a b", "a\nb", 1, null]) expect(() => normalizeBankReference(value)).toThrow();
  });
  test("presumption, receipt evidence, reads and case reveals obey lifecycle and privacy", async () => {
    const c = await create(); await sent(c);
    await expect(fixture.db.transaction((tx) => port.presumeReceived(tx, { ...command(c.obligationId) }))).rejects.toThrow();
    const later = new Date(at.getTime() + 604_800_000);
    expect((await port.readConfirmationCandidates(fixture.db, { at: later, limit: 10 })).some((r) => r.obligationId === c.obligationId)).toBe(true);
    await fixture.db.transaction((tx) => port.presumeReceived(tx, { obligationId: c.obligationId, requestId: randomUUID(), at: later }));
    expect((await row(c.obligationId)).state).toBe("presumed_received");
    const view = await fixture.db.transaction((tx) => port.listForOrder(tx, { orderId: c.p.orderId, viewer: "creator" }));
    expect(JSON.stringify(view).includes("envelope")).toBe(false);
    const reveal = await fixture.db.transaction((tx) => port.revealForCase(tx, c.obligationId));
    expect(reveal?.accountNumber === "000000123456" && reveal?.holderName === "SYNTHETIC BUYER").toBe(true);
    const d = await create(); await sent(d);
    await fixture.db.update(schema.commissionRefundObligations).set({ state: "not_received", version: 4 }).where(eq(schema.commissionRefundObligations.id, d.obligationId));
    await fixture.db.transaction((tx) => port.acceptReceiptEvidence(tx, command(d.obligationId)));
    expect((await row(d.obligationId)).state).toBe("received");
  });
  test("aging and overdue scans respect the exact boundary and lifecycle", async () => {
    const c = await create(); const agingAt = new Date(at.getTime() + COMMISSION_REFUND_POLICY.agingAfterMs);
    const contains = (rows: readonly { obligationId: string }[]) => rows.some((r) => r.obligationId === c.obligationId);
    expect(contains(await port.readAging(fixture.db, { at: new Date(agingAt.getTime() - 1), limit: 500 }))).toBe(false);
    expect(contains(await port.readAging(fixture.db, { at: agingAt, limit: 500 }))).toBe(true);
    expect((await fixture.db.transaction((tx) => port.findBySource(tx, c.input)))?.id).toBe(c.obligationId);
    await destination(c.obligationId); const dueAt = (await row(c.obligationId)).dueAt!;
    expect(dueAt.toISOString()).toBe("2026-10-19T16:59:59.999Z");
    expect(contains(await port.readAging(fixture.db, { at: agingAt, limit: 500 }))).toBe(false);
    expect(contains(await port.readOverdueCandidates(fixture.db, { at: new Date(dueAt.getTime() - 1), limit: 500 }))).toBe(false);
    expect(contains(await port.readOverdueCandidates(fixture.db, { at: dueAt, limit: 500 }))).toBe(true);
    expect(await fixture.db.transaction((tx) => port.awaitingSendDeadlines(tx, c.p.creator.userId))).toEqual([{ obligationId: c.obligationId, dueAt }]);
    await fixture.db.transaction((tx) => port.waive(tx, command(c.obligationId)));
    expect(contains(await port.readOverdueCandidates(fixture.db, { at: dueAt, limit: 500 }))).toBe(false);
    expect(await fixture.db.transaction((tx) => port.awaitingSendDeadlines(tx, c.p.creator.userId))).toEqual([]);
  });
  test("a resend preserves a previous extension as history and freezes the amount after any send", async () => {
    const c = await create(); await destination(c.obligationId);
    await fixture.db.transaction((tx) => port.extendDeadline(tx, { ...command(c.obligationId), until: new Date("2026-11-01T04:00:00Z") }));
    const sendId = randomUUID();
    await fixture.db.transaction(async (tx) => {
      const current = await row(c.obligationId);
      await tx.insert(schema.commissionRefundSends).values({ id: sendId, obligationId: c.obligationId, transferDate: "2026-10-09",
        referenceEnvelope: fixtureEnvelope("commission_refund_send", sendId, "bank_reference", "SYNTHETIC-2"),
        actorUserId: c.p.creator.userId, actorSessionId: c.p.creator.sessionId, requestId: randomUUID(), recordedAt: at });
      await tx.update(schema.commissionRefundObligations).set({ state: "sent", currentSendId: sendId, confirmBy: new Date(at.getTime() + 604_800_000),
        version: current.version + 1 }).where(eq(schema.commissionRefundObligations.id, c.obligationId));
    });
    await fixture.db.update(schema.commissionRefundObligations).set({ state: "not_received", version: 5 }).where(eq(schema.commissionRefundObligations.id, c.obligationId));
    const resend = { ...command(c.obligationId), at: new Date("2026-10-16T04:00:00Z") };
    await fixture.db.transaction((tx) => port.requireResend(tx, resend));
    const before = await row(c.obligationId);
    expect(before.dueAt?.toISOString()).toBe("2026-10-23T16:59:59.999Z");
    await fixture.db.transaction((tx) => port.requireResend(tx, resend));
    expect((await row(c.obligationId)).version).toBe(before.version);
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...resend, requestId: randomUUID(), newAmountVnd: 0 }))).toBe("recorded_only");
    expect((await row(c.obligationId)).amountVnd).toBe(500_000);
  });
});
