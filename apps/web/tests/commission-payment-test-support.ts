import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PawketTransaction } from "@pawket/database";
import { createCommissionPaymentIntentPort, type CommissionPaymentMode } from "@pawket/payments";
import { lockCommissionCreator } from "@pawket/orders";
import { createSePayIntegrationFixture, fixtureEnvelope, fixtureHash, schema } from "../../../packages/payments/tests/sepay-integration-fixture.js";

type Base = ReturnType<typeof createSePayIntegrationFixture>;
type Creator = Awaited<ReturnType<Base["creator"]>>;
/** Synthetic commitment graph; checkout authorization is tested by the Orders service suite. */
export async function commissionFixture(base: Base, creator: Creator, options: { paymentsMode?: CommissionPaymentMode; omitPayment?: boolean; afterPayment?: (tx: PawketTransaction) => void | Promise<void> } = {}) {
  const at = creator.now(); const orderId = randomUUID(); const packageId = randomUUID(); const revisionId = randomUUID();
  const buyerUserId = `commission-buyer-${randomUUID()}`;
  await base.db.insert(schema.creatorCommissionSettings).values({ creatorUserId: creator.actor.userId, enabled: true, capacityLimit: 3, version: 1, createdAt: at, updatedAt: at }).onConflictDoNothing();
  await base.db.insert(schema.identityUsers).values({ id: buyerUserId, name: "Synthetic buyer", email: `${buyerUserId}@example.invalid`, canonicalEmail: `${buyerUserId}@example.invalid`, createdAt: at, updatedAt: at });
  let [page] = await base.db.select().from(schema.creatorPages).where(eq(schema.creatorPages.userId, creator.actor.userId));
  if (!page) [page] = await base.db.insert(schema.creatorPages).values({ id: randomUUID(), userId: creator.actor.userId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at }).returning();
  if (!page) throw new Error("Synthetic creator page missing");
  const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
    scope: "One portrait", deliverables: "PNG", usageRights: "Personal", artistTerms: "Synthetic terms only", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic commission", discipline: "illustration", route: "fixed_immediate" as const, briefInstructions: "Describe the portrait", terms, showcaseId: null };
  await base.db.insert(schema.commissionPackages).values({ id: packageId, creatorUserId: creator.actor.userId, pageId: page.id, draft, createdAt: at, updatedAt: at });
  await base.db.insert(schema.commissionPackageRevisions).values({ id: revisionId, packageId, creatorUserId: creator.actor.userId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: creator.actor.sessionId, requestId: randomUUID(), publishedAt: at });
  await base.db.update(schema.commissionPackages).set({ state: "open", version: 2, publishedRevisionId: revisionId, updatedAt: at }).where(eq(schema.commissionPackages.id, packageId));
  const payments = createCommissionPaymentIntentPort({ ...creator.common, paymentsMode: options.paymentsMode ?? "manual_only" });
  const binding = { orderId, creatorUserId: creator.actor.userId, at };
  await base.db.transaction(async (tx) => {
    await lockCommissionCreator(tx, creator.actor.userId);
    await tx.insert(schema.commissionOrders).values({ id: orderId, creatorUserId: creator.actor.userId, buyerUserId, packageId, packageRevisionId: revisionId,
      route: "fixed_immediate", state: "awaiting_payment", version: 1, amountVnd: terms.amountVnd, acceptedAt: at, expiresAt: new Date(at.getTime() + 86_400_000), createdAt: at, updatedAt: at });
    await tx.insert(schema.commissionBriefs).values({ orderId, textEnvelope: fixtureEnvelope("commission_briefs", orderId, "text", JSON.stringify("Private brief")),
      linksEnvelope: fixtureEnvelope("commission_briefs", orderId, "links", "[]"), buyerSessionId: "synthetic-buyer-session", requestId: randomUUID(), createdAt: at });
    for (const role of ["buyer", "creator"] as const) await tx.insert(schema.commissionAcceptances).values({ id: randomUUID(), orderId,
      actorUserId: role === "buyer" ? buyerUserId : creator.actor.userId, actorSessionId: role === "buyer" ? "synthetic-buyer-session" : creator.actor.sessionId,
      role, packageRevisionId: revisionId, policyRevisionId: terms.policyRevisionId, requestId: randomUUID(), acceptedAt: at });
    await tx.insert(schema.commissionTermsSnapshots).values({ orderId, packageRevisionId: revisionId, amountVnd: terms.amountVnd,
      turnaroundDays: terms.turnaroundDays, revisionAllowance: terms.revisionAllowance, reviewWindowDays: terms.reviewWindowDays, policyRevisionId: terms.policyRevisionId,
      scopeEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "scope", JSON.stringify(terms.scope)),
      deliverablesEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "deliverables", JSON.stringify(terms.deliverables)),
      usageRightsEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "usage_rights", JSON.stringify(terms.usageRights)),
      artistTermsEnvelope: fixtureEnvelope("commission_terms_snapshots", orderId, "artist_terms", JSON.stringify(terms.artistTerms)),
      buyerAcceptedAt: at, creatorAcceptedAt: at, createdAt: at });
    await tx.insert(schema.commissionReservations).values({ orderId, creatorUserId: creator.actor.userId, reservedAt: at });
    await tx.insert(schema.commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "awaiting_payment", actorUserId: buyerUserId,
      actorSessionId: "synthetic-buyer-session", requestId: randomUUID(), occurredAt: at });
    if (!options.omitPayment) await payments.createIntent(tx, { ...binding, accountVersionId: creator.accountVersionId, amountVnd: terms.amountVnd,
      creator: { displayName: "Synthetic creator", handle: "synthetic-creator" }, abuseKeyHash: fixtureHash(), requestId: randomUUID() });
    await options.afterPayment?.(tx);
  });
  const payment = await base.db.transaction((tx) => payments.projectPayment(tx, { ...binding, includeInstructions: true }));
  if (!payment) throw new Error("Synthetic commission payment missing");
  return { orderId, buyerUserId, packageId, revisionId, terms, binding, payments, payment, creator };
}
