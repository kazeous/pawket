import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { commissionEvents, commissionFileAttachments, commissionFiles, commissionOrders, commissionPackages, commissionReservations,
  commissionSubmissions, commissionThreadEntries, commissionThreads, identityRoleGrants, systemCommandIdempotency, systemOutbox,
  type PawketDatabase, type PawketTransaction } from "@pawket/database";
import * as schema from "@pawket/database";
import { createLookupHmac, encryptSensitiveField } from "@pawket/security";
import { createCommissionFileService, encryptCommissionFileName, normalizeCommissionFileName, type CommissionFileOrderAccessPort } from "../src/index.js";
import { createFakeCommissionFileStorage } from "./fakes.js";
import { createCommissionFileFixture, fixtureAt, fixtureKeyring, fixtureLookupKey } from "./file-fixture.js";

const fixture = createCommissionFileFixture("service");
beforeAll(fixture.initialize, 60_000);
afterAll(fixture.dispose);
const fulfillmentFixture = fixture;
let clock = fixtureAt;
const sessions = new Map<string, string>();
const sessionPort = { getTipSessionAssurance: async (_tx: PawketTransaction, actor: { userId: string; sessionId: string }, at: Date) =>
  sessions.get(actor.userId) === actor.sessionId ? { sessionExpiresAt: new Date(at.getTime() + 600_000) } : null };
