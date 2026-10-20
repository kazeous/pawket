import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "@pawket/database";
import { createDatabase, insertOutboxEvent, type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createEncryptionKeyring, createLookupHmac, encryptSensitiveField } from "@pawket/security";
import type { NotificationEmailPort } from "../src/ports.js";

// Synthetic rows that satisfy the committed-graph guards, modelled on packages/trust/tests/report-fixture.ts,
// packages/trust/tests/penalty-test-fixture.ts and packages/resolutions/tests/integration-fixture.ts. Those files
// cannot be imported here because this package type-checks its tests under rootDir ".".
export const fixtureAt = new Date("2026-10-01T03:00:00Z");
const fixtureKeyring = createEncryptionKeyring({ activeKeyId: "notification-tests", keys: { "notification-tests": new Uint8Array(32).fill(81) } });
const fixtureLookupKey = new Uint8Array(32).fill(82);
const later = (ms: number) => new Date(fixtureAt.getTime() + ms);
const hash = () => createLookupHmac({ key: fixtureLookupKey, context: "notification-tests", value: randomUUID() });
const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F) =>
  encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Synthetic fixture", binding: { recordType, recordId, fieldName } });

export type CommittedRow = typeof schema.systemOutbox.$inferSelect;
export type Party = Readonly<{ userId: string; sessionId: string }>;
export type FixtureOrder = Readonly<{ orderId: string; packageId: string; packageRevisionId: string; intentId: string; buyer: Party; creator: Party }>;

