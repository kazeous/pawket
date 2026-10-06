import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "@pawket/database";
import { commissionEvents, commissionFileAttachments, commissionFiles, commissionMessages, commissionOrders, commissionPackages,
  commissionReservations, commissionSubmissions, commissionThreadEntries, commissionThreads, systemCommandIdempotency, systemOutbox,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import { createEncryptionKeyring, createLookupHmac, decryptSensitiveField, encryptSensitiveField } from "@pawket/security";
import { createCommissionThreadPort, createCommissionThreadService, encryptCommissionFileName,
  type CommissionFileActor, type CommissionFileOrderAccessPort } from "../src/index.js";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring, fixtureLookupKey } from "./file-fixture.js";

const fixture = createCommissionFileFixture("thread");
beforeAll(fixture.initialize, 60_000); afterAll(fixture.dispose);
let clock = new Date(fixtureAt.getTime() + 2_000);
const sessions = new Map<string, string>();
const sessionPort = { getTipSessionAssurance: async (_tx: PawketTransaction, actor: CommissionFileActor, at: Date) =>
  sessions.get(actor.userId) === actor.sessionId ? { sessionExpiresAt: new Date(at.getTime() + 600_000) } : null };
const orders: Pick<CommissionFileOrderAccessPort, "lockFulfillmentOrder"> = {
  async lockFulfillmentOrder(tx, { orderId, actorUserId }) {
    const [identity] = await tx.select({ creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, orderId)).limit(1);
    if (!identity) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commissions:creator:${identity.creatorUserId}`}, 0))`);
    const [row] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, orderId), or(eq(commissionOrders.buyerUserId, actorUserId), eq(commissionOrders.creatorUserId, actorUserId)))).limit(1);
    return row ? { role: row.buyerUserId === actorUserId ? "buyer" : "creator", state: row.state, creatorUserId: row.creatorUserId } : null;
  },
};
const ids = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });
const port = (mode: "disabled" | "enabled" = "enabled") => createCommissionThreadPort({ keyring: fixtureKeyring, mode });
function service(options: Partial<Parameters<typeof createCommissionThreadService>[0]> = {}) {
  return createCommissionThreadService({ db: fixture.db, keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey,
    filesMode: "enabled", fulfillmentMode: "enabled", sessions: sessionPort, orders, now: () => clock, ...options });
}
async function paidOrder() {
  // Same normal-trigger graph as commission-threads-schema.integration.test.ts, with real payment rows.
  const creator = await party(); const buyer = await party(); const creatorUserId = creator.userId; const buyerUserId = buyer.userId;
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
  clock = confirmedAt;
  return { orderId, packageId, buyer, creator };
}
async function party() {
  const userId = await fixture.person(); const actor = { userId, sessionId: `s-${randomUUID()}` };
  sessions.set(userId, actor.sessionId); return actor;
}

type PaidOrder = Awaited<ReturnType<typeof paidOrder>>;
const command = (p: PaidOrder, actor = p.buyer, text: unknown = "Synthetic message", fileIds: unknown = []) =>
  ({ actor, orderId: p.orderId, text, fileIds, ...ids() });