// Structural test double; the web integration tests exercise the Orders implementation.
const orders: Pick<CommissionFileOrderAccessPort, "briefPackage" | "orderAccess" | "lockFulfillmentOrder"> = {
  async briefPackage(tx, { packageId, actorUserId }) {
    const [row] = await tx.select({ creatorUserId: commissionPackages.creatorUserId })
      .from(commissionPackages).where(eq(commissionPackages.id, packageId)).limit(1);
    return row && row.creatorUserId !== actorUserId ? { creatorUserId: row.creatorUserId } : null;
  },
  async orderAccess(tx, { orderId, actorUserId }) {
    const [row] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, orderId), or(eq(commissionOrders.buyerUserId, actorUserId), eq(commissionOrders.creatorUserId, actorUserId)))).limit(1);
    return row ? { role: row.buyerUserId === actorUserId ? "buyer" : "creator", state: row.state, confirmedAt: row.confirmedAt, closedAt: row.closedAt } : null;
  },
  async lockFulfillmentOrder(tx, { orderId, actorUserId }) {
    const [identity] = await tx.select({ creatorUserId: commissionOrders.creatorUserId }).from(commissionOrders).where(eq(commissionOrders.id, orderId)).limit(1);
    if (!identity) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commissions:creator:${identity.creatorUserId}`}, 0))`);
    const [row] = await tx.select().from(commissionOrders).where(and(eq(commissionOrders.id, orderId), or(eq(commissionOrders.buyerUserId, actorUserId), eq(commissionOrders.creatorUserId, actorUserId)))).limit(1);
    return row ? { role: row.buyerUserId === actorUserId ? "buyer" : "creator", state: row.state, creatorUserId: row.creatorUserId } : null;
  },
};
function service(mode: "disabled" | "enabled" = "enabled", fulfillmentMode: "disabled" | "enabled" = "enabled", db: PawketDatabase = fixture.db) {
  const storage = createFakeCommissionFileStorage();
  const presignUpload = vi.spyOn(storage.port, "presignUpload"); const presignDownload = vi.spyOn(storage.port, "presignDownload");
  return { storage, presignUpload, presignDownload, files: createCommissionFileService({ db, storage: storage.port, keyring: fixtureKeyring, lookupHmacKey: fixtureLookupKey,
    mode, fulfillmentMode, sessions: sessionPort, orders, now: () => clock }) };
}
async function participants() {
  const order = await fixture.order();
  const buyer = { userId: order.buyerUserId, sessionId: `s-${randomUUID()}` }; const creator = { userId: order.creatorUserId, sessionId: `s-${randomUUID()}` };
  sessions.set(buyer.userId, buyer.sessionId); sessions.set(creator.userId, creator.sessionId);
  return { ...order, buyer, creator };
}
const ids = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID() });

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
function upload(p: PaidOrder, context: "thread" | "submission", actor = p.creator, declaredBytes = 16) {
  return { actor, context, orderId: p.orderId, fileName: "Synthetic artwork", declaredBytes, ...ids() };
}
async function orderFile(p: PaidOrder, declaredBytes: number) {
  const id = randomUUID();
  await fulfillmentFixture.db.insert(commissionFiles).values({ id, ownerUserId: p.creator.userId, context: "submission", uploadOrderId: p.orderId, declaredBytes,
    filenameEnvelope: encryptCommissionFileName(fixtureKeyring, id, "Synthetic artwork"), objectKey: `commission/${id}`,
    uploadExpiresAt: new Date(clock.getTime() + 900_000), requestId: randomUUID(), createdAt: clock, updatedAt: clock });
  return id;
}
async function deliver(p: PaidOrder) {
  const fileId = await orderFile(p, 16); const at = clock;
  await fulfillmentFixture.db.update(commissionFiles).set({ state: "scanning", uploadedAt: at, scanDeadlineAt: new Date(at.getTime() + 86_400_000), version: 2 }).where(eq(commissionFiles.id, fileId));
  await fulfillmentFixture.db.update(commissionFiles).set({ state: "clean", detectedType: "png", sha256: `sha256:${"a".repeat(64)}`,
    cleanVersionId: "synthetic-clean", cleanAt: at, version: 3 }).where(eq(commissionFiles.id, fileId));
  await fulfillmentFixture.db.transaction(async (tx) => {
    const submissionId = randomUUID();
    await tx.insert(commissionThreads).values({ orderId: p.orderId, createdAt: at, updatedAt: at });
    await tx.update(commissionThreads).set({ nextSequence: 2 }).where(eq(commissionThreads.orderId, p.orderId));
    await tx.insert(commissionSubmissions).values({ id: submissionId, orderId: p.orderId, kind: "final", actorSessionId: p.creator.sessionId, requestId: randomUUID(), submittedAt: at });
    await tx.insert(commissionThreadEntries).values({ orderId: p.orderId, sequence: 1, kind: "submission", entryId: submissionId, createdAt: at });
    await tx.update(commissionFiles).set({ state: "attached", orderId: p.orderId, attachedAt: at, version: 4 }).where(eq(commissionFiles.id, fileId));
    await tx.insert(commissionFileAttachments).values({ fileId, orderId: p.orderId, targetKind: "submission", targetId: submissionId, position: 0, attachedAt: at });
    await tx.update(commissionOrders).set({ state: "delivered", deliveredAt: at, reviewEndsAt: new Date(at.getTime() + 7 * 86_400_000), version: 3, updatedAt: at }).where(eq(commissionOrders.id, p.orderId));
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 3, type: "delivered", requestId: randomUUID(), occurredAt: at });
  });
  return fileId;
}
async function complete(p: PaidOrder) {
  clock = new Date(clock.getTime() + 1_000); const at = clock;
  await fulfillmentFixture.db.transaction(async (tx) => {
    await tx.update(commissionOrders).set({ state: "completed", completedAt: at, completionKind: "buyer_accepted", version: 4, updatedAt: at }).where(eq(commissionOrders.id, p.orderId));
    await tx.update(commissionReservations).set({ state: "completed", releasedAt: at }).where(eq(commissionReservations.orderId, p.orderId));
    await tx.insert(commissionEvents).values({ id: randomUUID(), orderId: p.orderId, orderVersion: 4, type: "completed", requestId: randomUUID(), occurredAt: at });
  });
}
async function orderBytes(orderId: string) {
  const rows = await fulfillmentFixture.db.execute(sql`select commission_order_file_bytes(${orderId}::uuid) as bytes`);
  return Number(rows[0]!.bytes);
}
async function fillOrder(p: PaidOrder) {
  for (let i = 0; i < 5; i++) await orderFile(p, 209_715_200);
}

