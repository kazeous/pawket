import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@pawket/database";
import { commissionPackages, commissionOrders, commissionEvents, commissionReservations } from "@pawket/database";
import { createLookupHmac, encryptSensitiveField } from "@pawket/security";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring, fixtureLookupKey } from "./file-fixture.js";
export { fixtureKeyring, fixtureLookupKey };
export const reportAt = new Date(fixtureAt.getTime() + 3_000);
async function party(fixture: ReturnType<typeof createCommissionFileFixture>) {
  return { userId: await fixture.person(), sessionId: `s-${randomUUID()}` };
}
async function paidOrder(fixture: ReturnType<typeof createCommissionFileFixture>) {
  // Same normal-trigger graph as commission-threads-schema.integration.test.ts, with real payment rows.
  const creator = await party(fixture); const buyer = await party(fixture); const creatorUserId = creator.userId; const buyerUserId = buyer.userId;
  const accountVersionId = randomUUID(); const packageId = randomUUID(); const packageRevisionId = randomUUID(); const pageId = randomUUID();
  const orderId = randomUUID(); const intentId = randomUUID(); const at = fixtureAt; const confirmedAt = new Date(at.getTime() + 1_000);
  const expiresAt = new Date(at.getTime() + 86_400_000);
  const envelope = <R extends string, F extends string>(recordType: R, recordId: string, fieldName: F) =>
    encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Synthetic fixture", binding: { recordType, recordId, fieldName } });
  const hash = () => createLookupHmac({ key: fixtureLookupKey, context: "synthetic-file-service", value: randomUUID() });
  const referenceHash = hash();
  await fixture.db.insert(schema.paymentsReceivingAccountOnboarding).values({ id: accountVersionId, onboardingId: randomUUID(), applicantUserId: creatorUserId, version: 1,
    bankBin: "970436", bankName: "Synthetic bank", maskedSuffix: "\u2022\u2022\u2022\u2022 0000", accountFingerprint: hash(),
    accountNumberEnvelope: envelope("payments_receiving_account", accountVersionId, "account_number"), accountHolderLabelEnvelope: envelope("payments_receiving_account", accountVersionId, "account_holder_label"),
    proofState: "verified", proofVerifiedAt: at, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorPages).values({ id: pageId, userId: creatorUserId, initializedFromRevisionId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.creatorCommissionSettings).values({ creatorUserId, enabled: true, capacityLimit: 1, createdAt: at, updatedAt: at });
  const terms = { amountVnd: 50_000, turnaroundDays: 7, revisionAllowance: 2, reviewWindowDays: 7,
    scope: "Portrait", deliverables: "Artwork", usageRights: "Personal", artistTerms: "Synthetic terms", policyRevisionId: schema.COMMISSION_POLICY_BOOTSTRAP_ID };
  const draft = { title: "Portrait", description: "Synthetic package", discipline: "illustration", route: "fixed_immediate" as const, briefInstructions: "Describe", terms, showcaseId: null };
  await fixture.db.insert(commissionPackages).values({ id: packageId, creatorUserId, pageId, draft, createdAt: at, updatedAt: at });
  await fixture.db.insert(schema.commissionPackageRevisions).values({ id: packageRevisionId, packageId, creatorUserId, revisionNumber: 1,
    ...draft, policyRevisionId: terms.policyRevisionId, actorSessionId: creator.sessionId, requestId: randomUUID(), publishedAt: at });
  await fixture.db.update(commissionPackages).set({ state: "open", version: 2, publishedRevisionId: packageRevisionId }).where(eq(commissionPackages.id, packageId));
  await fixture.db.transaction(async (tx) => {
    await tx.insert(commissionOrders).values({ id: orderId, creatorUserId, buyerUserId, packageId, packageRevisionId, route: "fixed_immediate", state: "awaiting_payment",
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
    await tx.insert(commissionReservations).values({ orderId, creatorUserId, reservedAt: at });
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 1, type: "awaiting_payment", requestId: randomUUID(), occurredAt: at });
    await tx.insert(schema.paymentIntents).values({ id: intentId, purpose: "commission", commissionOrderId: orderId, creatorUserId, amountVnd: 50_000,
      referenceHash, referenceEnvelope: envelope("payment_intents", intentId, "transfer_reference"), destinationEnvelope: envelope("payment_intents", intentId, "destination"),
      accountVersionId, abuseKeyHash: hash(), expiresAt, requestId: randomUUID(), createdAt: at, updatedAt: at });
  });
  await fixture.db.transaction(async (tx) => {
    await tx.insert(schema.paymentConfirmations).values({ id: randomUUID(), paymentIntentId: intentId, creatorUserId, accountVersionId, observedAmountVnd: 50_000,
      referenceHash, bankTransactionFingerprint: hash(), attestedReceived: true, actorSessionId: creator.sessionId, primaryAuthenticatedAt: confirmedAt,
      confirmedAt, requestId: randomUUID(), idempotencyKeyHash: hash() });
    await tx.update(schema.paymentIntents).set({ state: "confirmed", closedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(schema.paymentIntents.id, intentId));
    await tx.update(commissionOrders).set({ state: "in_progress", version: 2, confirmedAt, dueAt: new Date(confirmedAt.getTime() + 7 * 86_400_000), updatedAt: confirmedAt }).where(eq(commissionOrders.id, orderId));
    await tx.update(commissionReservations).set({ state: "occupied", occupiedAt: confirmedAt }).where(eq(commissionReservations.orderId, orderId));
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId, orderVersion: 2, type: "in_progress", requestId: randomUUID(), occurredAt: confirmedAt });
  });
  return { orderId, packageId, packageRevisionId, pageId, buyer, creator };
}

export function createReportFixture(label: string) {
  const fixture = createCommissionFileFixture(`report_${label}`);
  return { ...fixture, paidOrder: () => paidOrder(fixture),
    async message(orderId: string, authorUserId: string) {
      const id = randomUUID();
      await fixture.db.transaction(async (tx) => {
        await tx.insert(schema.commissionMessages).values({ id, orderId, authorUserId, authorSessionId: "synthetic-session", requestId: randomUUID(), createdAt: reportAt,
          textEnvelope: encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "Synthetic message", binding: { recordType: "commission_messages", recordId: id, fieldName: "text" } }) });
        await tx.insert(schema.commissionThreads).values({ orderId, createdAt: reportAt, updatedAt: reportAt }).onConflictDoNothing();
        const [thread] = await tx.select().from(schema.commissionThreads).where(eq(schema.commissionThreads.orderId, orderId)).for("update");
        await tx.insert(schema.commissionThreadEntries).values({ orderId, sequence: thread!.nextSequence, kind: "message", entryId: id, createdAt: reportAt });
        await tx.update(schema.commissionThreads).set({ nextSequence: thread!.nextSequence + 1 }).where(eq(schema.commissionThreads.orderId, orderId));
      });
      return id;
    },
    async threadFile(orderId: string, ownerUserId: string, messageId: string) {
      const id = randomUUID();
      await fixture.db.insert(schema.commissionFiles).values({ id, ownerUserId, context: "thread", uploadOrderId: orderId, declaredBytes: 16,
        filenameEnvelope: encryptSensitiveField({ keyring: fixtureKeyring, plaintext: "sample.png", binding: { recordType: "commission_files", recordId: id, fieldName: "filename" } }),
        objectKey: `commission/${id}`, uploadExpiresAt: new Date(reportAt.getTime() + 900_000), requestId: "fixture", createdAt: reportAt, updatedAt: reportAt });
      await fixture.db.update(schema.commissionFiles).set({ state: "scanning", uploadedAt: reportAt, scanDeadlineAt: new Date(reportAt.getTime() + 86_400_000), version: 2 }).where(eq(schema.commissionFiles.id, id));
      await fixture.db.update(schema.commissionFiles).set({ state: "clean", sha256: `sha256:${"c".repeat(64)}`, detectedType: "png", cleanVersionId: "c-fixture", cleanAt: reportAt, version: 3 }).where(eq(schema.commissionFiles.id, id));
      await fixture.db.transaction(async (tx) => {
        await tx.update(schema.commissionFiles).set({ state: "attached", orderId, attachedAt: reportAt, version: 4 }).where(eq(schema.commissionFiles.id, id));
        await tx.insert(schema.commissionFileAttachments).values({ fileId: id, orderId, targetKind: "message", targetId: messageId, position: 0, attachedAt: reportAt });
      });
      return id;
    },
  };
}