async function orderFile(p: PaidOrder, options: { context?: "brief" | "thread" | "submission"; owner?: string; state?: "scanning" | "clean"; bytes?: number; type?: string } = {}) {
  const fileId = randomUUID(); const at = clock; const context = options.context ?? "thread";
  await fixture.db.insert(commissionFiles).values({ id: fileId, ownerUserId: options.owner ?? p.buyer.userId, context,
    packageId: context === "brief" ? p.packageId : null, uploadOrderId: context === "brief" ? null : p.orderId, declaredBytes: options.bytes ?? 16,
    filenameEnvelope: encryptCommissionFileName(fixtureKeyring, fileId, "Synthetic artwork"), objectKey: `commission/${fileId}`,
    uploadExpiresAt: new Date(at.getTime() + 900_000), requestId: randomUUID(), createdAt: at, updatedAt: at });
  await fixture.db.update(commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2 }).where(eq(commissionFiles.id, fileId));
  if (options.state !== "scanning") await fixture.db.update(commissionFiles).set({ state: "clean", detectedType: options.type ?? "png", sha256: `sha256:${"a".repeat(64)}`,
    cleanVersionId: "synthetic-clean", cleanAt: at, version: 3 }).where(eq(commissionFiles.id, fileId));
  return fileId;
}
async function submit(p: PaidOrder, kind: "draft" | "final" = "draft", fileIds: readonly string[] = []) {
  const submissionId = randomUUID(); const at = clock;
  await fixture.db.transaction(async (tx) => {
    await orders.lockFulfillmentOrder(tx, { orderId: p.orderId, actorUserId: p.creator.userId });
    await tx.insert(commissionSubmissions).values({ id: submissionId, orderId: p.orderId, kind, actorSessionId: p.creator.sessionId, requestId: randomUUID(), submittedAt: at });
    expect(await port().attachOrderFiles(tx, { orderId: p.orderId, ownerUserId: p.creator.userId, context: "submission", target: { kind: "submission", id: submissionId }, fileIds, at })).toBe("attached");
    await port().appendEntry(tx, { orderId: p.orderId, kind: "submission", entryId: submissionId, at });
    if (kind === "final") {
      await tx.update(commissionOrders).set({ state: "delivered", deliveredAt: at, reviewEndsAt: new Date(at.getTime() + 7 * 86_400_000), version: 3, updatedAt: at }).where(eq(commissionOrders.id, p.orderId));
      await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 3, type: "delivered", requestId: randomUUID(), occurredAt: at });
    }
  });
  return submissionId;
}
async function complete(p: PaidOrder) {
  const at = new Date(clock.getTime() + 1_000);
  await fixture.db.transaction(async (tx) => {
    await orders.lockFulfillmentOrder(tx, { orderId: p.orderId, actorUserId: p.creator.userId });
    await tx.update(commissionOrders).set({ state: "completed", completedAt: at, completionKind: "buyer_accepted", version: 4, updatedAt: at }).where(eq(commissionOrders.id, p.orderId));
    await tx.update(commissionReservations).set({ state: "completed", releasedAt: at }).where(eq(commissionReservations.orderId, p.orderId));
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 4, type: "completed", requestId: randomUUID(), occurredAt: at });
  });
}
async function assertNoMessage(orderId: string) {
  expect(await fixture.db.select({ id: commissionMessages.id }).from(commissionMessages).where(eq(commissionMessages.orderId, orderId))).toHaveLength(0);
  expect(await fixture.db.select().from(commissionThreadEntries).where(and(eq(commissionThreadEntries.orderId, orderId), eq(commissionThreadEntries.kind, "message")))).toHaveLength(0);
  expect(await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, orderId), eq(systemOutbox.eventType, "commission.message_sent.v1")))).toHaveLength(0);
}