describe("fulfillment upload grants", () => {
  test("creator gets a 250 MiB submission grant on an in_progress order", async () => {
    const p = await paidOrder(); const s = service("enabled", "enabled", fulfillmentFixture.db);
    const grant = await s.files.createUpload(upload(p, "submission", p.creator, 262_144_000));
    const [row] = await fulfillmentFixture.db.select().from(commissionFiles).where(eq(commissionFiles.id, grant.fileId));
    expect(row).toMatchObject({ context: "submission", uploadOrderId: p.orderId, packageId: null, declaredBytes: 262_144_000 });
    expect(s.presignUpload.mock.calls[0]![0].contentLength).toBe(262_144_000);
  });
  test("buyer is refused a submission grant", async () => {
    const p = await paidOrder();
    await expect(service("enabled", "enabled", fulfillmentFixture.db).files.createUpload(upload(p, "submission", p.buyer))).rejects.toMatchObject({ code: "invalid_state" });
  });
  test("submission grant on a delivered order is refused", async () => {
    const p = await paidOrder(); await deliver(p);
    await expect(service("enabled", "enabled", fulfillmentFixture.db).files.createUpload(upload(p, "submission"))).rejects.toMatchObject({ code: "invalid_state" });
  });
  test.each(["in_progress", "delivered"] as const)("either party gets a thread grant while %s", async (state) => {
    const p = await paidOrder(); if (state === "delivered") await deliver(p);
    const s = service("enabled", "enabled", fulfillmentFixture.db);
    for (const actor of [p.buyer, p.creator]) {
      const grant = await s.files.createUpload(upload(p, "thread", actor));
      const [row] = await fulfillmentFixture.db.select().from(commissionFiles).where(eq(commissionFiles.id, grant.fileId));
      expect(row).toMatchObject({ context: "thread", uploadOrderId: p.orderId, packageId: null, ownerUserId: actor.userId });
    }
  });
  test("thread grant on a completed order is refused", async () => {
    const p = await paidOrder(); await deliver(p); await complete(p);
    const s = service("enabled", "enabled", fulfillmentFixture.db);
    for (const actor of [p.buyer, p.creator]) await expect(s.files.createUpload(upload(p, "thread", actor))).rejects.toMatchObject({ code: "invalid_state" });
  });
  test("a stranger and the owner account get not_available", async () => {
    const p = await paidOrder(); const stranger = await party(); const owner = await party();
    await fulfillmentFixture.db.insert(identityRoleGrants).values({ id: randomUUID(), userId: owner.userId, role: "owner", grantSource: "bootstrap_cli", grantedAt: clock, createdAt: clock, updatedAt: clock });
    const s = service("enabled", "enabled", fulfillmentFixture.db);
    for (const actor of [stranger, owner]) {
      sessions.set(actor.userId, actor.sessionId);
      for (const context of ["thread", "submission"] as const) await expect(s.files.createUpload(upload(p, context, actor))).rejects.toMatchObject({ code: "not_available" });
    }
  });
  test.each([["thread", 26_214_401], ["submission", 262_144_001]] as const)("%s grant over its size limit is file_too_large", async (context, bytes) => {
    const p = await paidOrder();
    await expect(service("enabled", "enabled", fulfillmentFixture.db).files.createUpload(upload(p, context, p.creator, bytes))).rejects.toMatchObject({ code: "file_too_large" });
  });
  test("fulfillment disabled refuses thread and submission grants but not brief grants", async () => {
    const p = await paidOrder(); const s = service("enabled", "disabled", fulfillmentFixture.db);
    const transaction = vi.spyOn(fulfillmentFixture.db, "transaction");
    try {
      for (const context of ["thread", "submission"] as const) await expect(s.files.createUpload(upload(p, context))).rejects.toMatchObject({ code: "fulfillment_disabled" });
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
    await expect(s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "Synthetic reference", declaredBytes: 16, ...ids() })).resolves.toHaveProperty("fileId");
  });
  test("order quota: the grant past 1 GiB is order_quota_exceeded", async () => {
    const p = await paidOrder(); await fillOrder(p); const s = service("enabled", "enabled", fulfillmentFixture.db);
    await expect(s.files.createUpload(upload(p, "submission", p.creator, 25_165_825))).rejects.toMatchObject({ code: "order_quota_exceeded" });
    expect(await orderBytes(p.orderId)).toBe(1_048_576_000);
    await s.files.createUpload(upload(p, "submission", p.creator, 25_165_824));
    expect(await orderBytes(p.orderId)).toBe(1_073_741_824);
  });
  test("two parallel grants for the last allowance: exactly one succeeds", async () => {
    const p = await paidOrder(); await fillOrder(p); const s = service("enabled", "enabled", fulfillmentFixture.db);
    const results = await Promise.allSettled([
      s.files.createUpload(upload(p, "thread", p.buyer, 20_000_000)),
      s.files.createUpload(upload(p, "submission", p.creator, 20_000_000)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1); expect(rejected[0]!.reason).toMatchObject({ code: "order_quota_exceeded" });
    expect(await orderBytes(p.orderId)).toBe(1_068_576_000);
  });
  test("fulfillment grants replay and bind the fingerprint to context and order", async () => {
    const p = await paidOrder(); const other = await paidOrder(); const s = service("enabled", "enabled", fulfillmentFixture.db);
    const command = upload(p, "thread", p.creator); const first = await s.files.createUpload(command);
    expect((await s.files.createUpload(command)).fileId).toBe(first.fileId);
    await expect(s.files.createUpload({ ...command, context: "submission" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(s.files.createUpload({ ...command, orderId: other.orderId })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  test("creator keeps download access on a completed order", async () => {
    const p = await paidOrder(); const fileId = await deliver(p); await complete(p);
    const s = service("enabled", "disabled", fulfillmentFixture.db);
    await s.files.downloadGrant({ actor: p.creator, orderId: p.orderId, fileId, disposition: "attachment" });
    expect(s.presignDownload).toHaveBeenCalledTimes(1);
  });
});

describe("commission file service", () => {
  test("brief replays recorded before this change still replay", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const command = { actor: p.buyer, context: "brief" as const, packageId: p.packageId, fileName: "Synthetic reference", declaredBytes: 16, ...ids() };
    const fileId = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, state: "awaiting_upload" });
    await fixture.db.insert(systemCommandIdempotency).values({ actorUserId: p.buyerUserId, commandScope: "commission-files.upload", status: "completed", resultReference: fileId,
      keyHash: createLookupHmac({ key: fixtureLookupKey, context: "commission-file-command-key", value: command.idempotencyKey }),
      requestFingerprint: createLookupHmac({ key: fixtureLookupKey, context: "commission-file-command", value: JSON.stringify([p.packageId, normalizeCommissionFileName(command.fileName), command.declaredBytes]) }),
      createdAt: clock, completedAt: clock, expiresAt: new Date(clock.getTime() + 900_000) });
    expect((await s.files.createUpload(command)).fileId).toBe(fileId);
  });
  test.each(["rejected", "scan_failed", "expired", "discarded"] as const)("status reads return no filename for %s", async (state) => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const fileId = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, state: state === "expired" ? "awaiting_upload" : "scanning" });
    const row = await fixture.read(fileId);
    if (state === "discarded") await s.files.discard({ actor: p.buyer, fileId });
    else await fixture.db.update(commissionFiles).set({ state, endedAt: clock, version: row.version + 1,
      ...(state === "rejected" ? { rejectionReason: "size_mismatch" } : {}) }).where(eq(commissionFiles.id, fileId));
    expect(await fixture.read(fileId)).toMatchObject({ filenameEnvelope: null });
    await expect(s.files.getFile({ actor: p.buyer, fileId })).resolves.toMatchObject({ name: null, state });
  });
  test("issues an exact-size grant, stores the name encrypted and replays the same file", async () => {
    clock = fixtureAt; const p = await participants(); const s = service(); const command = { actor: p.buyer, context: "brief" as const, packageId: p.packageId, fileName: "mẫu nhân vật.png", declaredBytes: 1234, ...ids() };
    const first = await s.files.createUpload(command);
    expect(s.presignUpload).toHaveBeenCalledWith({ key: `commission/${first.fileId}`, contentLength: 1234, expiresInSeconds: 900 });
    const row = await fixture.read(first.fileId);
    expect(row).toMatchObject({ state: "awaiting_upload", declaredBytes: 1234, ownerUserId: p.buyer.userId, uploadExpiresAt: new Date(fixtureAt.getTime() + 900_000) });
    expect(JSON.stringify(row.filenameEnvelope)).not.toContain("nhân");
    expect((await s.files.createUpload(command)).fileId).toBe(first.fileId);
    expect(await fixture.db.select().from(commissionFiles).where(eq(commissionFiles.ownerUserId, p.buyer.userId))).toHaveLength(1);
  });
  test.each([[26_214_401, "file_too_large"], [0, "invalid_request"], [1.5, "invalid_request"]] as const)("refuses %s bytes with %s", async (declaredBytes, code) => {
    const p = await participants();
    await expect(service().files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes, ...ids() })).rejects.toMatchObject({ code });
  });
  test("enforces the 10 unsent references limit and frees a slot on discard", async () => {
    clock = fixtureAt; const p = await participants(); const s = service(); const created: string[] = [];
    for (let index = 0; index < 10; index += 1) created.push((await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: `r${index}.png`, declaredBytes: 10, ...ids() })).fileId);
    await expect(s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "r10.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "pending_limit" });
    await expect(s.files.discard({ actor: p.buyer, fileId: created[0]! })).resolves.toMatchObject({ state: "discarded" });
    await expect(s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "r10.png", declaredBytes: 10, ...ids() })).resolves.toMatchObject({ fileId: expect.any(String) });
  });
  test("refuses disabled mode, a stale session and a creator uploading to their own package", async () => {
    const p = await participants(); const disabled = service("disabled"); const transaction = vi.spyOn(fixture.db, "transaction");
    await expect(disabled.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "files_disabled" });
    expect(transaction).not.toHaveBeenCalled(); transaction.mockRestore();
    await expect(service().files.createUpload({ actor: { ...p.buyer, sessionId: "revoked-session" }, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(service().files.createUpload({ actor: p.creator, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() })).rejects.toMatchObject({ code: "not_available" });
  });
  test("completes once, emits one minimal event and expires stale grants", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const { fileId } = await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "a.png", declaredBytes: 10, ...ids() });
    clock = new Date(fixtureAt.getTime() + 60_000);
    await expect(s.files.completeUpload({ actor: p.buyer, fileId, requestId: "req-complete-1" })).resolves.toMatchObject({ state: "scanning", name: "a.png" });
    await expect(s.files.completeUpload({ actor: p.buyer, fileId, requestId: "req-complete-2" })).resolves.toMatchObject({ state: "scanning" });
    const events = await fixture.db.select().from(systemOutbox).where(and(eq(systemOutbox.aggregateId, fileId), eq(systemOutbox.eventType, "commission.file_uploaded.v1")));
    expect(events.map((event) => event.payload)).toEqual([{ fileId, correlationId: "req-complete-1" }]);
    const late = await s.files.createUpload({ actor: p.buyer, context: "brief", packageId: p.packageId, fileName: "b.png", declaredBytes: 10, ...ids() });
    clock = new Date(clock.getTime() + 900_000);
    await expect(s.files.completeUpload({ actor: p.buyer, fileId: late.fileId, requestId: "req-late" })).rejects.toMatchObject({ code: "upload_expired" });
    await expect(s.files.completeUpload({ actor: p.creator, fileId, requestId: "req-other" })).rejects.toMatchObject({ code: "not_available" });
  });
  test("grants downloads to both parties with a safe disposition", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const png = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, name: 'ảnh "mẫu".png' });
    await fixture.attach(png, p.orderId, 0);
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: png, disposition: "inline" })).resolves.toMatchObject({ url: expect.stringContaining("signed=1") });
    expect(s.presignDownload).toHaveBeenLastCalledWith(expect.objectContaining({ key: `commission/${png}`, versionId: "c-fixture", contentType: "image/png", expiresInSeconds: 300,
      contentDisposition: expect.stringMatching(/^inline; filename="[^"]*"; filename\*=UTF-8''/u) }));
    await expect(s.files.downloadGrant({ actor: p.creator, orderId: p.orderId, fileId: png, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
  });
  test("refuses strangers, unattached files and inline PDFs", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const loose = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId });
    const pdf = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId, name: "brief.pdf", detectedType: "pdf" });
    await fixture.attach(pdf, p.orderId, 0);
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: loose, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: pdf, disposition: "inline" })).rejects.toMatchObject({ code: "preview_not_allowed" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId: pdf, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
    const stranger = await participants();
    await expect(s.files.downloadGrant({ actor: stranger.buyer, orderId: p.orderId, fileId: pdf, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
  });
  test("removes the creator's access when the request closes before payment", async () => {
    clock = fixtureAt; const p = await participants(); const s = service();
    const fileId = await fixture.file({ ownerUserId: p.buyerUserId, packageId: p.packageId });
    await fixture.attach(fileId, p.orderId, 0);
    await fixture.closeOrder(p.orderId, p.buyerUserId);
    await expect(s.files.downloadGrant({ actor: p.creator, orderId: p.orderId, fileId, disposition: "attachment" })).rejects.toMatchObject({ code: "not_available" });
    await expect(s.files.downloadGrant({ actor: p.buyer, orderId: p.orderId, fileId, disposition: "attachment" })).resolves.toMatchObject({ url: expect.any(String) });
  });
});