export function createNotificationFixture(label: string) {
  const url = process.env.TEST_DATABASE_URL; if (!url) throw new Error("TEST_DATABASE_URL is required");
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || !/test|ci/iu.test(parsed.pathname)) throw new Error("Notifications require a dedicated local test database");
  const name = `notifications_${label}_${process.pid}_${Date.now()}`; const journal = `${name}_journal`;
  const admin = createDatabase(url);
  const scoped = new URL(url); scoped.searchParams.set("options", `-csearch_path=${name},public`);
  const database = createDatabase(scoped.toString()); const db: PawketDatabase = database.db;

  async function person(options: { verified?: boolean; accessStatus?: "active" | "access_suspended" | "closed" } = {}) {
    const id = `notify-${randomUUID()}`; const verified = options.verified ?? true;
    await db.insert(schema.identityUsers).values({ id, name: "Synthetic", email: `${id}@example.invalid`, canonicalEmail: `${id}@example.invalid`,
      emailVerified: verified, emailVerifiedAt: verified ? fixtureAt : null, emailVerificationProvenance: verified ? "password_email_challenge" : null,
      accessStatus: options.accessStatus ?? "active", createdAt: fixtureAt, updatedAt: fixtureAt });
    return id;
  }
  async function party(): Promise<Party> { return { userId: await person(), sessionId: `s-${randomUUID()}` }; }

  /** Same normal-trigger graph as the trust report fixture: an accepted fixed-price order waiting for payment. */
  async function awaitingOrder(existingCreator?: Party): Promise<FixtureOrder> {
    const creator = existingCreator ?? await party(); const buyer = await party(); const creatorUserId = creator.userId; const buyerUserId = buyer.userId;
    const [existingPage] = await db.select().from(schema.creatorPages).where(eq(schema.creatorPages.userId, creatorUserId));
    const [existingAccount] = existingCreator ? await db.select().from(schema.paymentsReceivingAccountOnboarding).where(eq(schema.paymentsReceivingAccountOnboarding.applicantUserId, creatorUserId)) : [];
    const accountVersionId = existingAccount?.id ?? randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const pageId = existingPage?.id ?? randomUUID();
    const orderId = randomUUID(); const intentId = randomUUID(); const at = fixtureAt; const expiresAt = later(86_400_000);
    if (!existingAccount) await db.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountVersionId, onboardingId: randomUUID(), applicantUserId: creatorUserId, version: 1,
      bankBin: "970436", bankName: "Synthetic bank", maskedSuffix: "•••• 0000", accountFingerprint: hash(),
      accountNumberEnvelope: envelope("payments_receiving_account", accountVersionId, "account_number"), accountHolderLabelEnvelope: envelope("payments_receiving_account", accountVersionId, "account_holder_label"),
      proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at });
    if (!existingPage) await db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
    await db.insert(schema.creatorCommissionSettings).values({ creatorUserId, enabled: true, capacityLimit: 5, createdAt: at, updatedAt: at }).onConflictDoNothing();
    const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
      scope: "Portrait", deliverables: "Artwork", usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
    const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "fixed_immediate" as const, briefInstructions: "Describe", terms, showcaseId: null };
    await db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
    await db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1,
      ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: creator.sessionId, requestId: randomUUID(), publishedAt: at });
    await db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(schema.commissionPackages.id, packageId));
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId, buyerUserId, packageId, packageRevisionId, route: "fixed_immediate", state: "awaiting_payment",
        amountVnd: 50_000, acceptedAt: at, expiresAt, createdAt: at, updatedAt: at });
      await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: envelope("commission_briefs", orderId, "text"), linksEnvelope: envelope("commission_briefs", orderId, "links"),
        buyerSessionId: buyer.sessionId, requestId: randomUUID(), createdAt: at });
      for (const role of ["buyer", "creator"] as const) await tx.insert(schema.commissionAcceptances).values({ id: randomUUID(), orderId, role,
        actorUserId: role === "buyer" ? buyerUserId : creatorUserId, actorSessionId: role === "buyer" ? buyer.sessionId : creator.sessionId,
        packageRevisionId, policyRevisionId: terms.policyRevisionId, requestId: randomUUID(), acceptedAt: at });
      await tx.insert(schema.commissionTermsSnapshots).values({ orderId, packageRevisionId, policyRevisionId: terms.policyRevisionId, amountVnd: 50_000,
        turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7, scopeEnvelope: envelope("commission_terms_snapshots", orderId, "scope"),
        deliverablesEnvelope: envelope("commission_terms_snapshots", orderId, "deliverables"), usageRightsEnvelope: envelope("commission_terms_snapshots", orderId, "usage_rights"),
        artistTermsEnvelope: envelope("commission_terms_snapshots", orderId, "artist_terms"), buyerAcceptedAt: at, creatorAcceptedAt: at, createdAt: at });
      await tx.insert(schema.commissionReservations).values({ orderId, creatorUserId, reservedAt: at });
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "awaiting_payment", requestId: randomUUID(), occurredAt: at });
      await tx.insert(schema.paymentIntents).values({ id: intentId, purpose: "commission", commissionOrderId: orderId, creatorUserId, amountVnd: 50_000,
        referenceHash: hash(), referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference"), destinationEnvelope: envelope("payment_intents", intentId, "destination"),
        accountVersionId, abuseKeyHash: hash(), expiresAt, requestId: randomUUID(), createdAt: at, updatedAt: at });
    });
    return { orderId, packageId, packageRevisionId, intentId, buyer, creator };
  }

  /** A paid order in progress (confirmed one second after acceptance). */
  async function paidOrder(existingCreator?: Party): Promise<FixtureOrder> {
    const order = await awaitingOrder(existingCreator); const confirmedAt = later(1_000);
    const [intent] = await db.select().from(schema.paymentIntents).where(eq(schema.paymentIntents.id, order.intentId));
    await db.transaction(async (tx) => {
      await tx.insert(schema.paymentConfirmations).values({ id: randomUUID(), paymentIntentId: order.intentId, creatorUserId: order.creator.userId, accountVersionId: intent!.accountVersionId,
        observedAmountVnd: 50_000, referenceHash: intent!.referenceHash, bankTransactionFingerprint: hash(), attestedReceived: true, actorSessionId: order.creator.sessionId,
        primaryAuthenticatedAt: confirmedAt, confirmedAt, requestId: randomUUID(), idempotencyKeyHash: hash() });
      await tx.update(schema.paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(schema.paymentIntents.id, order.intentId));
      await tx.update(schema.commissionOrders).set({ state: "in_progress", version: 2, confirmedAt, dueAt: new Date(confirmedAt.getTime() + 7 * 86_400_000), updatedAt: confirmedAt }).where(eq(schema.commissionOrders.id, order.orderId));
      await tx.update(schema.commissionReservations).set({ state: "occupied", occupiedAt: confirmedAt }).where(eq(schema.commissionReservations.orderId, order.orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: order.orderId, orderVersion: 2, type: "in_progress", requestId: randomUUID(), occurredAt: confirmedAt });
    });
    return order;
  }

  /** An accepted order closed unpaid at its payment expiry, so a late-payment claim can be filed. */
  async function expiredOrder(): Promise<FixtureOrder & { closedAt: Date }> {
    const order = await awaitingOrder(); const closedAt = later(86_400_000);
    await db.transaction(async (tx) => {
      await tx.update(schema.paymentIntents).set({ state: "expired", closedAt, updatedAt: closedAt }).where(eq(schema.paymentIntents.id, order.intentId));
      await tx.update(schema.commissionOrders).set({ state: "closed", version: 2, closeReason: "payment_expired", closedAt, updatedAt: closedAt }).where(eq(schema.commissionOrders.id, order.orderId));
      await tx.update(schema.commissionReservations).set({ state: "released", releasedAt: closedAt }).where(eq(schema.commissionReservations.orderId, order.orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: order.orderId, orderVersion: 2, type: "closed", reason: "payment_expired", requestId: randomUUID(), occurredAt: closedAt });
    });
    return { ...order, closedAt };
  }

  /** An open custom-quote package of a fresh creator (requests start in `requested`). */
  async function quotePackage(creator: Party) {
    const pageId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const at = fixtureAt;
    await db.insert(schema.creatorPages).values({ id: pageId, userId: creator.userId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
    await db.insert(schema.creatorCommissionSettings).values({ creatorUserId: creator.userId, enabled: true, capacityLimit: 5, createdAt: at, updatedAt: at }).onConflictDoNothing();
    // A verified receiving account, so an accepted quote can open its payment intent.
    const accountVersionId = randomUUID();
    await db.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountVersionId, onboardingId: randomUUID(), applicantUserId: creator.userId, version: 1,
      bankBin: "970436", bankName: "Synthetic bank", maskedSuffix: "•••• 0000", accountFingerprint: hash(),
      accountNumberEnvelope: envelope("payments_receiving_account", accountVersionId, "account_number"), accountHolderLabelEnvelope: envelope("payments_receiving_account", accountVersionId, "account_holder_label"),
      proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at });
    const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "custom_quote" as const, briefInstructions: "Describe", terms: null, showcaseId: null };
    await db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId: creator.userId, pageId, draft, createdAt: at, updatedAt: at });
    await db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId: creator.userId, revisionNumber: 1,
      ...draft, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, actorSessionId: creator.sessionId, requestId: randomUUID(), publishedAt: at });
    await db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(schema.commissionPackages.id, packageId));
    return { packageId, packageRevisionId, accountVersionId };
  }
  /** A custom-quote request waiting for the creator, as packages/database/tests/commissions-schema.integration.test.ts builds it. */
  async function requestedOrder(input: { expiresAt: Date; createdAt?: Date }) {
    const creator = await party(); const buyer = await party(); const { packageId, packageRevisionId, accountVersionId } = await quotePackage(creator);
    const orderId = randomUUID(); const at = input.createdAt ?? fixtureAt;
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId: creator.userId, buyerUserId: buyer.userId, packageId, packageRevisionId,
        route: "custom_quote", state: "requested", expiresAt: input.expiresAt, createdAt: at, updatedAt: at });
      await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: envelope("commission_briefs", orderId, "text"), linksEnvelope: envelope("commission_briefs", orderId, "links"),
        buyerSessionId: buyer.sessionId, requestId: randomUUID(), createdAt: at });
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "requested", actorUserId: buyer.userId, actorSessionId: buyer.sessionId,
        requestId: randomUUID(), occurredAt: at });
    });
    return { orderId, packageId, packageRevisionId, accountVersionId, buyer, creator, requestedAt: at };
  }
  /** A request the creator quoted at `issuedAt`; the order expires with the quote. */
  async function quotedOrder(input: { issuedAt: Date; expiresAt: Date }) {
    const order = await requestedOrder({ expiresAt: new Date(input.expiresAt.getTime() + 86_400_000), createdAt: fixtureAt });
    const quoteId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionQuoteRevisions).values({ id: quoteId, orderId: order.orderId, revisionNumber: 1, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID,
        amountVnd: 60_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
        scopeEnvelope: envelope("commission_quote_revisions", quoteId, "scope"), deliverablesEnvelope: envelope("commission_quote_revisions", quoteId, "deliverables"),
        usageRightsEnvelope: envelope("commission_quote_revisions", quoteId, "usage_rights"), artistTermsEnvelope: envelope("commission_quote_revisions", quoteId, "artist_terms"),
        actorSessionId: order.creator.sessionId, requestId: randomUUID(), issuedAt: input.issuedAt, expiresAt: input.expiresAt });
      await tx.update(schema.commissionOrders).set({ state: "quoted", version: 2, currentQuoteId: quoteId, expiresAt: input.expiresAt, updatedAt: input.issuedAt })
        .where(eq(schema.commissionOrders.id, order.orderId));
      await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: order.orderId, orderVersion: 2, type: "quoted", actorUserId: order.creator.userId,
        actorSessionId: order.creator.sessionId, requestId: randomUUID(), occurredAt: input.issuedAt });
    });
    return { ...order, quoteId };
  }
  /** The buyer accepts the quote at `at` inside the caller's transaction (both acceptances, the locked terms and the reservation commit together). */
  async function acceptQuote(tx: PawketTransaction, order: Readonly<{ orderId: string; quoteId: string; accountVersionId: string; buyer: Party; creator: Party }>, at: Date) {
    for (const role of ["buyer", "creator"] as const) await tx.insert(schema.commissionAcceptances).values({ id: randomUUID(), orderId: order.orderId, role,
      actorUserId: order[role].userId, actorSessionId: order[role].sessionId, packageRevisionId: (await tx.select({ id: schema.commissionOrders.packageRevisionId })
        .from(schema.commissionOrders).where(eq(schema.commissionOrders.id, order.orderId)))[0]!.id,
      quoteRevisionId: order.quoteId, policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, requestId: randomUUID(), acceptedAt: at });
    const [current] = await tx.select().from(schema.commissionOrders).where(eq(schema.commissionOrders.id, order.orderId));
    await tx.insert(schema.commissionTermsSnapshots).values({ orderId: order.orderId, packageRevisionId: current!.packageRevisionId, quoteRevisionId: order.quoteId,
      policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, amountVnd: 60_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
      scopeEnvelope: envelope("commission_terms_snapshots", order.orderId, "scope"), deliverablesEnvelope: envelope("commission_terms_snapshots", order.orderId, "deliverables"),
      usageRightsEnvelope: envelope("commission_terms_snapshots", order.orderId, "usage_rights"), artistTermsEnvelope: envelope("commission_terms_snapshots", order.orderId, "artist_terms"),
      buyerAcceptedAt: at, creatorAcceptedAt: at, createdAt: at });
    await tx.insert(schema.commissionReservations).values({ orderId: order.orderId, creatorUserId: order.creator.userId, reservedAt: at });
    await tx.update(schema.commissionOrders).set({ state: "awaiting_payment", version: current!.version + 1, acceptedAt: at, amountVnd: 60_000,
      expiresAt: new Date(at.getTime() + 86_400_000), updatedAt: at }).where(eq(schema.commissionOrders.id, order.orderId));
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: order.orderId, orderVersion: current!.version + 1, type: "awaiting_payment",
      actorUserId: order.buyer.userId, actorSessionId: order.buyer.sessionId, requestId: randomUUID(), occurredAt: at });
    const intentId = randomUUID();
    await tx.insert(schema.paymentIntents).values({ id: intentId, purpose: "commission", commissionOrderId: order.orderId, creatorUserId: order.creator.userId, amountVnd: 60_000,
      referenceHash: hash(), referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference"), destinationEnvelope: envelope("payment_intents", intentId, "destination"),
      accountVersionId: order.accountVersionId, abuseKeyHash: hash(), expiresAt: new Date(at.getTime() + 86_400_000), requestId: randomUUID(), createdAt: at, updatedAt: at });
  }

  async function owner() {
    const [grant] =await db.select().from(schema.identityRoleGrants).where(and(eq(schema.identityRoleGrants.role, "owner"), eq(schema.identityRoleGrants.state, "active")));
    if (grant) return grant.userId;
    const userId = await person(); await db.insert(schema.identityRoleGrants).values({ userId, role: "owner", grantSource: "bootstrap_cli" }); return userId;
  }

  async function outbox(eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>, occurredAt = later(60_000)): Promise<CommittedRow> {
    const id = await db.transaction((tx) => insertOutboxEvent(tx, { eventType, eventVersion: 1, aggregateType, aggregateId, payload, occurredAt }));
    const [row] = await db.select().from(schema.systemOutbox).where(eq(schema.systemOutbox.id, id)); return row!;
  }

  async function proposal(order: FixtureOrder, proposerRole: "buyer" | "creator") {
    const id = randomUUID(); const createdAt = later(2_000);
    await db.insert(schema.commissionProposals).values({ id, orderId: order.orderId, proposerUserId: order[proposerRole].userId, proposerRole, kind: "cancel_with_refund",
      refundAmountVnd: 10_000, noteEnvelope: envelope("commission_proposals", id, "note"), orderStateAtCreation: "in_progress", respondBy: new Date(createdAt.getTime() + 72 * 3_600_000),
      createdAt, actorSessionId: order[proposerRole].sessionId, requestId: randomUUID() });
    return id;
  }
  async function endProposal(id: string, state: "declined" | "expired") {
    await db.update(schema.commissionProposals).set({ state, endedAt: later(3_000), version: 2 }).where(eq(schema.commissionProposals.id, id));
  }
  async function dispute(order: FixtureOrder, openerRole: "buyer" | "creator") {
    const id = randomUUID(); const openedAt = later(4_000);
    await db.insert(schema.commissionDisputes).values({ id, orderId: order.orderId, openerUserId: order[openerRole].userId, openerRole, trigger: "overdue", triggerAt: openedAt,
      reason: "not_delivered", requestedOutcome: "close", requestedRefundVnd: 10_000, orderStateAtOpen: "in_progress", respondBy: new Date(openedAt.getTime() + 5 * 86_400_000), openedAt });
    return id;
  }
  async function statement(disputeId: string, authorUserId: string, authorRole: "buyer" | "creator" | "owner", kind?: "response" | "statement",
    executor: PawketDatabase | PawketTransaction = db) {
    const id = randomUUID();
    await executor.insert(schema.commissionDisputeStatements).values({ id, disputeId, authorUserId, authorRole, kind: kind ?? (authorRole === "owner" ? "question" : "statement"),
      textEnvelope: envelope("commission_dispute_statements", id, "text"), actorSessionId: `s-${randomUUID()}`, requestId: randomUUID(), createdAt: later(5_000) });
    return id;
  }
  async function closeDispute(disputeId: string) {
    await db.update(schema.commissionDisputes).set({ state: "withdrawn", closedAt: later(6_000), version: 2 }).where(eq(schema.commissionDisputes.id, disputeId));
  }
  async function ruling(disputeId: string, ownerUserId: string) {
    const id = randomUUID();
    await db.insert(schema.commissionRulings).values({ id, disputeId, outcome: "close", refundAmountVnd: 10_000, reasoningEnvelope: envelope("commission_rulings", id, "reasoning"),
      policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID, ownerUserId, actorSessionId: "owner-session", stepUpProofId: `proof-${randomUUID()}`, requestId: randomUUID(), ruledAt: later(7_000) });
    return id;
  }
  async function correction(rulingId: string, ownerUserId: string) {
    const id = randomUUID();
    await db.insert(schema.commissionRulingCorrections).values({ id, rulingId, refundAmountVnd: 5_000, reasonEnvelope: envelope("commission_ruling_corrections", id, "reason"),
      effect: "reduced", ownerUserId, actorSessionId: "owner-session", stepUpProofId: `proof-${randomUUID()}`, requestId: randomUUID(), correctedAt: later(8_000) });
    return id;
  }
  async function lateClaim(order: FixtureOrder & { closedAt: Date }) {
    const id = randomUUID(); const filedAt = new Date(order.closedAt.getTime() + 1_000);
    await db.insert(schema.commissionLatePaymentClaims).values({ id, orderId: order.orderId, buyerUserId: order.buyer.userId, transferAt: order.closedAt, claimedAmountVnd: 50_000,
      referenceEnvelope: envelope("commission_late_payment_claims", id, "bank_reference"), creatorRespondBy: new Date(filedAt.getTime() + 5 * 86_400_000), filedAt });
    return id;
  }

  async function trustCase(tx: PawketTransaction, input: { kind: string; sourceType: string; sourceId: string; orderId: string | null; at?: Date }) {
    const id = randomUUID(); const at = input.at ?? later(9_000);
    await tx.insert(schema.trustCases).values({ id, kind: input.kind, orderId: input.orderId, sourceType: input.sourceType, sourceId: input.sourceId, openedAt: at });
    await tx.insert(schema.trustCaseEvents).values({ id: randomUUID(), caseId: id, action: "opened", requestId: randomUUID(), expectedVersion: 0, resultingVersion: 1, afterState: "open", occurredAt: at });
    return id;
  }
  async function openCase(input: { kind: string; sourceType: string; sourceId: string; orderId: string | null }) { return db.transaction((tx) => trustCase(tx, input)); }

  async function message(orderId: string, authorUserId: string) {
    const id = randomUUID(); const at = later(2_000);
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionMessages).values({ id, orderId, authorUserId, authorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: at,
        textEnvelope: envelope("commission_messages", id, "text") });
      await tx.insert(schema.commissionThreads).values({ orderId, createdAt: at, updatedAt: at }).onConflictDoNothing();
      const [thread] = await tx.select().from(schema.commissionThreads).where(eq(schema.commissionThreads.orderId, orderId)).for("update");
      await tx.insert(schema.commissionThreadEntries).values({ orderId, sequence: thread!.nextSequence, kind: "message", entryId: id, createdAt: at });
      await tx.update(schema.commissionThreads).set({ nextSequence: thread!.nextSequence + 1 }).where(eq(schema.commissionThreads.orderId, orderId));
    });
    return id;
  }
  /** A report case about a creator's message in the order, with one report per given reporter. */
  async function reportCase(order: FixtureOrder, reporterUserIds: readonly string[]) {
    const messageId = await message(order.orderId, order.creator.userId);
    const caseId = await openCase({ kind: "report", sourceType: "commission_message", sourceId: messageId, orderId: order.orderId });
    const reportIds: string[] = [];
    for (const reporterUserId of reporterUserIds) {
      const id = randomUUID(); reportIds.push(id);
      await db.insert(schema.trustReports).values({ id, reportReference: `report:v2:${randomBytes(24).toString("base64url")}`, targetKind: "commission_message", targetId: messageId,
        orderId: order.orderId, contentOwnerUserId: order.creator.userId, reporterUserId, reason: "other", caseId, createdAt: later(10_000) });
    }
    return { caseId, messageId, reportIds };
  }
  async function hide(order: FixtureOrder, report: { caseId: string; messageId: string }, ownerUserId: string) {
    const id = randomUUID();
    await db.insert(schema.trustContentHides).values({ id, caseId: report.caseId, targetKind: "commission_message", targetId: report.messageId, orderId: order.orderId,
      contentOwnerUserId: order.creator.userId, hiddenAt: later(11_000), hiddenByUserId: ownerUserId, hiddenBySessionId: "owner-session",
      reasonEnvelope: envelope("trust_content_hides", id, "reason"), requestId: randomUUID() });
    return id;
  }
  async function restore(hideId: string, ownerUserId: string) {
    await db.update(schema.trustContentHides).set({ releasedAt: later(12_000), releasedByUserId: ownerUserId, releaseKind: "owner_restore", releaseRequestId: randomUUID() })
      .where(eq(schema.trustContentHides.id, hideId));
  }
  async function penalty(subjectUserId: string, kind: "warning" | "restriction" | "suspension" | "removal", ownerUserId: string, endsAt?: Date | null) {
    const id = randomUUID();
    const sourceCaseId = await openCase({ kind: "report", sourceType: "commission_package", sourceId: randomUUID(), orderId: null });
    await db.insert(schema.trustPenalties).values({ id, subjectUserId, kind, restriction: kind === "restriction" ? "reporting" : null,
      target: kind === "suspension" || kind === "removal" ? "creator_capability" : null, reasonCategory: "other", explanationEnvelope: envelope("trust_penalties", id, "explanation"),
      sourceCaseId, startsAt: later(13_000), endsAt: endsAt !== undefined ? endsAt : kind === "restriction" || kind === "suspension" ? later(86_400_000 * 3) : null,
      ownerUserId, ownerSessionId: "owner-session", stepUpProofId: randomUUID(), requestId: randomUUID(), createdAt: later(13_000) });
    return id;
  }
  /** Files an appeal; with `outer`, inside the caller's transaction (as the appeal service does under its penalty or hide lock). */
  async function appeal(appellantUserId: string, target: { penaltyId: string } | { hideId: string }, outer?: PawketTransaction) {
    const id = randomUUID(); const at = later(14_000);
    const file = async (tx: PawketTransaction) => {
      const opened = await trustCase(tx, { kind: "appeal", sourceType: "trust_appeal", sourceId: id, orderId: null, at });
      await tx.insert(schema.trustAppeals).values({ id, appellantUserId, penaltyId: "penaltyId" in target ? target.penaltyId : null, hideId: "hideId" in target ? target.hideId : null,
        statementEnvelope: envelope("trust_appeals", id, "statement"), submittedVia: "session", caseId: opened, createdAt: at });
      return opened;
    };
    const caseId = outer ? await file(outer) : await db.transaction(file);
    return { appealId: id, caseId };
  }
  async function decideAppeal(appealId: string, ownerUserId: string, state: "upheld" | "reversed") {
    await db.update(schema.trustAppeals).set({ state, reasoningEnvelope: envelope("trust_appeals", appealId, "reasoning"), decidedAt: later(15_000), decidedByUserId: ownerUserId, version: 2 })
      .where(eq(schema.trustAppeals.id, appealId));
  }

  /** A guest tip waiting for transfer, as in apps/worker/tests/tip-worker.integration.test.ts. */
  async function tipIntent(creatorUserId: string) {
    const settingId = randomUUID(); const accountId = randomUUID(); const tipId = randomUUID(); const intentId = randomUUID(); const at = fixtureAt;
    await db.transaction(async (tx) => {
      await tx.insert(schema.creatorTipSettingRevisions).values({ id: settingId, creatorUserId, revisionNumber: 1, enabled: true, platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID,
        minimumVnd: 10_000, maximumVnd: 5_000_000, presetsVnd: [20_000, 50_000, 100_000], actorSessionId: "synthetic", requestId: randomUUID(), createdAt: at });
      await tx.insert(schema.creatorTipSettings).values({ creatorUserId, revisionId: settingId, createdAt: at, updatedAt: at });
      await tx.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountId, onboardingId: randomUUID(), applicantUserId: creatorUserId, version: 1, bankBin: "970436", bankName: "Synthetic bank",
        maskedSuffix: "•••• 0001", accountFingerprint: hash(), accountNumberEnvelope: envelope("payments_receiving_account", accountId, "account_number"),
        accountHolderLabelEnvelope: envelope("payments_receiving_account", accountId, "account_holder_label"), proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at });
      await tx.insert(schema.tips).values({ id: tipId, creatorUserId, settingRevisionId: settingId, platformPolicyRevisionId: schema.PLATFORM_TIP_POLICY_BOOTSTRAP_ID, amountVnd: 50_000,
        guestContentEnvelope: envelope("tips", tipId, "guest_content"), createdAt: at, updatedAt: at });
      await tx.insert(schema.paymentIntents).values({ id: intentId, tipId, creatorUserId, amountVnd: 50_000, referenceHash: hash(),
        referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference"), destinationEnvelope: envelope("payment_intents", intentId, "destination"),
        accountVersionId: accountId, abuseKeyHash: hash(), expiresAt: later(86_400_000), requestId: randomUUID(), createdAt: at, updatedAt: at });
      await tx.insert(schema.paymentGuestCapabilities).values({ id: randomUUID(), paymentIntentId: intentId, capabilityHash: hash(), createdAt: at, expiresAt: later(604_800_000) });
    });
    return { tipId, intentId };
  }

  async function application(userId: string) {
    const applicationId = randomUUID(); const revisionId = randomUUID();
    await db.insert(schema.creatorApplications).values({ id: applicationId, userId, state: "approved", createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.insert(schema.creatorApplicationRevisions).values({ id: revisionId, applicationId, revisionNumber: 1, createdAt: fixtureAt, updatedAt: fixtureAt });
    return { applicationId, revisionId };
  }
  async function capability(userId: string) {
    const { applicationId, revisionId } = await application(userId); const id = randomUUID();
    await db.insert(schema.identityCreatorCapabilities).values({ id, userId, state: "active", approvedApplicationId: applicationId, approvedRevisionId: revisionId, createdAt: fixtureAt, updatedAt: fixtureAt });
    return id;
  }
  /** A verification-deposit refund obligation, as seeded by packages/admin/tests/creator-review.integration.test.ts. */
  async function depositObligation(userId: string, ownerUserId: string) {
    const { applicationId, revisionId } = await application(userId);
    const accountId = randomUUID(); const challengeId = randomUUID(); const receiptId = randomUUID(); const obligationId = randomUUID(); const proofId = randomUUID();
    const fingerprint = hash(); const at = fixtureAt.toISOString();
    await db.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountId, onboardingId: randomUUID(), applicantUserId: userId, version: 1, bankBin: "970436", bankName: "Synthetic bank",
      maskedSuffix: "•••• 0002", accountFingerprint: fingerprint, accountNumberEnvelope: envelope("payments_receiving_account", accountId, "account_number"),
      accountHolderLabelEnvelope: envelope("payments_receiving_account", accountId, "account_holder_label"), proofState: "verified", proofVerifiedAt: fixtureAt, createdAt: fixtureAt, updatedAt: fixtureAt });
    await db.execute(sql`insert into payments_verification_deposit_challenges (id, application_id, revision_id, account_version_id, amount_vnd, reference_hash, state,
      issued_by_owner_user_id, step_up_proof_id, issued_at, expires_at, verified_at, created_at, updated_at)
      values (${challengeId}, ${applicationId}, ${revisionId}, ${accountId}, 20000, ${`sha256:v1:${"a".repeat(43)}`}, 'verified', ${ownerUserId}, ${proofId},
        ${at}, ${later(72 * 3_600_000).toISOString()}, ${at}, ${at}, ${at})`);
    await db.execute(sql`insert into payments_verification_deposit_receipts (id, challenge_id, bank_transaction_fingerprint, actual_amount_vnd, actual_reference_hash,
      received_at, source_bank_bin, source_account_fingerprint, source_masked_suffix, private_note, result, reconciled_by_owner_user_id, owner_session_id, step_up_proof_id, request_id, created_at)
      values (${receiptId}, ${challengeId}, ${hash()}, 20000, ${`sha256:v1:${"a".repeat(43)}`}, ${at}, '970436', ${fingerprint}, ${"•••• 0002"}, 'matched', 'matched',
        ${ownerUserId}, 'owner-session', ${proofId}, 'seed-request', ${at})`);
    await db.execute(sql`insert into system_business_calendar_versions (version, source_label, published_at, imported_at)
      values ('vn-notify', 'test', ${at}, ${at}) on conflict do nothing`);
    await db.execute(sql`insert into payments_verification_deposit_refund_obligations (id, receipt_id, challenge_id, account_version_id, applicant_user_id, amount_vnd,
      locked_bank_bin, locked_bank_name, locked_account_number_envelope, locked_account_holder_label_envelope, locked_masked_suffix, locked_account_fingerprint,
      calendar_version, receipt_date, refund_not_before, refund_due, state, created_at, updated_at)
      values (${obligationId}, ${receiptId}, ${challengeId}, ${accountId}, ${userId}, 20000, '970436', 'Synthetic bank',
        ${JSON.stringify(envelope("payments_verification_deposit_refund_obligation", obligationId, "locked_account_number"))}::jsonb,
        ${JSON.stringify(envelope("payments_verification_deposit_refund_obligation", obligationId, "locked_account_holder_label"))}::jsonb,
        ${"•••• 0002"}, ${fingerprint}, 'vn-notify', '2026-10-01', '2026-10-08', '2026-10-10', 'pending_window', ${at}, ${at})`);
    return obligationId;
  }

  let calendar: Promise<void> | undefined;
  /** A refund obligation in awaiting_destination (the only state the guard lets an insert use), bound to the order's confirmed or expired intent. */
  async function refundObligation(order: FixtureOrder, source = "agreement") {
    calendar ??= db.transaction((tx) => schema.importConfiguredBusinessCalendarVersion(tx, { version: "vn-notify-refund", holidayDates: [] })).then(() => undefined);
    await calendar;
    const id = randomUUID(); const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    await db.insert(schema.commissionRefundObligations).values({ id, orderId: order.orderId, paymentIntentId: order.intentId, creatorUserId: order.creator.userId,
      buyerUserId: order.buyer.userId, source, sourceId: randomUUID(), amountVnd: 10_000, calendarVersion: "vn-notify-refund",
      reference: `PKR${[...randomBytes(12)].map((byte) => alphabet[byte & 31]).join("")}`, createdAt: later(20_000), updatedAt: later(20_000) });
    return id;
  }
  /** A committed refund event row. Notices read the row's obligation and action, not the obligation's current state. */
  async function refundEvent(obligationId: string, action: string, options: { occurredAt?: Date; toState?: string } = {}) {
    const id = randomUUID();
    await db.insert(schema.commissionRefundEvents).values({ id, obligationId, action, fromState: null, toState: options.toState ?? "awaiting_destination",
      requestId: randomUUID(), occurredAt: options.occurredAt ?? later(21_000) });
    return id;
  }
  async function refundRow(obligationId: string) {
    const [row] = await db.select().from(schema.commissionRefundObligations).where(eq(schema.commissionRefundObligations.id, obligationId)); return row!;
  }
  /** The buyer entered a destination at `enteredAt`; the creator must send by `dueAt`. */
  async function refundAwaitingSend(obligationId: string, input: { enteredAt: Date; dueAt: Date }) {
    const row = await refundRow(obligationId);
    await db.update(schema.commissionRefundObligations).set({ state: "awaiting_send", destinationBankBin: "970436", destinationBankName: "Synthetic bank", destinationSuffix: "0000",
      destinationAccountEnvelope: envelope("commission_refund_obligation", obligationId, "account_number"),
      destinationHolderEnvelope: envelope("commission_refund_obligation", obligationId, "holder_name"),
      destinationEnteredAt: input.enteredAt, dueAt: input.dueAt, version: row.version + 1, updatedAt: input.enteredAt })
      .where(eq(schema.commissionRefundObligations.id, obligationId));
    await refundEvent(obligationId, "destination_entered", { occurredAt: input.enteredAt, toState: "awaiting_send" });
  }
  /** The creator recorded a send at `recordedAt`; the buyer confirms within seven days. */
  async function refundSent(obligationId: string, recordedAt: Date) {
    const row = await refundRow(obligationId); const sendId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(schema.commissionRefundSends).values({ id: sendId, obligationId, transferDate: recordedAt.toISOString().slice(0, 10),
        referenceEnvelope: envelope("commission_refund_send", sendId, "bank_reference"), actorUserId: row.creatorUserId, actorSessionId: "synthetic-creator",
        requestId: randomUUID(), recordedAt });
      await tx.update(schema.commissionRefundObligations).set({ state: "sent", currentSendId: sendId, confirmBy: new Date(recordedAt.getTime() + 7 * 86_400_000),
        version: row.version + 1, updatedAt: recordedAt }).where(eq(schema.commissionRefundObligations.id, obligationId));
    });
    await refundEvent(obligationId, "sent_recorded", { occurredAt: recordedAt, toState: "sent" });
    return sendId;
  }
  /** The buyer denied receipt and the owner required a new send at `at`, due at `dueAt`. */
  async function refundResend(obligationId: string, input: { deniedAt: Date; at: Date; dueAt: Date }) {
    const row = await refundRow(obligationId);
    await db.update(schema.commissionRefundObligations).set({ state: "not_received", version: row.version + 1, updatedAt: input.deniedAt })
      .where(eq(schema.commissionRefundObligations.id, obligationId));
    await refundEvent(obligationId, "receipt_denied", { occurredAt: input.deniedAt, toState: "not_received" });
    await db.update(schema.commissionRefundObligations).set({ state: "awaiting_send", currentSendId: null, confirmBy: null, dueAt: input.dueAt,
      version: row.version + 2, updatedAt: input.at }).where(eq(schema.commissionRefundObligations.id, obligationId));
    await refundEvent(obligationId, "resend_required", { occurredAt: input.at, toState: "awaiting_send" });
  }
  /** An open (unanswered) draft submission of a paid order; a final one is not needed because notices read only the committed kind. */
  async function submission(order: FixtureOrder, kind: "draft" | "final") {
    const id = randomUUID(); const submittedAt = later(30_000);
    await db.transaction(async (tx) => {
      if (kind === "final") {
        await tx.update(schema.commissionOrders).set({ state: "delivered", deliveredAt: submittedAt, reviewEndsAt: later(30_000 + 7 * 86_400_000), version: 3, updatedAt: submittedAt })
          .where(eq(schema.commissionOrders.id, order.orderId));
        await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId: order.orderId, orderVersion: 3, type: "delivered", requestId: randomUUID(), occurredAt: submittedAt });
      }
      await tx.insert(schema.commissionSubmissions).values({ id, orderId: order.orderId, kind, actorSessionId: order.creator.sessionId, requestId: randomUUID(), submittedAt });
    });
    return id;
  }
  /** An owner grant besides the active one. The partial unique index allows only one active owner, so extra active grants need `withManyOwners`. */
  async function ownerGrant(state: "active" | "revoked") {
    const userId = await person();
    await db.insert(schema.identityRoleGrants).values({ userId, role: "owner", grantSource: "bootstrap_cli", state, revokedAt: state === "revoked" ? fixtureAt : null });
    return userId;
  }
  /** Lifts the one-active-owner index for one callback, so the "every active owner" loop can be exercised; the index is restored afterwards. */
  async function withManyOwners<T>(run: () => Promise<T>): Promise<T> {
    await db.execute(sql.raw("drop index identity_role_grants_one_active_owner_uidx"));
    try { return await run(); }
    finally {
      await db.execute(sql.raw("update identity_role_grants set state = 'revoked', revoked_at = now() where role = 'owner' and state = 'active' and id <> (select id from identity_role_grants where role = 'owner' and state = 'active' order by created_at limit 1)"));
      await db.execute(sql.raw(`create unique index identity_role_grants_one_active_owner_uidx on identity_role_grants (role) where role = 'owner' and state = 'active'`));
    }
  }

  async function optOut(userId: string, category: string) {
    await db.insert(schema.notificationPreferences).values({ userId, category, channel: "email" });
  }

  return { db, scopedUrl: scoped.toString(), person, party, awaitingOrder, paidOrder, expiredOrder, owner, outbox, proposal, endProposal, dispute, statement, closeDispute, ruling, correction, lateClaim,
    openCase, message, reportCase, hide, restore, penalty, appeal, decideAppeal, tipIntent, application, capability, depositObligation, optOut,
    refundObligation, refundEvent, submission, ownerGrant, withManyOwners,
    requestedOrder, quotedOrder, acceptQuote, refundAwaitingSend, refundSent, refundResend,
    async initialize() {
      await admin.db.execute(sql.raw(`create schema "${name}"`));
      await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../database/migrations/", import.meta.url)), migrationsSchema: journal });
    },
    async dispose() {
      await database.close();
      await admin.db.execute(sql.raw(`drop schema if exists "${name}" cascade`)); await admin.db.execute(sql.raw(`drop schema if exists "${journal}" cascade`));
      await admin.close();
    },
  };
}