describe("commission thread messages", () => {
  test("buyer and creator exchange messages with increasing sequences", async () => {
    const p = await paidOrder(); const messages = service();
    const first = await messages.sendMessage(command(p));
    const second = await messages.sendMessage(command(p, p.creator, "<3 a < b"));
    const third = await messages.sendMessage(command(p));
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    const described = await fixture.db.transaction((tx) => port().describeMessages(tx, { orderId: p.orderId, messageIds: [first.messageId, second.messageId, third.messageId] }));
    expect(described.get(second.messageId)).toEqual({ authorUserId: p.creator.userId, text: "<3 a < b", createdAt: clock });
    const [row] = await fixture.db.select().from(commissionMessages).where(eq(commissionMessages.id, second.messageId));
    expect(decryptSensitiveField({ keyring: fixtureKeyring, envelope: row!.textEnvelope!, binding: { recordType: "commission_messages", recordId: second.messageId, fieldName: "text" } })).toBe("<3 a < b");
    expect(JSON.stringify(row!.textEnvelope).includes("<3 a < b")).toBe(false);
  });
  test("a message with only files is accepted", async () => {
    const p = await paidOrder(); const first = await orderFile(p); const second = await orderFile(p, { type: "pdf" });
    const sent = await service().sendMessage(command(p, p.buyer, null, [second, first]));
    const described = await fixture.db.transaction((tx) => port().describeMessages(tx, { orderId: p.orderId, messageIds: [sent.messageId] }));
    expect(described.get(sent.messageId)?.text).toBeNull();
    const files = await fixture.db.transaction((tx) => port().describeAttachedFiles(tx, { orderId: p.orderId, targets: [{ kind: "message", id: sent.messageId }] }));
    expect(files.get(`message:${sent.messageId}`)?.map((file) => [file.fileId, file.detectedType, file.previewable, file.availability])).toEqual([[second, "pdf", false, "available"], [first, "png", true, "available"]]);
    const links = await fixture.db.select().from(commissionFileAttachments).where(eq(commissionFileAttachments.targetId, sent.messageId));
    expect(links.map((link) => link.position).sort()).toEqual([0, 1]);
  });
  test("whitespace-only text and no files is invalid_request", async () => {
    const p = await paidOrder();
    await expect(service().sendMessage(command(p, p.buyer, "   \n  "))).rejects.toMatchObject({ code: "invalid_request" });
    await assertNoMessage(p.orderId);
  });
  test("replay with the same idempotency key returns the same message", async () => {
    const p = await paidOrder(); const request = command(p); const messages = service();
    const first = await messages.sendMessage(request);
    expect(await messages.sendMessage({ ...request, requestId: randomUUID() })).toEqual(first);
    expect(await fixture.db.select().from(commissionMessages).where(eq(commissionMessages.orderId, p.orderId))).toHaveLength(1);
    expect(await fixture.db.select().from(commissionThreads).where(eq(commissionThreads.orderId, p.orderId))).toMatchObject([{ nextSequence: 2 }]);
    expect(await fixture.db.select().from(systemCommandIdempotency).where(eq(systemCommandIdempotency.actorUserId, p.buyer.userId))).toEqual(expect.arrayContaining([expect.objectContaining({ commandScope: "commission-files.message", resultReference: first.messageId })]));
  });
  test("same key with different text is idempotency_conflict", async () => {
    const p = await paidOrder(); const request = command(p); const messages = service(); await messages.sendMessage(request);
    await expect(messages.sendMessage({ ...request, text: "Changed synthetic message" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await fixture.db.select().from(commissionMessages).where(eq(commissionMessages.orderId, p.orderId))).toHaveLength(1);
  });
  test.each(["other_order", "submission", "oversized_submission", "brief", "scanning", "other_party", "missing", "duplicate"] as const)("files bound elsewhere are invalid_attachment_files: %s", async (kind) => {
    const p = await paidOrder(); const valid = await orderFile(p); let bad: string;
    if (kind === "other_order") bad = await orderFile(await paidOrder(), { owner: p.buyer.userId });
    else if (kind === "submission" || kind === "oversized_submission") bad = await orderFile(p, { context: "submission", owner: p.creator.userId, bytes: kind === "oversized_submission" ? 26_214_401 : 16 });
    else if (kind === "brief") bad = await orderFile(p, { context: "brief" });
    else if (kind === "scanning") bad = await orderFile(p, { state: "scanning" });
    else if (kind === "other_party") bad = await orderFile(p, { owner: p.creator.userId });
    else if (kind === "missing") bad = randomUUID();
    else bad = valid;
    await expect(service().sendMessage(command(p, p.buyer, null, [valid, bad]))).rejects.toMatchObject({ code: "invalid_attachment_files" });
    await assertNoMessage(p.orderId); expect((await fixture.read(valid)).state).toBe("clean");
    expect(await fixture.db.select().from(commissionFileAttachments).where(eq(commissionFileAttachments.fileId, valid))).toHaveLength(0);
  });
  test("an attached file cannot be reused", async () => {
    const p = await paidOrder(); const fileId = await orderFile(p); const messages = service(); await messages.sendMessage(command(p, p.buyer, null, [fileId]));
    await expect(messages.sendMessage(command(p, p.buyer, null, [fileId]))).rejects.toMatchObject({ code: "invalid_attachment_files" });
    expect(await fixture.db.select().from(commissionMessages).where(eq(commissionMessages.orderId, p.orderId))).toHaveLength(1);
  });
  test("messages are accepted on delivered orders", async () => {
    const p = await paidOrder(); await submit(p, "final"); expect((await service().sendMessage(command(p))).sequence).toBe(2);
  });
  test("messages are refused on completed orders", async () => {
    const p = await paidOrder(); await submit(p, "final"); await complete(p);
    await expect(service().sendMessage(command(p))).rejects.toMatchObject({ code: "invalid_state" }); await assertNoMessage(p.orderId);
  });
  test("messages are refused on closed orders", async () => {
    const p = await fixture.order(); await fixture.closeOrder(p.orderId, p.buyerUserId);
    const actor = { userId: p.buyerUserId, sessionId: randomUUID() }; sessions.set(actor.userId, actor.sessionId);
    await expect(service().sendMessage({ actor, orderId: p.orderId, text: "Synthetic message", fileIds: [], ...ids() })).rejects.toMatchObject({ code: "invalid_state" }); await assertNoMessage(p.orderId);
  });
  test("strangers cannot send messages", async () => {
    const p = await paidOrder(); const stranger = await party();
    await expect(service().sendMessage(command(p, stranger))).rejects.toMatchObject({ code: "not_available" }); await assertNoMessage(p.orderId);
  });
  test.each(["fulfillmentMode", "filesMode"] as const)("disabled %s refuses messages", async (mode) => {
    const p = await paidOrder();
    await expect(service({ [mode]: "disabled" }).sendMessage(command(p))).rejects.toMatchObject({ code: "fulfillment_disabled" }); await assertNoMessage(p.orderId);
  });
  test("outbox payload holds ids only", async () => {
    const p = await paidOrder(); const request = command(p); const sent = await service().sendMessage(request);
    const [event] = await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, p.orderId), eq(systemOutbox.eventType, "commission.message_sent.v1")));
    expect(Object.keys(event!.payload).sort()).toEqual(["correlationId", "messageId", "orderId", "sequence"]);
    expect(event).toMatchObject({ aggregateType: "commission_order", aggregateId: p.orderId, eventVersion: 1,
      payload: { orderId: p.orderId, messageId: sent.messageId, sequence: sent.sequence, correlationId: request.requestId } });
  });
  test("parallel messages on one order get distinct consecutive sequences", async () => {
    const p = await paidOrder(); const messages = service();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => messages.sendMessage(command(p, index % 2 === 0 ? p.buyer : p.creator))));
    expect(results.map((sent) => sent.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); expect(new Set(results.map((sent) => sent.messageId)).size).toBe(8);
  });
  test("parallel replay attaches files and sends the outbox only once", async () => {
    const p = await paidOrder(); const fileId = await orderFile(p); const request = command(p, p.buyer, null, [fileId]); const messages = service();
    const results = await Promise.all([messages.sendMessage(request), messages.sendMessage(request)]); expect(results[0]).toEqual(results[1]);
    expect(await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, p.orderId), eq(systemOutbox.eventType, "commission.message_sent.v1")))).toHaveLength(1);
  });
  test("the creator fence is taken before the session check", async () => {
    const p = await paidOrder(); const steps: string[] = [];
    const orderPort = { lockFulfillmentOrder: async (tx: PawketTransaction, request: { orderId: string; actorUserId: string }) => { steps.push("lock"); return orders.lockFulfillmentOrder(tx, request); } };
    const session = { getTipSessionAssurance: async (tx: PawketTransaction, actor: CommissionFileActor, at: Date) => { steps.push("session"); return sessionPort.getTipSessionAssurance(tx, actor, at); } };
    await service({ orders: orderPort, sessions: session }).sendMessage(command(p)); expect(steps).toEqual(["lock", "session"]);
  });
  test("revoked sessions are refused for sends and replays", async () => {
    const p = await paidOrder(); const request = command(p); const messages = service(); await messages.sendMessage(request); sessions.delete(p.buyer.userId);
    await expect(messages.sendMessage(command(p))).rejects.toMatchObject({ code: "not_authorized" });
    await expect(messages.sendMessage(request)).rejects.toMatchObject({ code: "not_authorized" });
  });
  test("a failed outbox write rolls back the message, attachments, sequence and idempotency", async () => {
    const p = await paidOrder(); const fileId = await orderFile(p); const transaction = fixture.db.transaction.bind(fixture.db);
    const db = { transaction: <T>(run: (tx: PawketTransaction) => Promise<T>) => transaction(async (tx) => {
      const insert = tx.insert.bind(tx);
      const proxy = new Proxy(tx, { get(target, property, receiver) {
        if (property === "insert") return (table: Parameters<typeof insert>[0]) => { if (table === systemOutbox) throw new Error("Synthetic outbox failure"); return insert(table); };
        return Reflect.get(target, property, receiver);
      } }); return run(proxy);
    }) } as PawketDatabase;
    const request = command(p, p.buyer, null, [fileId]);
    await expect(service({ db }).sendMessage(request)).rejects.toMatchObject({ code: "dependency_unavailable" });
    await assertNoMessage(p.orderId); expect((await fixture.read(fileId)).state).toBe("clean");
    expect(await fixture.db.select().from(commissionThreads).where(eq(commissionThreads.orderId, p.orderId))).toHaveLength(0);
    expect(await service().sendMessage(request)).toMatchObject({ sequence: 1 });
  });
});

