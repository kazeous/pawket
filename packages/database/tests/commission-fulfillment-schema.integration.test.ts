import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureHash, schema } from "../../payments/tests/sepay-integration-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for commission fulfillment schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Commission fulfillment schema tests require a dedicated local test database");
}
const fixture = createSePayIntegrationFixture("commission_fulfillment_schema");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const at = new Date("2026-09-26T04:00:00Z");
const confirmedAt = new Date(at.getTime() + 1_000);
const deliveredAt = new Date(at.getTime() + 10 * 86_400_000);
const completedAt = new Date(deliveredAt.getTime() + 1_000);
const envelope = (type: string, id: string, field: string) => JSON.stringify(fixtureEnvelope(type, id, field, "Synthetic private text"));
type Sql = TransactionSql;

async function expectSqlState(operation: PromiseLike<unknown>, code: string, message?: string) {
  try { await operation; } catch (error) {
    expect((error as { code: string }).code).toBe(code);
    if (message) expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}`);
}
async function packageFixture(revisionAllowance = 2) {
  const creator = await fixture.creator(); const creatorUserId = creator.actor.userId;
  const buyerUserId = `i7-buyer-${randomUUID()}`;
  const packageId = randomUUID(); const packageRevisionId = randomUUID(); const pageId = randomUUID();
  await fixture.db.insert(schema.identityUsers).values({ id: buyerUserId, name: "Synthetic buyer", email: `${buyerUserId}@example.invalid`, canonicalEmail: `${buyerUserId}@example.invalid`, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorCommissionSettings).values({ creatorUserId, enabled: true, capacityLimit: 1, createdAt: at, updatedAt: at });
  const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance, reviewWindowDays: 7,
    scope: "Portrait", deliverables: "Artwork", usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "fixed_immediate" as const, briefInstructions: "Describe the portrait", terms, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(schema.commissionPackages.id, packageId));
  return { creatorUserId, buyerUserId, packageId, packageRevisionId, revisionAllowance, accountVersionId: creator.accountVersionId };
}
type Package = Awaited<ReturnType<typeof packageFixture>>;
async function pendingOrder(p: Package) {
  const orderId = randomUUID(); const intentId = randomUUID(); const referenceHash = fixtureHash();
  const expiry = new Date(at.getTime() + 86_400_000).toISOString();
  await fixture.client.begin(async (tx) => {
    await tx`insert into commission_orders (id, creator_user_id, buyer_user_id, package_id, package_revision_id, route, state, amount_vnd, accepted_at, expires_at, created_at, updated_at)
      values (${orderId}, ${p.creatorUserId}, ${p.buyerUserId}, ${p.packageId}, ${p.packageRevisionId}, 'fixed_immediate', 'awaiting_payment', 50000, ${at.toISOString()}, ${expiry}, ${at.toISOString()}, ${at.toISOString()})`;
    await tx`insert into commission_briefs (order_id, text_envelope, links_envelope, buyer_session_id, request_id, created_at)
      values (${orderId}, ${envelope("commission_briefs", orderId, "text")}::jsonb, ${envelope("commission_briefs", orderId, "links")}::jsonb, 'synthetic-buyer', ${randomUUID()}, ${at.toISOString()})`;
    for (const role of ["buyer", "creator"] as const) await tx`insert into commission_acceptances (id, order_id, actor_user_id, actor_session_id, role, package_revision_id, policy_revision_id, request_id, accepted_at)
      values (${randomUUID()}, ${orderId}, ${role === "buyer" ? p.buyerUserId : p.creatorUserId}, ${`synthetic-${role}`}, ${role}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, ${randomUUID()}, ${at.toISOString()})`;
    await tx`insert into commission_terms_snapshots (order_id, package_revision_id, policy_revision_id, amount_vnd, turnaround_days, revision_allowance, review_window_days,
      scope_envelope, deliverables_envelope, usage_rights_envelope, artist_terms_envelope, buyer_accepted_at, creator_accepted_at, created_at)
      values (${orderId}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, 50000, 7, ${p.revisionAllowance}, 7,
      ${envelope("commission_terms_snapshots", orderId, "scope")}::jsonb, ${envelope("commission_terms_snapshots", orderId, "deliverables")}::jsonb,
      ${envelope("commission_terms_snapshots", orderId, "usage_rights")}::jsonb, ${envelope("commission_terms_snapshots", orderId, "artist_terms")}::jsonb,
      ${at.toISOString()}, ${at.toISOString()}, ${at.toISOString()})`;
    await tx`insert into commission_reservations (order_id, creator_user_id, reserved_at) values (${orderId}, ${p.creatorUserId}, ${at.toISOString()})`;
    await event(tx, orderId, 1, "awaiting_payment", at);
    await tx`insert into payment_intents (id, purpose, commission_order_id, creator_user_id, amount_vnd, reference_hash, reference_envelope, destination_envelope, account_version_id, abuse_key_hash, expires_at, request_id, created_at, updated_at)
      values (${intentId}, 'commission', ${orderId}, ${p.creatorUserId}, 50000, ${referenceHash}, ${envelope("payment_intents", intentId, "transfer_reference")}::jsonb,
      ${envelope("payment_intents", intentId, "destination")}::jsonb, ${p.accountVersionId}, ${fixtureHash()}, ${expiry}, ${randomUUID()}, ${at.toISOString()}, ${at.toISOString()})`;
  });
  return { ...p, orderId, intentId, referenceHash };
}
async function paidOrder(p?: Package) {
  const f = await pendingOrder(p ?? await packageFixture());
  await fixture.client.begin(async (tx) => {
    await tx`insert into payment_confirmations (id, payment_intent_id, creator_user_id, account_version_id, observed_amount_vnd, reference_hash, bank_transaction_fingerprint,
      attested_received, actor_session_id, primary_authenticated_at, confirmed_at, request_id, idempotency_key_hash)
      values (${randomUUID()}, ${f.intentId}, ${f.creatorUserId}, ${f.accountVersionId}, 50000, ${f.referenceHash}, ${fixtureHash()},
      true, 'synthetic-creator', ${confirmedAt.toISOString()}, ${confirmedAt.toISOString()}, ${randomUUID()}, ${fixtureHash()})`;
    await tx`update payment_intents set state = 'confirmed', closed_at = ${confirmedAt.toISOString()}, updated_at = ${confirmedAt.toISOString()} where id = ${f.intentId}`;
    await tx`update commission_orders set state = 'in_progress', version = 2, confirmed_at = ${confirmedAt.toISOString()}, due_at = ${new Date(confirmedAt.getTime() + 7 * 86_400_000).toISOString()}, updated_at = ${confirmedAt.toISOString()} where id = ${f.orderId}`;
    await tx`update commission_reservations set state = 'occupied', occupied_at = ${confirmedAt.toISOString()} where order_id = ${f.orderId}`;
    await event(tx, f.orderId, 2, "in_progress", confirmedAt);
  });
  return f;
}
async function event(tx: Sql, orderId: string, version: number, state: string, time: Date) {
  await tx`insert into commission_events (id, order_id, order_version, type, request_id, occurred_at)
    values (${randomUUID()}, ${orderId}, ${version}, ${state}, ${randomUUID()}, ${time.toISOString()})`;
}
async function submission(tx: Sql, orderId: string, kind = "final", time = deliveredAt) {
  const id = randomUUID();
  await tx`insert into commission_submissions (id, order_id, kind, actor_session_id, request_id, submitted_at)
    values (${id}, ${orderId}, ${kind}, 'synthetic-creator', ${randomUUID()}, ${time.toISOString()})`;
  return id;
}
async function deliver(orderId: string, options: { omitFinal?: boolean; reviewOffsetMs?: number } = {}) {
  return fixture.client.begin(async (tx) => {
    const [order] = await tx`select version from commission_orders where id = ${orderId}`;
    await tx`update commission_orders set state = 'delivered', version = version + 1, delivered_at = ${deliveredAt.toISOString()},
      review_ends_at = ${new Date(deliveredAt.getTime() + 7 * 86_400_000 + (options.reviewOffsetMs ?? 0)).toISOString()}, updated_at = ${deliveredAt.toISOString()} where id = ${orderId}`;
    const id = options.omitFinal ? null : await submission(tx, orderId);
    await event(tx, orderId, Number(order!.version) + 1, "delivered", deliveredAt);
    return id;
  });
}
async function complete(orderId: string) {
  await fixture.client.begin(async (tx) => {
    const [order] = await tx`select version from commission_orders where id = ${orderId}`;
    await tx`update commission_orders set state = 'completed', version = version + 1, completed_at = ${completedAt.toISOString()}, completion_kind = 'buyer_accepted', updated_at = ${completedAt.toISOString()} where id = ${orderId}`;
    await tx`update commission_reservations set state = 'completed', released_at = ${completedAt.toISOString()} where order_id = ${orderId}`;
    await event(tx, orderId, Number(order!.version) + 1, "completed", completedAt);
  });
}
async function requestDraftChanges(orderId: string, time: Date) {
  await fixture.client.begin(async (tx) => {
    const id = await submission(tx, orderId, "draft", time);
    await tx`update commission_submissions set response = 'changes_requested', response_note_envelope = ${envelope("commission_submissions", id, "response_note")}::jsonb,
      response_session_id = 'synthetic-buyer', response_request_id = ${randomUUID()}, responded_at = ${time.toISOString()} where id = ${id}`;
    const [order] = await tx`update commission_orders set revisions_used = revisions_used + 1, version = version + 1, updated_at = ${time.toISOString()} where id = ${orderId} returning version`;
    await event(tx, orderId, Number(order!.version), "in_progress", time);
  });
}

describe("commission fulfillment schema commitments", () => {
  test("in_progress to delivered with a final in the same transaction commits", async () => {
    const f = await paidOrder(); const id = await deliver(f.orderId);
    expect(await fixture.client`select state, revisions_used from commission_orders where id = ${f.orderId}`).toEqual([{ state: "delivered", revisions_used: 0 }]);
    expect(await fixture.client`select response from commission_submissions where id = ${id!}`).toEqual([{ response: null }]);
  });
  test("delivered without an open final fails", async () => {
    const f = await paidOrder();
    await expectSqlState(deliver(f.orderId, { omitFinal: true }), "23514", "Commission reservation/fulfillment mismatch");
    expect(await fixture.client`select state from commission_orders where id = ${f.orderId}`).toEqual([{ state: "in_progress" }]);
  });
  test("delivered to completed releases the slot as completed", async () => {
    const p = await packageFixture(); const f = await paidOrder(p); await deliver(f.orderId);
    await expectSqlState(pendingOrder(p), "23514", "Commission capacity unavailable");
    await complete(f.orderId);
    expect(await fixture.client`select r.state, r.released_at = o.completed_at as exact from commission_reservations r join commission_orders o on o.id = r.order_id where o.id = ${f.orderId}`)
      .toEqual([{ state: "completed", exact: true }]);
    await pendingOrder(p);
  });
  test("revisions_used cannot exceed the locked allowance", async () => {
    const f = await paidOrder(await packageFixture(1));
    await requestDraftChanges(f.orderId, deliveredAt);
    await expectSqlState(requestDraftChanges(f.orderId, completedAt), "23514");
    expect(await fixture.client`select revisions_used from commission_orders where id = ${f.orderId}`).toEqual([{ revisions_used: 1 }]);
    expect(await fixture.client`select count(*)::int as count from commission_submissions where order_id = ${f.orderId} and response = 'changes_requested'`).toEqual([{ count: 1 }]);
  });
  test("review_ends_at must equal delivered_at plus the review window", async () => {
    const f = await paidOrder(); await expectSqlState(deliver(f.orderId, { reviewOffsetMs: 1_000 }), "23514");
  });
  test("completed is terminal", async () => {
    const f = await paidOrder(); await deliver(f.orderId); await complete(f.orderId);
    await expectSqlState(fixture.client`update commission_orders set state = 'in_progress', version = version + 1,
      delivered_at = null, review_ends_at = null, completed_at = null, completion_kind = null where id = ${f.orderId}`, "23514", "Forbidden commission transition");
  });
  test("three completed orders do not block a fourth request", async () => {
    const p = await packageFixture();
    for (let i = 0; i < 3; i++) { const f = await paidOrder(p); await deliver(f.orderId); await complete(f.orderId); }
    const f = await pendingOrder(p);
    expect(await fixture.client`select state from commission_orders where id = ${f.orderId}`).toEqual([{ state: "awaiting_payment" }]);
  });
  test("delivered and completed orders pass the payment consistency check", async () => {
    const f = await paidOrder();
    const before = await fixture.client`select to_jsonb(i) as row from payment_intents i where id = ${f.intentId}`;
    const confirmations = await fixture.client`select to_jsonb(c) as row from payment_confirmations c where payment_intent_id = ${f.intentId}`;
    await deliver(f.orderId); await complete(f.orderId);
    expect(JSON.stringify(await fixture.client`select to_jsonb(i) as row from payment_intents i where id = ${f.intentId}`) === JSON.stringify(before)).toBe(true);
    expect(JSON.stringify(await fixture.client`select to_jsonb(c) as row from payment_confirmations c where payment_intent_id = ${f.intentId}`) === JSON.stringify(confirmations)).toBe(true);
    const invalid = await paidOrder(); await deliver(invalid.orderId);
    // Corrupt only the fixture; subsequent commands run under the normal guards.
    await fixture.client.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update payment_intents set state = 'awaiting_transfer', closed_at = null where id = ${invalid.intentId}`;
    });
    await expectSqlState(complete(invalid.orderId), "23514", "commission and payment must commit atomically");
  });
  test("old expiry rule no longer blocks paid orders", async () => {
    const f = await paidOrder();
    expect(await fixture.client`select expires_at < ${deliveredAt.toISOString()}::timestamptz as expired from commission_orders where id = ${f.orderId}`).toEqual([{ expired: true }]);
    await deliver(f.orderId);
  });
  test("submission response is write-once", async () => {
    const f = await paidOrder(); let id = "";
    await fixture.client.begin(async (tx) => { id = await submission(tx, f.orderId, "draft"); });
    await fixture.client`update commission_submissions set response = 'approved', response_session_id = 'synthetic-buyer', response_request_id = ${randomUUID()}, responded_at = ${completedAt.toISOString()} where id = ${id}`;
    await expectSqlState(fixture.client`update commission_submissions set response = 'superseded', response_session_id = null, response_request_id = null where id = ${id}`, "23514");
    await expectSqlState(fixture.client`update commission_submissions set actor_session_id = 'different-session' where id = ${id}`, "23514");
  });
  test("submissions cannot be deleted", async () => {
    const f = await paidOrder(); let id = "";
    await fixture.client.begin(async (tx) => { id = await submission(tx, f.orderId, "draft"); });
    await expectSqlState(fixture.client`delete from commission_submissions where id = ${id}`, "23514");
  });
  test("only one open pause", async () => {
    const id = randomUUID();
    await fixture.client`insert into commission_fulfillment_pauses (id, started_at) values (${id}, ${at.toISOString()})`;
    await expectSqlState(fixture.client`insert into commission_fulfillment_pauses (id, started_at) values (${randomUUID()}, ${confirmedAt.toISOString()})`, "23505");
    await fixture.client`update commission_fulfillment_pauses set ended_at = ${confirmedAt.toISOString()} where id = ${id}`;
    await expectSqlState(fixture.client`update commission_fulfillment_pauses set ended_at = ${completedAt.toISOString()} where id = ${id}`, "23514");
    await expectSqlState(fixture.client`delete from commission_fulfillment_pauses where id = ${id}`, "23514");
    await fixture.client`insert into commission_fulfillment_pauses (id, started_at) values (${randomUUID()}, ${confirmedAt.toISOString()})`;
  });
});
