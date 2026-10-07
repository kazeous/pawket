import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureHash, schema } from "../../payments/tests/sepay-integration-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for commission order exit schema tests");
const parsed = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) {
  throw new Error("Commission order exit schema tests require a dedicated local test database");
}
const fixture = createSePayIntegrationFixture("commission_order_exits_schema");
beforeAll(fixture.initialize, 30_000); afterAll(fixture.dispose, 30_000);
const at = new Date("2026-10-07T04:00:00Z");
const confirmedAt = new Date(at.getTime() + 1_000);
const deliveredAt = new Date(at.getTime() + 10 * 86_400_000);
const closedAt = new Date(deliveredAt.getTime() + 1_000);
const reviewEndsAt = new Date(deliveredAt.getTime() + 7 * 86_400_000);
const floorAt = new Date(reviewEndsAt.getTime() + 172_800_000);
const postPaymentReasons = ["cancelled_by_agreement", "cancelled_by_ruling", "buyer_cancelled_after_suspension", "fulfillment_frozen"] as const;
const envelope = (type: string, id: string, field: string) => JSON.stringify(fixtureEnvelope(type, id, field, "Synthetic private text"));
type Sql = TransactionSql;

async function expectSqlState(operation: PromiseLike<unknown>, message?: string) {
  try { await operation; } catch (error) {
    expect((error as { code: string }).code).toBe("23514");
    if (message) expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error("Expected SQLSTATE 23514");
}
async function packageFixture(route: "fixed_immediate" | "fixed_approval" = "fixed_immediate") {
  const creator = await fixture.creator(); const creatorUserId = creator.actor.userId;
  const buyerUserId = `i8-buyer-${randomUUID()}`;
  const packageId = randomUUID(); const packageRevisionId = randomUUID(); const pageId = randomUUID();
  await fixture.db.insert(schema.identityUsers).values({ id: buyerUserId, name: "Synthetic buyer", email: `${buyerUserId}@example.invalid`, canonicalEmail: `${buyerUserId}@example.invalid`, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorCommissionSettings).values({ creatorUserId, enabled: true, capacityLimit: 1, createdAt: at, updatedAt: at });
  const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
    scope: "Portrait", deliverables: "Artwork", usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route, briefInstructions: "Describe the portrait", terms, showcaseId: null };
  await fixture.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: "synthetic-creator", requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(schema.commissionPackages.id, packageId));
  return { creatorUserId, buyerUserId, packageId, packageRevisionId, accountVersionId: creator.accountVersionId };
}
type Package = Awaited<ReturnType<typeof packageFixture>>;
async function event(tx: Sql, orderId: string, version: number, state: string, time: Date) {
  await tx`insert into commission_events (id, order_id, order_version, type, request_id, occurred_at)
    values (${randomUUID()}, ${orderId}, ${version}, ${state}, ${randomUUID()}, ${time.toISOString()})`;
}
async function brief(tx: Sql, orderId: string) {
  await tx`insert into commission_briefs (order_id, text_envelope, links_envelope, buyer_session_id, request_id, created_at)
    values (${orderId}, ${envelope("commission_briefs", orderId, "text")}::jsonb, ${envelope("commission_briefs", orderId, "links")}::jsonb, 'synthetic-buyer', ${randomUUID()}, ${at.toISOString()})`;
}
async function acceptance(tx: Sql, p: Package, orderId: string, role: "buyer" | "creator") {
  await tx`insert into commission_acceptances (id, order_id, actor_user_id, actor_session_id, role, package_revision_id, policy_revision_id, request_id, accepted_at)
    values (${randomUUID()}, ${orderId}, ${role === "buyer" ? p.buyerUserId : p.creatorUserId}, ${`synthetic-${role}`}, ${role}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, ${randomUUID()}, ${at.toISOString()})`;
}
async function requestedOrder() {
  const p = await packageFixture("fixed_approval"); const orderId = randomUUID();
  await fixture.client.begin(async (tx) => {
    await tx`insert into commission_orders (id, creator_user_id, buyer_user_id, package_id, package_revision_id, route, expires_at, created_at, updated_at)
      values (${orderId}, ${p.creatorUserId}, ${p.buyerUserId}, ${p.packageId}, ${p.packageRevisionId}, 'fixed_approval', ${new Date(at.getTime() + 7 * 86_400_000).toISOString()}, ${at.toISOString()}, ${at.toISOString()})`;
    await brief(tx, orderId); await acceptance(tx, p, orderId, "buyer"); await event(tx, orderId, 1, "requested", at);
  });
  return { ...p, orderId };
}
async function pendingOrder(p?: Package) {
  p ??= await packageFixture();
  const orderId = randomUUID(); const intentId = randomUUID(); const referenceHash = fixtureHash();
  const expiry = new Date(at.getTime() + 86_400_000).toISOString();
  await fixture.client.begin(async (tx) => {
    await tx`insert into commission_orders (id, creator_user_id, buyer_user_id, package_id, package_revision_id, route, state, amount_vnd, accepted_at, expires_at, created_at, updated_at)
      values (${orderId}, ${p.creatorUserId}, ${p.buyerUserId}, ${p.packageId}, ${p.packageRevisionId}, 'fixed_immediate', 'awaiting_payment', 50000, ${at.toISOString()}, ${expiry}, ${at.toISOString()}, ${at.toISOString()})`;
    await brief(tx, orderId);
    for (const role of ["buyer", "creator"] as const) await acceptance(tx, p, orderId, role);
    await tx`insert into commission_terms_snapshots (order_id, package_revision_id, policy_revision_id, amount_vnd, turnaround_days, revision_allowance, review_window_days,
      scope_envelope, deliverables_envelope, usage_rights_envelope, artist_terms_envelope, buyer_accepted_at, creator_accepted_at, created_at)
      values (${orderId}, ${p.packageRevisionId}, ${schema.COMMISSION_POLICY_BOOTSTRAP_ID}, 50000, 7, 2, 7,
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
  const f = await pendingOrder(p);
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
async function deliver(orderId: string) {
  return fixture.client.begin(async (tx) => {
    const [order] = await tx`update commission_orders set state = 'delivered', version = version + 1, delivered_at = ${deliveredAt.toISOString()},
      review_ends_at = ${reviewEndsAt.toISOString()}, updated_at = ${deliveredAt.toISOString()} where id = ${orderId} returning version`;
    const id = randomUUID();
    await tx`insert into commission_submissions (id, order_id, kind, actor_session_id, request_id, submitted_at)
      values (${id}, ${orderId}, 'final', 'synthetic-creator', ${randomUUID()}, ${deliveredAt.toISOString()})`;
    await event(tx, orderId, Number(order!.version), "delivered", deliveredAt);
    return id;
  });
}
async function close(tx: Sql, orderId: string, reason: string, options: { omitReservation?: boolean; releaseAt?: Date } = {}) {
  const [order] = await tx`update commission_orders set state = 'closed', version = version + 1, close_reason = ${reason}, closed_at = ${closedAt.toISOString()}, updated_at = ${closedAt.toISOString()} where id = ${orderId} returning version`;
  if (!options.omitReservation) await tx`update commission_reservations set state = 'cancelled', released_at = ${(options.releaseAt ?? closedAt).toISOString()} where order_id = ${orderId}`;
  await event(tx, orderId, Number(order!.version), "closed", closedAt);
}
async function setFloor(orderId: string, floor: Date | null) {
  await fixture.client.begin(async (tx) => {
    const [order] = await tx`update commission_orders set completion_floor_at = ${floor?.toISOString() ?? null}, version = version + 1 where id = ${orderId} returning version, updated_at`;
    await event(tx, orderId, Number(order!.version), "delivered", new Date(order!.updated_at));
  });
}
async function complete(orderId: string, kind: string, time = closedAt, options: { changeFloor?: boolean } = {}) {
  await fixture.client.begin(async (tx) => {
    if (options.changeFloor) await tx`update commission_orders set state = 'completed', version = version + 1, completed_at = ${time.toISOString()}, completion_kind = ${kind}, completion_floor_at = ${new Date(floorAt.getTime() + 1_000).toISOString()}, updated_at = ${time.toISOString()} where id = ${orderId}`;
    else await tx`update commission_orders set state = 'completed', version = version + 1, completed_at = ${time.toISOString()}, completion_kind = ${kind}, updated_at = ${time.toISOString()} where id = ${orderId}`;
    await tx`update commission_reservations set state = 'completed', released_at = ${time.toISOString()} where order_id = ${orderId}`;
    const [order] = await tx`select version from commission_orders where id = ${orderId}`;
    await event(tx, orderId, Number(order!.version), "completed", time);
  });
}
async function requestChanges(orderId: string, submissionId: string, clearFloor: boolean) {
  await fixture.client.begin(async (tx) => {
    await tx`update commission_submissions set response = 'changes_requested', response_note_envelope = ${envelope("commission_submissions", submissionId, "response_note")}::jsonb,
      response_session_id = 'synthetic-buyer', response_request_id = ${randomUUID()}, responded_at = ${closedAt.toISOString()} where id = ${submissionId}`;
    const [order] = clearFloor
      ? await tx`update commission_orders set state = 'in_progress', revisions_used = revisions_used + 1, delivered_at = null, review_ends_at = null, completion_floor_at = null, version = version + 1, updated_at = ${closedAt.toISOString()} where id = ${orderId} returning version`
      : await tx`update commission_orders set state = 'in_progress', revisions_used = revisions_used + 1, delivered_at = null, review_ends_at = null, version = version + 1, updated_at = ${closedAt.toISOString()} where id = ${orderId} returning version`;
    await event(tx, orderId, Number(order!.version), "in_progress", closedAt);
  });
}

describe("commission order exit schema commitments", () => {
  test("exports the exact post-payment close reasons", () => {
    expect(schema.COMMISSION_POST_PAYMENT_CLOSE_REASONS).toEqual(postPaymentReasons);
  });
  test("in_progress closes as cancelled_by_agreement and the slot becomes cancelled", async () => {
    const p = await packageFixture(); const f = await paidOrder(p);
    await expectSqlState(pendingOrder(p), "Commission capacity unavailable");
    await fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement"));
    expect(await fixture.client`select r.state, r.occupied_at = o.confirmed_at as occupied, r.released_at = o.closed_at as released
      from commission_reservations r join commission_orders o on o.id = r.order_id where o.id = ${f.orderId}`)
      .toEqual([{ state: "cancelled", occupied: true, released: true }]);
    await pendingOrder(p);
  });
  test.each(postPaymentReasons.slice(1))("in_progress also closes as %s", async (reason) => {
    const f = await paidOrder(); await fixture.client.begin((tx) => close(tx, f.orderId, reason));
    expect(await fixture.client`select state, close_reason from commission_orders where id = ${f.orderId}`).toEqual([{ state: "closed", close_reason: reason }]);
  });
  test.each(postPaymentReasons)("delivered closes as %s keeping delivery, review and floor", async (reason) => {
    const f = await paidOrder(); await deliver(f.orderId); await setFloor(f.orderId, floorAt);
    await fixture.client.begin((tx) => close(tx, f.orderId, reason));
    expect(await fixture.client`select state, delivered_at = ${deliveredAt.toISOString()}::timestamptz as delivered,
      review_ends_at = ${reviewEndsAt.toISOString()}::timestamptz as review, completion_floor_at = ${floorAt.toISOString()}::timestamptz as floor,
      completed_at, completion_kind from commission_orders where id = ${f.orderId}`)
      .toEqual([{ state: "closed", delivered: true, review: true, floor: true, completed_at: null, completion_kind: null }]);
  });
  test.each(["agreement", "ruling"])("delivered completes as %s", async (kind) => {
    const f = await paidOrder(); await deliver(f.orderId); await setFloor(f.orderId, floorAt); await complete(f.orderId, kind);
    expect(await fixture.client`select o.state, o.completion_kind, r.state as reservation, r.released_at = o.completed_at as released
      from commission_orders o join commission_reservations r on r.order_id = o.id where o.id = ${f.orderId}`)
      .toEqual([{ state: "completed", completion_kind: kind, reservation: "completed", released: true }]);
  });
  test("a paid close keeps the payment intent confirmed", async () => {
    const f = await paidOrder(); await fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement"));
    expect(await fixture.client`select i.state, i.closed_at = o.confirmed_at as confirmed, i.closed_at < o.closed_at as original,
      c.confirmed_at = o.confirmed_at as evidence from payment_intents i join commission_orders o on o.id = i.commission_order_id
      join payment_confirmations c on c.payment_intent_id = i.id where i.id = ${f.intentId}`)
      .toEqual([{ state: "confirmed", confirmed: true, original: true, evidence: true }]);
  });
  test("changing the payment state in the paid-close transaction fails the deferred graph", async () => {
    const f = await paidOrder();
    await expectSqlState(fixture.client.begin(async (tx) => {
      await close(tx, f.orderId, "cancelled_by_agreement");
      // Corrupt only the fixture to exercise the deferred check independently of the terminal intent guard.
      await tx`set local session_replication_role = replica`;
      await tx`update payment_intents set state = 'rejected', rejection_reason = 'buyer_cancelled', closed_at = ${closedAt.toISOString()}, updated_at = ${closedAt.toISOString()} where id = ${f.intentId}`;
      await tx`set local session_replication_role = origin`;
    }), "commission and payment must commit atomically");
    expect(await fixture.client`select state from commission_orders where id = ${f.orderId}`).toEqual([{ state: "in_progress" }]);
    expect(await fixture.client`select state from payment_intents where id = ${f.intentId}`).toEqual([{ state: "confirmed" }]);
  });
  test.each(["buyer_cancelled", "creator_cancelled", "payment_expired", "buyer_withdrawn"])("a paid order cannot close with pre-payment reason %s", async (reason) => {
    const f = await paidOrder(); await expectSqlState(fixture.client.begin((tx) => close(tx, f.orderId, reason)));
  });
  test.each(postPaymentReasons)("an unpaid order cannot close with post-payment reason %s", async (reason) => {
    const pending = await pendingOrder(); await expectSqlState(fixture.client.begin((tx) => close(tx, pending.orderId, reason)));
    const requested = await requestedOrder(); await expectSqlState(fixture.client.begin((tx) => close(tx, requested.orderId, reason)));
  });
  test("a paid close requires the reservation to cancel at the close time", async () => {
    const f = await paidOrder();
    await expectSqlState(fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement", { omitReservation: true })), "Commission reservation/fulfillment mismatch");
    await expectSqlState(fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement", { releaseAt: new Date(closedAt.getTime() + 1) })), "Commission reservation/fulfillment mismatch");
  });
  test("completion_floor_at may only increase on a delivered order", async () => {
    const f = await paidOrder(); await deliver(f.orderId);
    await expectSqlState(setFloor(f.orderId, reviewEndsAt));
    await expectSqlState(setFloor(f.orderId, new Date(reviewEndsAt.getTime() - 1)));
    await setFloor(f.orderId, floorAt);
    await expectSqlState(setFloor(f.orderId, floorAt));
    await expectSqlState(setFloor(f.orderId, new Date(floorAt.getTime() - 1)));
    await expectSqlState(setFloor(f.orderId, null));
    const increased = new Date(floorAt.getTime() + 1); await setFloor(f.orderId, increased);
    expect(await fixture.client`select version, completion_floor_at = ${increased.toISOString()}::timestamptz as increased from commission_orders where id = ${f.orderId}`)
      .toEqual([{ version: 5, increased: true }]);
    const inProgress = await paidOrder(); await expectSqlState(setFloor(inProgress.orderId, floorAt));
  });
  test("restoring the floor cannot change another delivered fact", async () => {
    const f = await paidOrder(); await deliver(f.orderId);
    await expectSqlState(fixture.client`update commission_orders set version = version + 1, completion_floor_at = ${floorAt.toISOString()},
      review_ends_at = ${new Date(reviewEndsAt.getTime() + 1).toISOString()} where id = ${f.orderId}`, "Forbidden commission transition");
  });
  test("completion_floor_at is immutable when completing or closing", async () => {
    const f = await paidOrder(); await deliver(f.orderId); await setFloor(f.orderId, floorAt);
    await expectSqlState(complete(f.orderId, "agreement", closedAt, { changeFloor: true }));
    await expectSqlState(fixture.client`update commission_orders set state = 'closed', version = version + 1, close_reason = 'cancelled_by_ruling',
      closed_at = ${closedAt.toISOString()}, updated_at = ${closedAt.toISOString()}, completion_floor_at = ${new Date(floorAt.getTime() + 1).toISOString()} where id = ${f.orderId}`);
  });
  test("delivered to in_progress must clear the floor", async () => {
    const f = await paidOrder(); const submissionId = await deliver(f.orderId); await setFloor(f.orderId, floorAt);
    await expectSqlState(requestChanges(f.orderId, submissionId, false));
    await requestChanges(f.orderId, submissionId, true);
    expect(await fixture.client`select state, revisions_used, completion_floor_at from commission_orders where id = ${f.orderId}`)
      .toEqual([{ state: "in_progress", revisions_used: 1, completion_floor_at: null }]);
    await fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement"));
    expect(await fixture.client`select revisions_used from commission_orders where id = ${f.orderId}`).toEqual([{ revisions_used: 1 }]);
  });
  test("review_window_elapsed before the floor fails and at the floor commits", async () => {
    const f = await paidOrder(); await deliver(f.orderId); await setFloor(f.orderId, floorAt);
    await expectSqlState(complete(f.orderId, "review_window_elapsed", new Date(floorAt.getTime() - 1)));
    await complete(f.orderId, "review_window_elapsed", floorAt);
  });
  test("closed paid orders and cancelled reservations are terminal", async () => {
    const f = await paidOrder(); await fixture.client.begin((tx) => close(tx, f.orderId, "cancelled_by_agreement"));
    await expectSqlState(fixture.client`update commission_orders set state = 'in_progress', version = version + 1, closed_at = null, close_reason = null where id = ${f.orderId}`, "Forbidden commission transition");
    await expectSqlState(fixture.client`update commission_orders set version = version + 1, close_reason = 'cancelled_by_ruling' where id = ${f.orderId}`, "Forbidden commission transition");
    await expectSqlState(fixture.client`update commission_reservations set state = 'occupied', released_at = null where order_id = ${f.orderId}`, "Forbidden reservation transition");
  });
  test("I7 requested rows still insert and close as buyer_withdrawn", async () => {
    const f = await requestedOrder();
    await fixture.client.begin(async (tx) => {
      await tx`update commission_orders set state = 'closed', version = 2, close_reason = 'buyer_withdrawn', closed_at = ${closedAt.toISOString()}, updated_at = ${closedAt.toISOString()} where id = ${f.orderId}`;
      await event(tx, f.orderId, 2, "closed", closedAt);
    });
    expect(await fixture.client`select state, confirmed_at, due_at, delivered_at, completion_floor_at from commission_orders where id = ${f.orderId}`)
      .toEqual([{ state: "closed", confirmed_at: null, due_at: null, delivered_at: null, completion_floor_at: null }]);
  });
  test("I7 delivered rows still complete as buyer_accepted", async () => {
    const f = await paidOrder(); await deliver(f.orderId); await complete(f.orderId, "buyer_accepted");
    expect(await fixture.client`select state, completion_kind, completion_floor_at from commission_orders where id = ${f.orderId}`)
      .toEqual([{ state: "completed", completion_kind: "buyer_accepted", completion_floor_at: null }]);
  });
});