describe("commission thread structural port", () => {
  test("raw draft submissions attach creator files in position order", async () => {
    const p = await paidOrder(); const first = await orderFile(p, { context: "submission", owner: p.creator.userId, bytes: 262_144_000, type: "psd" });
    const second = await orderFile(p, { context: "submission", owner: p.creator.userId }); const id = await submit(p, "draft", [second, first]);
    const described = await fixture.db.transaction((tx) => port().describeAttachedFiles(tx, { orderId: p.orderId, targets: [{ kind: "submission", id }] }));
    expect(described.get(`submission:${id}`)?.map((file) => [file.fileId, file.sizeBytes, file.previewable, file.availability])).toEqual([[second, 16, true, "available"], [first, 262_144_000, false, "available"]]);
  });
  test("a buyer thread file cannot be attached to a creator submission", async () => {
    const p = await paidOrder(); const fileId = await orderFile(p);
    expect(await fixture.db.transaction((tx) => port().attachOrderFiles(tx, { orderId: p.orderId, ownerUserId: p.creator.userId,
      context: "submission", target: { kind: "submission", id: randomUUID() }, fileIds: [fileId], at: clock }))).toBe("invalid"); expect((await fixture.read(fileId)).state).toBe("clean");
  });
  test("port refuses mismatched contexts, duplicates, excessive counts and disabled mode before writes", async () => {
    const p = await paidOrder(); const request = { orderId: p.orderId, ownerUserId: p.buyer.userId, context: "thread" as const,
      target: { kind: "message" as const, id: randomUUID() }, fileIds: [] as string[], at: clock };
    const cases = [{ ...request, fileIds: [randomUUID(), randomUUID()] }, { ...request, fileIds: [p.orderId, p.orderId] },
      { ...request, fileIds: Array.from({ length: 11 }, () => randomUUID()) }, { ...request, context: "submission" as const },
      { ...request, context: "submission" as const, target: { kind: "submission" as const, id: randomUUID() }, fileIds: Array.from({ length: 21 }, () => randomUUID()) }];
    for (const invalid of cases) expect(await fixture.db.transaction((tx) => port().attachOrderFiles(tx, invalid))).toBe("invalid");
    expect(await fixture.db.transaction((tx) => port("disabled").attachOrderFiles(tx, request))).toBe("disabled");
  });
  test("entries page newest first with an exclusive cursor and one extra row", async () => {
    const p = await paidOrder(); const messages = service(); await messages.sendMessage(command(p)); await submit(p); await messages.sendMessage(command(p)); await messages.sendMessage(command(p));
    const all = await fixture.db.transaction((tx) => port().listEntries(tx, { orderId: p.orderId, limit: 2 }));
    expect(all.map((entry) => [entry.sequence, entry.kind])).toEqual([[4, "message"], [3, "message"], [2, "submission"]]);
    const before = await fixture.db.transaction((tx) => port().listEntries(tx, { orderId: p.orderId, beforeSequence: 3, limit: 2 })); expect(before.map((entry) => entry.sequence)).toEqual([2, 1]);
  });
  test("descriptions are order scoped and empty inputs return empty maps", async () => {
    const p = await paidOrder(); const other = await paidOrder(); const fileId = await orderFile(other); const sent = await service().sendMessage(command(other, other.buyer, null, [fileId]));
    const messages = await fixture.db.transaction((tx) => port().describeMessages(tx, { orderId: p.orderId, messageIds: [sent.messageId] })); expect(messages.size).toBe(0);
    const files = await fixture.db.transaction((tx) => port().describeAttachedFiles(tx, { orderId: p.orderId, targets: [{ kind: "message", id: sent.messageId }] })); expect(files.get(`message:${sent.messageId}`) ?? []).toHaveLength(0);
    expect((await fixture.db.transaction((tx) => port().describeMessages(tx, { orderId: p.orderId, messageIds: [] }))).size).toBe(0);
    expect((await fixture.db.transaction((tx) => port().describeAttachedFiles(tx, { orderId: p.orderId, targets: [] }))).size).toBe(0);
  });
  test("deleted attached files retain metadata and are not previewable", async () => {
    const p = await paidOrder(); const fileId = await orderFile(p); const sent = await service().sendMessage(command(p, p.buyer, null, [fileId])); const at = new Date(clock.getTime() + 1_000);
    await fixture.db.update(commissionFiles).set({ state: "deleted", endedAt: at, updatedAt: at, version: 5 }).where(eq(commissionFiles.id, fileId));
    const described = await fixture.db.transaction((tx) => port().describeAttachedFiles(tx, { orderId: p.orderId, targets: [{ kind: "message", id: sent.messageId }] }));
    expect(described.get(`message:${sent.messageId}`)).toMatchObject([{ fileId, name: "Synthetic artwork", availability: "deleted", previewable: false }]);
  });
  test("message decryption failures return dependency_unavailable", async () => {
    const p = await paidOrder(); const sent = await service().sendMessage(command(p));
    const wrongKeyring = createEncryptionKeyring({ activeKeyId: "wrong-test", keys: { "wrong-test": new Uint8Array(32).fill(99) } });
    await expect(fixture.db.transaction((tx) => createCommissionThreadPort({ keyring: wrongKeyring, mode: "enabled" }).describeMessages(tx, { orderId: p.orderId, messageIds: [sent.messageId] }))).rejects.toMatchObject({ code: "dependency_unavailable" });
  });
});