/** Mirrors the worker email port: a verified address gets a pending notification handoff, otherwise attention_required. */
export function createTestEmailPort(options: { fail?: boolean } = {}) {
  const calls: Parameters<NotificationEmailPort["queue"]>[1][] = [];
  const port: NotificationEmailPort = {
    async queue(tx, input) {
      calls.push(input);
      if (options.fail) throw new Error("synthetic email failure");
      const [user] = await tx.select({ email: schema.identityUsers.email, emailVerified: schema.identityUsers.emailVerified }).from(schema.identityUsers)
        .where(eq(schema.identityUsers.id, input.userId));
      if (!user) throw new Error("missing user");
      const handoffId = randomUUID();
      const templateData = { kind: input.kind, variant: input.variant ?? "", category: input.category, linkPath: input.linkPath };
      await tx.insert(schema.identityEmailHandoffs).values({ id: handoffId, purpose: "notification", userId: input.userId, templateData, availableAt: input.at, createdAt: input.at, updatedAt: input.at,
        ...(user.emailVerified
          ? { status: "pending", destinationEnvelope: envelope("identity_email_handoff", handoffId, "destination") }
          : { status: "attention_required", destinationEnvelope: null, failureCode: "no_verified_destination" }) });
      return { handoffId, outcome: user.emailVerified ? "queued" as const : "attention_required" as const };
    },
  };
  return { port, calls };
}
