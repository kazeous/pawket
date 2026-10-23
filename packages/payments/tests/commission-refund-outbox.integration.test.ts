import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { importConfiguredBusinessCalendarVersion, calculateStoredBusinessDayDeadline } from "@pawket/database";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureKeyring, fixtureHash, schema } from "./sepay-integration-fixture.js";
import { createCommissionRefundPort } from "../src/commission-refund-port.js";
import { REFUND_OUTBOX_ACTIONS } from "../src/commission-refund-outbox.js";

const parsed = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Refund outbox tests require a dedicated local test database");
const fixture = createSePayIntegrationFixture("refund_outbox");
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
async function sent(c: Awaited<ReturnType<typeof create>>, recordedAt = at) {
  if ((await row(c.obligationId)).state === "awaiting_destination") await destination(c.obligationId);
  const id = randomUUID();
  await fixture.db.transaction(async (tx) => {
    const current = await row(c.obligationId);
    await tx.insert(schema.commissionRefundSends).values({ id, obligationId: c.obligationId, transferDate: "2026-10-09",
      referenceEnvelope: fixtureEnvelope("commission_refund_send", id, "bank_reference", "SYNTHETIC-1"), actorUserId: c.p.creator.userId,
      actorSessionId: c.p.creator.sessionId, requestId: randomUUID(), recordedAt });
    await tx.update(schema.commissionRefundObligations).set({ state: "sent", currentSendId: id, confirmBy: new Date(recordedAt.getTime() + 604_800_000),
      version: current.version + 1, updatedAt: recordedAt }).where(eq(schema.commissionRefundObligations.id, c.obligationId));
  });
  return id;
}
describe("commission refund outbox events", () => {
  const announced = () => fixture.db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.eventType, "refund.event_recorded.v1"));
  const announcedFor = async (obligationId: string) => (await announced()).filter((event) => event.aggregateId === obligationId);
  const actions = async (obligationId: string) => (await fixture.db.select().from(schema.commissionRefundEvents)
    .where(eq(schema.commissionRefundEvents.obligationId, obligationId))).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  test("the announced actions are exactly the eight the notifications design lists", () => {
    expect([...REFUND_OUTBOX_ACTIONS]).toEqual(["created", "destination_entered", "sent_recorded", "receipt_confirmed", "receipt_denied",
      "presumed_received", "resend_required", "waived"]);
  });

  test("each listed action writes one refund.event_recorded.v1 in the same transaction", async () => {
    const c = await create();
    expect(await announcedFor(c.obligationId)).toHaveLength(1);
    // A rolled-back transaction leaves neither the refund event nor the outbox row.
    const before = (await announced()).length; const sourceId = randomUUID();
    await expect(fixture.db.transaction(async (tx) => {
      await port.createObligation(tx, { ...c.input, sourceId, requestId: randomUUID() });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await announced()).length).toBe(before);
    expect(await fixture.db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.sourceId, sourceId))).toHaveLength(0);

    await destination(c.obligationId);
    await fixture.db.transaction((tx) => port.waive(tx, command(c.obligationId)));
    const w = await create(); await sent(w);
    await fixture.db.update(schema.commissionRefundObligations).set({ state: "not_received", version: 4 }).where(eq(schema.commissionRefundObligations.id, w.obligationId));
    await fixture.db.transaction((tx) => port.requireResend(tx, command(w.obligationId)));
    const r = await create(); await sent(r);
    await fixture.db.update(schema.commissionRefundObligations).set({ state: "not_received", version: 4 }).where(eq(schema.commissionRefundObligations.id, r.obligationId));
    await fixture.db.transaction((tx) => port.acceptReceiptEvidence(tx, command(r.obligationId)));
    const p = await create(); await sent(p);
    await fixture.db.transaction((tx) => port.presumeReceived(tx, { obligationId: p.obligationId, requestId: randomUUID(), at: new Date(at.getTime() + 604_800_000) }));

    const expected: Readonly<Record<string, readonly string[]>> = {
      [c.obligationId]: ["created", "waived"], [w.obligationId]: ["created", "resend_required"],
      [r.obligationId]: ["created", "receipt_confirmed"], [p.obligationId]: ["created", "presumed_received"],
    };
    for (const [obligationId, wanted] of Object.entries(expected)) {
      const events = await announcedFor(obligationId); const rows = (await actions(obligationId)).filter((event) => wanted.includes(event.action));
      expect(rows.map((event) => event.action).sort()).toEqual([...wanted].sort());
      expect(events.map((event) => (event.payload as { action: string }).action).sort()).toEqual([...wanted].sort());
      for (const event of events) {
        const row = rows.find((candidate) => candidate.id === (event.payload as { refundEventId: string }).refundEventId);
        expect(row, "the outbox row names a committed refund event").toBeDefined();
        expect(event).toMatchObject({ eventVersion: 1, aggregateType: "commission_refund_obligation", aggregateId: obligationId });
        expect(event.occurredAt.toISOString()).toBe(row!.occurredAt.toISOString());
        expect(row!.action).toBe((event.payload as { action: string }).action);
      }
    }
  });

  test("destination_revealed, deadline_extended, amount changes and destination_purged write no outbox event", async () => {
    const c = await create(); await destination(c.obligationId);
    await fixture.db.transaction((tx) => port.extendDeadline(tx, { ...command(c.obligationId), until: new Date("2026-11-01T04:00:00Z") }));
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...command(c.obligationId), newAmountVnd: 200_000 }))).toBe("adjusted");
    const s = await create(); await sent(s);
    expect(await fixture.db.transaction((tx) => port.adjustAmount(tx, { ...command(s.obligationId), newAmountVnd: 100_000 }))).toBe("recorded_only");
    const done = await create(); await sent(done);
    const endedAt = new Date(at.getTime() + 604_800_000);
    await fixture.db.transaction((tx) => port.presumeReceived(tx, { obligationId: done.obligationId, requestId: randomUUID(), at: endedAt }));
    expect(await port.purgeDestinations(fixture.db, { at: new Date(endedAt.getTime() + 2_592_000_000), limit: 500 })).toBeGreaterThan(0);
    // destination_revealed is written by the service's own event helper and is covered with the service in apps/web.
    const rows = [...await actions(c.obligationId), ...await actions(s.obligationId), ...await actions(done.obligationId)];
    expect(rows.map((event) => event.action)).toEqual(expect.arrayContaining(["deadline_extended", "amount_adjusted", "amount_recorded", "destination_purged"]));
    const withoutOutbox = ["deadline_extended", "amount_adjusted", "amount_recorded", "destination_purged"];
    for (const obligationId of [c.obligationId, s.obligationId, done.obligationId]) {
      const names = (await announcedFor(obligationId)).map((event) => (event.payload as { action: string }).action);
      expect(names.some((name) => withoutOutbox.includes(name))).toBe(false);
    }
    expect((await announcedFor(c.obligationId)).map((event) => (event.payload as { action: string }).action)).toEqual(["created"]);
  });

  test("the payload carries ids and the action only", async () => {
    const c = await create(); const [event] = await announcedFor(c.obligationId);
    expect(Object.keys(event!.payload).sort()).toEqual(["action", "obligationId", "refundEventId"]);
    expect(event!.payload).toMatchObject({ obligationId: c.obligationId, action: "created" });
    const serialized = JSON.stringify(event!.payload);
    for (const value of ["amount", "bank", "account", "holder", "note", "reference", "500000", "PKR", "000000123456", "SYNTHETIC BUYER"]) expect(serialized).not.toContain(value);
  });
});
